import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { createDb, migrate } from "./db/client.ts";
import { DueApp } from "./app/services.ts";
import { AppError } from "./app/errors.ts";
import { originAllowed } from "./security/csrf.ts";
import { formatMinor } from "./domain/money.ts";
import { createMessagingProvider } from "./messaging/factory.ts";

const config = loadConfig();
const { db, sql } = await createDb();
await migrate(sql);
const app = new DueApp(db);

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(";")) {
    const [k, ...r] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(r.join("="));
  }
  return out;
}

async function readBody(req: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} · DUE</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#0b1220;color:#e8eefc}
a{color:#8ab4ff}.wrap{max-width:720px;margin:0 auto;padding:1rem}
.card{background:#151d2e;border-radius:12px;padding:1rem;margin:1rem 0}
.row{display:flex;justify-content:space-between;gap:1rem;margin:.4rem 0}
input,button,select{font:inherit;padding:.5rem;border-radius:8px;border:1px solid #334}
button{background:#3b82f6;color:#fff;border:0;cursor:pointer}
.quiet{color:#9bb;font-size:.9rem}
.stat{font-size:1.4rem;font-weight:700}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const method = req.method || "GET";
    const cookies = parseCookies(req.headers.cookie);
    const user = await app.userFromToken(cookies.due_session);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (method === "POST" && config.csrfRequireOrigin) {
      const ok = originAllowed(req.headers.host || "", req.headers.origin, req.headers.referer, true);
      if (!ok) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("CSRF blocked");
        return;
      }
    }

    if (url.pathname === "/signup" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(layout("Sign up", `<h1>DUE</h1><p class="quiet">Stop chasing customers for money.</p>
        <form method="post" action="/signup" class="card">
          <label>Email<br/><input name="email" type="email" required/></label><br/><br/>
          <label>Password<br/><input name="password" type="password" minlength="8" required/></label><br/><br/>
          <button type="submit">Create account</button>
        </form><p class="quiet"><a href="/login">Log in</a></p>`));
      return;
    }
    if (url.pathname === "/signup" && method === "POST") {
      const body = await readBody(req);
      const session = await app.register({ email: body.get("email") || "", password: body.get("password") || "" });
      res.writeHead(302, {
        Location: "/onboarding",
        "Set-Cookie": `due_session=${session.token}; Path=/; HttpOnly; SameSite=Lax${config.secureCookies ? "; Secure" : ""}`,
      });
      res.end();
      return;
    }
    if (url.pathname === "/login" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(layout("Log in", `<h1>Log in</h1><form method="post" action="/login" class="card">
        <label>Email<br/><input name="email" type="email" required/></label><br/><br/>
        <label>Password<br/><input name="password" type="password" required/></label><br/><br/>
        <button type="submit">Log in</button></form>`));
      return;
    }
    if (url.pathname === "/login" && method === "POST") {
      const body = await readBody(req);
      const session = await app.login({ email: body.get("email") || "", password: body.get("password") || "" });
      res.writeHead(302, {
        Location: "/dashboard",
        "Set-Cookie": `due_session=${session.token}; Path=/; HttpOnly; SameSite=Lax${config.secureCookies ? "; Secure" : ""}`,
      });
      res.end();
      return;
    }

    if (!user && url.pathname !== "/") {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(302, { Location: user ? "/dashboard" : "/signup" });
      res.end();
      return;
    }

    if (url.pathname === "/onboarding" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(layout("Business", `<h1>Create your business</h1>
        <form method="post" action="/onboarding" class="card">
          <label>Name<br/><input name="name" required/></label><br/><br/>
          <label>Email<br/><input name="email" type="email" value="${escapeHtml(user!.email)}" required/></label><br/><br/>
          <label>Phone<br/><input name="phone"/></label><br/><br/>
          <button type="submit">Continue</button>
        </form>`));
      return;
    }
    if (url.pathname === "/onboarding" && method === "POST") {
      const body = await readBody(req);
      const biz = await app.createBusiness(user!.id, {
        name: body.get("name") || "",
        email: body.get("email") || user!.email,
        phone: body.get("phone") || undefined,
      });
      res.writeHead(302, { Location: `/b/${biz.id}` });
      res.end();
      return;
    }

    const bMatch = url.pathname.match(/^\/b\/([^/]+)(.*)$/);
    if (bMatch) {
      const businessId = bMatch[1];
      const rest = bMatch[2] || "";
      if (rest === "" || rest === "/") {
        const dash = await app.dashboard(user!.id, businessId);
        const recs = await app.listReceivables(user!.id, businessId);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(layout("Dashboard", `
          <p class="quiet"><a href="/dashboard">Businesses</a></p>
          <h1>Dashboard</h1>
          <div class="card">
            <div class="row"><span>Total outstanding</span><span class="stat">${escapeHtml(formatMinor(dash.totalOutstanding))}</span></div>
            <div class="row"><span>Overdue</span><span>${escapeHtml(formatMinor(dash.overdue))}</span></div>
            <div class="row"><span>Due today</span><span>${escapeHtml(formatMinor(dash.dueToday))}</span></div>
            <div class="row"><span>Upcoming</span><span>${escapeHtml(formatMinor(dash.upcoming))}</span></div>
            <div class="row"><span>Paid this month</span><span>${escapeHtml(formatMinor(dash.paidThisMonth))}</span></div>
          </div>
          <p><a href="/b/${businessId}/customers/new">+ Customer</a> · <a href="/b/${businessId}/receivables/new">+ Receivable</a></p>
          <div class="card"><h2>Receivables</h2>
            <ul>${recs.map((r) => `<li><a href="/b/${businessId}/receivables/${r.id}">${escapeHtml(r.description)}</a> · ${escapeHtml(formatMinor(r.outstandingMinor))} · ${escapeHtml(r.aging)}</li>`).join("") || "<li class='quiet'>None yet</li>"}</ul>
          </div>`));
        return;
      }
      if (rest === "/customers/new" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(layout("New customer", `<h1>New customer</h1>
          <form method="post" class="card">
            <label>Name<br/><input name="name" required/></label><br/><br/>
            <label>Email<br/><input name="email" type="email"/></label><br/><br/>
            <label>Phone<br/><input name="phone"/></label><br/><br/>
            <button type="submit">Save</button>
          </form>`));
        return;
      }
      if (rest === "/customers/new" && method === "POST") {
        const body = await readBody(req);
        await app.createCustomer(user!.id, businessId, {
          name: body.get("name") || "",
          email: body.get("email") || undefined,
          phone: body.get("phone") || undefined,
        });
        res.writeHead(302, { Location: `/b/${businessId}` });
        res.end();
        return;
      }
      if (rest === "/receivables/new" && method === "GET") {
        const customers = await app.listCustomers(user!.id, businessId);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(layout("New receivable", `<h1>New receivable</h1>
          <form method="post" class="card">
            <label>Customer<br/><select name="customerId" required>${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select></label><br/><br/>
            <label>Description<br/><input name="description" required/></label><br/><br/>
            <label>Amount (NGN)<br/><input name="amountMajor" required placeholder="500000"/></label><br/><br/>
            <label>Due on<br/><input name="dueOn" type="date" required/></label><br/><br/>
            <button type="submit">Create</button>
          </form>`));
        return;
      }
      if (rest === "/receivables/new" && method === "POST") {
        const body = await readBody(req);
        const r = await app.createReceivable(user!.id, businessId, {
          customerId: body.get("customerId") || "",
          description: body.get("description") || "",
          amountMajor: body.get("amountMajor") || "",
          dueOn: body.get("dueOn") || "",
          idempotencyKey: `ui-${Date.now()}`,
        });
        res.writeHead(302, { Location: `/b/${businessId}/receivables/${r.id}` });
        res.end();
        return;
      }
      const rMatch = rest.match(/^\/receivables\/([^/]+)$/);
      if (rMatch && method === "GET") {
        const r = await app.getReceivable(user!.id, businessId, rMatch[1]);
        const rems = await app.listReminders(user!.id, businessId, r.id);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(layout(r.description, `
          <p class="quiet"><a href="/b/${businessId}">Dashboard</a></p>
          <h1>${escapeHtml(r.description)}</h1>
          <div class="card">
            <div class="row"><span>Outstanding</span><strong>${escapeHtml(formatMinor(r.outstandingMinor))}</strong></div>
            <div class="row"><span>Due</span><span>${escapeHtml(r.dueOn)}</span></div>
            <div class="row"><span>Aging</span><span>${escapeHtml(r.aging)}</span></div>
            <div class="row"><span>Status</span><span>${r.cancelledAt ? "cancelled" : r.outstandingMinor <= 0n ? "paid" : "open"}</span></div>
          </div>
          ${!r.cancelledAt && r.outstandingMinor > 0n ? `
          <form method="post" action="/b/${businessId}/receivables/${r.id}/pay" class="card">
            <h2>Record payment</h2>
            <label>Amount<br/><input name="amountMajor" required/></label><br/><br/>
            <label>Paid on<br/><input name="paidOn" type="date" required/></label><br/><br/>
            <button type="submit">Record</button>
          </form>
          <form method="post" action="/b/${businessId}/receivables/${r.id}/cancel" class="card" onsubmit="return confirm('Cancel remaining balance?')">
            <button type="submit">Cancel receivable</button>
          </form>` : ""}
          <div class="card">
            <h2>Reminders</h2>
            <p class="quiet">Channels: DEMO or EMAIL. Provider accepted ≠ delivered.</p>
            <ul>${rems.map((n) => `<li>${escapeHtml(n.scheduleKey)} · ${escapeHtml(n.channel)} · ${escapeHtml(n.status)} · ${escapeHtml(n.scheduledFor.toISOString())}</li>`).join("") || "<li>None</li>"}</ul>
          </div>`));
        return;
      }
      const payMatch = rest.match(/^\/receivables\/([^/]+)\/pay$/);
      if (payMatch && method === "POST") {
        const body = await readBody(req);
        await app.recordPayment(user!.id, businessId, {
          receivableId: payMatch[1],
          amountMajor: body.get("amountMajor") || "",
          paidOn: body.get("paidOn") || "",
          method: "manual",
          idempotencyKey: `pay-${Date.now()}`,
        });
        res.writeHead(302, { Location: `/b/${businessId}/receivables/${payMatch[1]}` });
        res.end();
        return;
      }
      const cancelMatch = rest.match(/^\/receivables\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        await app.cancelReceivable(user!.id, businessId, cancelMatch[1]);
        res.writeHead(302, { Location: `/b/${businessId}/receivables/${cancelMatch[1]}` });
        res.end();
        return;
      }
    }

    if (url.pathname === "/dashboard") {
      const list = await app.listBusinesses(user!.id);
      if (list.length === 1) {
        res.writeHead(302, { Location: `/b/${list[0].id}` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(layout("Businesses", `<h1>Your businesses</h1>
        <ul>${list.map((b) => `<li><a href="/b/${b.id}">${escapeHtml(b.name)}</a></li>`).join("") || "<li>None — <a href='/onboarding'>create one</a></li>"}</ul>`));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    if (err instanceof AppError) {
      res.writeHead(err.status, { "Content-Type": "text/plain" });
      res.end(`${err.code}: ${err.message}`);
      return;
    }
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal error");
  }
});

server.listen(config.port, () => {
  console.log(`DUE listening on :${config.port} provider=${createMessagingProvider().name} db=auto`);
});
