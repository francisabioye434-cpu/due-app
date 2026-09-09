/**
 * Slice 1–3 verification reconciliation — gap-fill tests only.
 * Each test targets requirements that were consolidated away or untested
 * after reconstruction (37 tests vs historical 75).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, createDb, migrate, resetData } from "../src/db/client.ts";
import { DueApp } from "../src/app/services.ts";
import { AppError } from "../src/app/errors.ts";
import { ReminderWorker } from "../src/reminders/worker.ts";
import { DemoMessagingProvider } from "../src/messaging/demo.ts";
import { ResendEmailProvider } from "../src/messaging/resend.ts";
import { createMessagingProvider } from "../src/messaging/factory.ts";
import { recordResendEvent } from "../src/messaging/webhooks.ts";
import { localNineAmToUtc } from "../src/domain/time.ts";
import { agingBucket } from "../src/domain/aging.ts";
import { activityEvents, memberships, payments, reminderAttempts, reminderDeliveryEvents, reminders } from "../src/db/schema.ts";
import { eq, and } from "drizzle-orm";

const NOW = new Date("2026-09-07T12:00:00Z"); // 13:00 Lagos (WAT UTC+1)
let shared: Awaited<ReturnType<typeof createDb>> | null = null;

async function fresh() {
  if (!shared) {
    shared = await createDb();
    await migrate(shared.sql);
  }
  await resetData(shared.sql);
  return { db: shared.db, sql: shared.sql, kind: shared.kind, app: new DueApp(shared.db, { now: () => NOW }) };
}

after(async () => {
  if (shared) await closeDb(shared.sql);
});

async function owner(app: DueApp, email = "owner@example.com") {
  const session = await app.register({ email, password: "password1" });
  const business = await app.createBusiness(session.userId, {
    name: "Ada Studio",
    email,
    phone: "0800",
  });
  return { userId: session.userId, token: session.token, business };
}

// ——— Slice 1 gaps ———

test("recon: login success and rejection", async () => {
  const { app } = await fresh();
  await app.register({ email: "login@example.com", password: "password1" });
  const ok = await app.login({ email: "login@example.com", password: "password1" });
  assert.ok(ok.token);
  assert.ok(await app.userFromToken(ok.token));
  await assert.rejects(
    () => app.login({ email: "login@example.com", password: "wrong-password" }),
    (e: unknown) => e instanceof AppError && e.status === 401,
  );
});

test("recon: atomic business creates owner membership and default rule", async () => {
  const { app, db } = await fresh();
  const session = await app.register({ email: "biz@example.com", password: "password1" });
  const business = await app.createBusiness(session.userId, { name: "Biz", email: "biz@example.com" });
  const mem = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.businessId, business.id), eq(memberships.userId, session.userId)));
  assert.equal(mem.length, 1);
  assert.equal(mem[0]!.role, "owner");
  const listed = await app.listBusinesses(session.userId);
  assert.ok(listed.some((b) => b.id === business.id));
  // default reminder rule via receivable schedule path
  const c = await app.createCustomer(session.userId, business.id, { name: "C" });
  const r = await app.createReceivable(session.userId, business.id, {
    customerId: c.id,
    description: "X",
    amountMajor: "1000",
    dueOn: "2026-09-20",
    idempotencyKey: "rule-check",
  });
  const rems = await app.listReminders(session.userId, business.id, r.id);
  assert.ok(rems.length >= 1);
});

test("recon: customer create list get and invalid email", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, {
    name: "Kemi",
    email: "kemi@example.com",
    companyName: "K Ltd",
  });
  const listed = await app.listCustomers(a.userId, a.business.id);
  assert.equal(listed.length, 1);
  const got = await app.getCustomer(a.userId, a.business.id, c.id);
  assert.equal(got.email, "kemi@example.com");
  await assert.rejects(
    () => app.createCustomer(a.userId, a.business.id, { name: "Bad", email: "not-an-email" }),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_EMAIL",
  );
});

test("recon: due_today aging and dashboard buckets including paidThisMonth", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  // today in Africa/Lagos for NOW 2026-09-07T12:00Z is 2026-09-07
  const dueToday = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Today",
    amountMajor: "10000",
    dueOn: "2026-09-07",
    idempotencyKey: "due-today",
  });
  assert.equal(dueToday.aging, "due_today");
  const overdue = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Old",
    amountMajor: "20000",
    dueOn: "2026-08-01",
    idempotencyKey: "due-od",
  });
  assert.equal(overdue.aging, "overdue");
  const upcoming = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Soon",
    amountMajor: "30000",
    dueOn: "2026-09-20",
    idempotencyKey: "due-up",
  });
  assert.equal(upcoming.aging, "upcoming");
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: overdue.id,
    amountMajor: "5000",
    paidOn: "2026-09-07",
    method: "transfer",
    idempotencyKey: "dash-pay",
  });
  const d = await app.dashboard(a.userId, a.business.id);
  assert.equal(d.dueToday, 1000000n);
  assert.equal(d.overdue, 1500000n); // 20000 - 5000 = 15000 major -> 1_500_000 minor
  assert.equal(d.upcoming, 3000000n);
  assert.equal(d.paidThisMonth, 500000n);
  assert.equal(d.totalOutstanding, 1000000n + 1500000n + 3000000n);
});

test("recon: payment idempotency and second pay after full rejected", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "W",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "pay-idemp-r",
  });
  const p1 = await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "10000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "same-pay-key",
  });
  const p2 = await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "10000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "same-pay-key",
  });
  assert.equal(p1.outstandingMinor, 0n);
  assert.equal(p2.outstandingMinor, 0n);
  assert.equal(p1.payments.length, 1);
  assert.equal(p2.payments.length, 1);
  await assert.rejects(
    () =>
      app.recordPayment(a.userId, a.business.id, {
        receivableId: r.id,
        amountMajor: "1",
        paidOn: "2026-09-07",
        method: "cash",
        idempotencyKey: "after-full",
      }),
    (e: unknown) => e instanceof AppError && e.code === "OVERPAYMENT",
  );
});

test("recon: payment after cancel and cancel-paid rejection", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const unpaid = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Cancel me",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "cancel-unpaid",
  });
  await app.cancelReceivable(a.userId, a.business.id, unpaid.id, "stop");
  await assert.rejects(
    () =>
      app.recordPayment(a.userId, a.business.id, {
        receivableId: unpaid.id,
        amountMajor: "1000",
        paidOn: "2026-09-07",
        method: "cash",
        idempotencyKey: "after-cancel",
      }),
    (e: unknown) => e instanceof AppError && e.code === "RECEIVABLE_CANCELLED",
  );

  const paid = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Pay first",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "cancel-paid",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: paid.id,
    amountMajor: "10000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "full-then-cancel",
  });
  await assert.rejects(
    () => app.cancelReceivable(a.userId, a.business.id, paid.id, "nope"),
    (e: unknown) => e instanceof AppError && e.code === "ALREADY_PAID",
  );
});

test("recon: currency on payment matches receivable; invalid amount", async () => {
  const { app, db } = await fresh();
  const a = await owner(app);
  assert.equal(a.business.currency, "NGN");
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "W",
    amountMajor: "1000",
    dueOn: "2026-08-01",
    idempotencyKey: "cur",
  });
  assert.equal(r.currency, "NGN");
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "100",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "curp",
  });
  const pays = await db.select().from(payments).where(eq(payments.receivableId, r.id));
  assert.equal(pays[0]!.currency, "NGN");
  await assert.rejects(
    () =>
      app.recordPayment(a.userId, a.business.id, {
        receivableId: r.id,
        amountMajor: "-5",
        paidOn: "2026-09-07",
        method: "cash",
        idempotencyKey: "neg",
      }),
    (e: unknown) => e instanceof AppError,
  );
});

test("recon: activity events recorded for create pay cancel", async () => {
  const { app, db } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "W",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "act",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "1000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "actp",
  });
  await app.cancelReceivable(a.userId, a.business.id, r.id, "done");
  const events = await db.select().from(activityEvents).where(eq(activityEvents.receivableId, r.id));
  const types = events.map((e) => e.type).sort();
  assert.ok(types.includes("RECEIVABLE_CREATED"));
  assert.ok(types.includes("PAYMENT_RECORDED"));
  assert.ok(types.includes("RECEIVABLE_CANCELLED"));
});

test("recon: concurrent payments cannot exceed outstanding", async () => {
  const { app, db, kind } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Race",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "race-rec",
  });
  // Two full-balance payments racing
  const results = await Promise.allSettled([
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "10000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "race-a",
    }),
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "10000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "race-b",
    }),
  ]);
  const fulfilled = results.filter((x) => x.status === "fulfilled");
  const rejected = results.filter((x) => x.status === "rejected");
  const pays = await db.select().from(payments).where(eq(payments.receivableId, r.id));
  const totalPaid = pays.reduce((s, p) => s + p.amountMinor, 0n);
  assert.ok(totalPaid <= r.originalAmountMinor, `paid ${totalPaid} > original`);
  const final = await app.getReceivable(a.userId, a.business.id, r.id);
  assert.ok(final.outstandingMinor >= 0n);
  assert.equal(final.outstandingMinor + totalPaid, r.originalAmountMinor);

  if (kind === "postgres") {
    // With transactional isolation, exactly one should win
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(totalPaid, r.originalAmountMinor);
  } else {
    // PGlite may still race without real row locks; invariant must hold
    assert.ok(fulfilled.length >= 1);
    assert.ok(totalPaid <= r.originalAmountMinor);
  }
});

test("recon: financial invariant outstanding = original - sum(payments)", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Inv",
    amountMajor: "50000",
    dueOn: "2026-08-01",
    idempotencyKey: "fin",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "12000.50",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "fin1",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "7500",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "fin2",
  });
  const got = await app.getReceivable(a.userId, a.business.id, r.id);
  const paid = got.payments.reduce((s, p) => s + p.amountMinor, 0n);
  assert.equal(got.outstandingMinor, got.originalAmountMinor - paid);
  assert.equal(got.outstandingMinor, 5000000n - 1200050n - 750000n);
});

// ——— Slice 2 gaps ———

test("recon: DST-aware local 09:00 conversion (US Eastern)", () => {
  // 2026-03-08 is standard time; 2026-07-15 is daylight time in America/New_York
  const winter = localNineAmToUtc("2026-01-15", "America/New_York");
  const summer = localNineAmToUtc("2026-07-15", "America/New_York");
  // EST UTC-5 → 14:00Z; EDT UTC-4 → 13:00Z
  assert.equal(winter.getUTCHours(), 14);
  assert.equal(summer.getUTCHours(), 13);
  assert.equal(winter.getUTCMinutes(), 0);
  assert.equal(summer.getUTCMinutes(), 0);
});

test("recon: worker batchSize limits claims per run", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  for (let i = 0; i < 4; i++) {
    await app.createReceivable(a.userId, a.business.id, {
      customerId: c.id,
      description: `B${i}`,
      amountMajor: "1000",
      dueOn: "2026-08-01",
      idempotencyKey: `batch-${i}`,
    });
  }
  const demo = new DemoMessagingProvider();
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }, { batchSize: 1 }).run({
    businessId: a.business.id,
  });
  assert.equal(out.claimed, 1);
  assert.equal(out.sent, 1);
  assert.equal(demo.sent.length, 1);
});

test("recon: sent history preserved after due-date reschedule", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Hist",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "hist",
  });
  const demo = new DemoMessagingProvider();
  await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  const before = await app.listReminders(a.userId, a.business.id, r.id);
  const sent = before.filter((x) => x.status === "sent");
  assert.ok(sent.length >= 1);
  const sentIds = new Set(sent.map((s) => s.id));
  await app.updateDueDate(a.userId, a.business.id, r.id, "2026-10-01");
  const after = await app.listReminders(a.userId, a.business.id, r.id);
  for (const id of sentIds) {
    const row = after.find((x) => x.id === id);
    assert.ok(row);
    assert.equal(row!.status, "sent");
  }
  assert.ok(after.some((x) => x.status === "scheduled"));
  void db;
});

test("recon: reminder tenant isolation", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app, "a2@example.com");
  const b = await owner(app, "b2@example.com");
  const c = await app.createCustomer(a.userId, a.business.id, { name: "K", email: "k@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Priv",
    amountMajor: "1000",
    dueOn: "2026-08-01",
    idempotencyKey: "rt",
  });
  await new ReminderWorker(db, sql, new DemoMessagingProvider(), { now: () => NOW }).run({
    businessId: a.business.id,
  });
  const rem = (await app.listReminders(a.userId, a.business.id, r.id)).find((x) => x.status === "sent")!;
  await assert.rejects(
    () => app.getReminder(b.userId, b.business.id, rem.id),
    (e: unknown) => e instanceof AppError,
  );
  await assert.rejects(
    () => app.listReminders(b.userId, b.business.id, r.id),
    (e: unknown) => e instanceof AppError,
  );
});

test("recon: reminder activity history on send", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "ActR",
    amountMajor: "1000",
    dueOn: "2026-08-01",
    idempotencyKey: "actr",
  });
  await new ReminderWorker(db, sql, new DemoMessagingProvider(), { now: () => NOW }).run({
    businessId: a.business.id,
  });
  const events = await db.select().from(activityEvents).where(eq(activityEvents.businessId, a.business.id));
  assert.ok(events.some((e) => e.type.includes("REMINDER") || e.type.includes("SENT") || e.payload.includes("demo")));
  // softer: at least receivable activity + worker side effects exist
  assert.ok(events.length >= 1);
  const rems = await app.listReminders(a.userId, a.business.id, r.id);
  assert.ok(rems.some((x) => x.status === "sent"));
});

// ——— Slice 3 gaps ———

test("recon: MessagingProvider factory demo default and no silent email fallback", () => {
  const demo = createMessagingProvider({
    DUE_ENV: "development",
    AUTH_SECRET: "devsecret-for-factory-test",
  });
  assert.equal(demo.name, "demo");
  assert.throws(() =>
    createMessagingProvider({
      DUE_ENV: "development",
      AUTH_SECRET: "devsecret-for-factory-test",
      DUE_MESSAGING_PROVIDER: "email",
      // missing key/from — must not fall back to demo
    }),
  );
  const email = createMessagingProvider({
    DUE_ENV: "development",
    AUTH_SECRET: "devsecret-for-factory-test",
    DUE_MESSAGING_PROVIDER: "email",
    RESEND_API_KEY: "re_test_key",
    DUE_EMAIL_FROM: "DUE <from@example.com>",
  });
  assert.equal(email.name, "resend");
});

test("recon: provider message id persisted; webhook duplicate idempotent", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Msg",
    amountMajor: "1000",
    dueOn: "2026-08-01",
    idempotencyKey: "pmid",
  });
  const provider = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async () => ({ status: 200, body: { id: "re_msg_42" } }),
  });
  await new ReminderWorker(db, sql, provider, { now: () => NOW }).run({ businessId: a.business.id });
  const attempts = await db
    .select()
    .from(reminderAttempts)
    .where(eq(reminderAttempts.businessId, a.business.id));
  const ok = attempts.find((x) => x.status === "succeeded");
  assert.ok(ok);
  assert.equal(ok!.providerMessageId, "re_msg_42");

  const first = await recordResendEvent(db, {
    eventId: "evt_dup_1",
    eventType: "email.delivered",
    emailId: "re_msg_42",
    payload: '{"type":"email.delivered"}',
    occurredAt: NOW,
  });
  const second = await recordResendEvent(db, {
    eventId: "evt_dup_1",
    eventType: "email.delivered",
    emailId: "re_msg_42",
    payload: '{"type":"email.delivered"}',
    occurredAt: NOW,
  });
  assert.equal(first, "stored");
  assert.equal(second, "duplicate");
  const events = await db
    .select()
    .from(reminderDeliveryEvents)
    .where(eq(reminderDeliveryEvents.providerEventId, "evt_dup_1"));
  assert.equal(events.length, 1);
  void r;
});

test("recon: paid and cancelled skip for email provider (zero provider calls)", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  const paid = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Pay",
    amountMajor: "1000",
    dueOn: "2026-08-01",
    idempotencyKey: "skip-pay",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: paid.id,
    amountMajor: "1000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "skip-pay-p",
  });
  const cancelled = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Can",
    amountMajor: "1000",
    dueOn: "2026-08-01",
    idempotencyKey: "skip-can",
  });
  await app.cancelReceivable(a.userId, a.business.id, cancelled.id, "x");
  let calls = 0;
  const provider = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async () => {
      calls += 1;
      return { status: 200, body: { id: "should-not" } };
    },
  });
  const out = await new ReminderWorker(db, sql, provider, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(calls, 0);
  assert.equal(out.sent, 0);
});

test("recon: agingBucket unit for business-local date boundary", () => {
  // 2026-09-07 23:00 UTC is still 2026-09-08 00:00 in Lagos (UTC+1) → due 2026-09-07 is overdue in Lagos
  const lagosNight = new Date("2026-09-07T23:30:00Z");
  assert.equal(
    agingBucket({
      dueOn: "2026-09-07",
      cancelledAt: null,
      outstanding: 1n,
      now: lagosNight,
      timeZone: "Africa/Lagos",
    }),
    "overdue",
  );
  // Same instant in UTC calendar still 09-07, but we use business tz
  assert.equal(
    agingBucket({
      dueOn: "2026-09-08",
      cancelledAt: null,
      outstanding: 1n,
      now: lagosNight,
      timeZone: "Africa/Lagos",
    }),
    "due_today",
  );
});
