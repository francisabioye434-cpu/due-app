import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, createDb, migrate, resetData } from "../src/db/client.ts";
import { DueApp } from "../src/app/services.ts";
import { AppError } from "../src/app/errors.ts";
import { ReminderWorker } from "../src/reminders/worker.ts";
import { ResendEmailProvider } from "../src/messaging/resend.ts";
import { customers } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";

let shared: Awaited<ReturnType<typeof createDb>> | null = null;

async function fresh(now = new Date("2026-09-07T12:00:00Z")) {
  if (!shared) {
    shared = await createDb();
    await migrate(shared.sql);
  }
  await resetData(shared.sql);
  return { db: shared.db, sql: shared.sql, app: new DueApp(shared.db, { now: () => now }) };
}

after(async () => {
  if (shared) await closeDb(shared.sql);
});

test("email provider contract and missing destination", async () => {
  const provider = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async () => ({ status: 200, body: { id: "re_1" } }),
  });
  const ok = await provider.send({
    businessId: "b",
    reminderId: "r",
    receivableId: "v",
    channel: "email",
    destination: "kemi@example.com",
    subject: "Hi",
    body: "Body",
    scheduledFor: new Date(),
    idempotencyKey: "due-attempt-1",
    metadata: {},
  });
  assert.equal(ok.ok, true);

  const { app, db, sql } = await fresh();
  const s = await app.register({ email: "o@ex.com", password: "password1" });
  const b = await app.createBusiness(s.userId, { name: "B", email: "b@x.com", phone: "1" });
  const c = await app.createCustomer(s.userId, b.id, { name: "Kemi" });
  await app.createReceivable(s.userId, b.id, {
    customerId: c.id,
    description: "W",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "m1",
  });
  let called = 0;
  const p = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async () => {
      called++;
      return { status: 200, body: { id: "x" } };
    },
  });
  const out = await new ReminderWorker(db, sql, p, { now: () => new Date("2026-09-07T12:00:00Z") }).run({
    businessId: b.id,
  });
  assert.equal(called, 0);
  assert.equal(out.failed, 1);
});

test("balance at send, permanent vs retriable, snapshot, isolation", async () => {
  const { app, db, sql } = await fresh();
  const s = await app.register({ email: "e@ex.com", password: "password1" });
  const b = await app.createBusiness(s.userId, { name: "Ada", email: "a@x.com", phone: "1" });
  const c = await app.createCustomer(s.userId, b.id, { name: "Kemi", email: "old@example.com" });
  const r = await app.createReceivable(s.userId, b.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "500000",
    dueOn: "2026-08-01",
    idempotencyKey: "bal",
  });
  await app.recordPayment(s.userId, b.id, {
    receivableId: r.id,
    amountMajor: "200000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "bp",
  });
  const bodies: string[] = [];
  const p = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async ({ payload }) => {
      bodies.push(String(payload.text));
      return { status: 200, body: { id: "re_bal" } };
    },
  });
  await new ReminderWorker(db, sql, p, { now: () => new Date("2026-09-07T12:00:00Z") }).run({ businessId: b.id });
  assert.match(bodies[0]!, /300,000/);
  await db.update(customers).set({ email: "new@example.com" }).where(eq(customers.id, c.id));
  const rem = (await app.listReminders(s.userId, b.id, r.id)).find((x) => x.status === "sent")!;
  const { attempts } = await app.getReminder(s.userId, b.id, rem.id);
  assert.equal(attempts[0]!.destination, "old@example.com");

  const r2 = await app.createReceivable(s.userId, b.id, {
    customerId: c.id,
    description: "P",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "perm",
  });
  let n = 0;
  const bad = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async () => {
      n++;
      return { status: 403, body: { message: "sender" } };
    },
  });
  const w = new ReminderWorker(db, sql, bad, { now: () => new Date("2026-09-07T12:00:00Z") }, { retryDelayMs: 0 });
  await w.run({ businessId: b.id });
  await w.run({ businessId: b.id });
  assert.equal(n, 1);
  void r2;

  const other = await app.register({ email: "z@ex.com", password: "password1" });
  const ob = await app.createBusiness(other.userId, { name: "O", email: "o@x.com", phone: "1" });
  await assert.rejects(() => app.getReminder(other.userId, ob.id, rem.id), (e: unknown) => e instanceof AppError);
});
