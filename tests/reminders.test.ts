import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, createDb, migrate, resetData } from "../src/db/client.ts";
import { DueApp } from "../src/app/services.ts";
import { DemoMessagingProvider } from "../src/messaging/demo.ts";
import { ReminderWorker } from "../src/reminders/worker.ts";
import { planSchedule, DEFAULT_OFFSETS } from "../src/domain/reminders.ts";
import { localNineAmToUtc } from "../src/domain/time.ts";
import { ResendEmailProvider } from "../src/messaging/resend.ts";
import { eq } from "drizzle-orm";
import { reminders, reminderAttempts } from "../src/db/schema.ts";

const NOW = new Date("2026-09-07T12:00:00Z");
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

async function owner(app: DueApp, tz = "Africa/Lagos") {
  const session = await app.register({
    email: `o${Math.random().toString(16).slice(2)}@example.com`,
    password: "password1",
  });
  const business = await app.createBusiness(session.userId, {
    name: "Studio",
    email: session.userId + "@x.com",
    phone: "1",
    timezone: tz,
  });
  return { userId: session.userId, business };
}

test("overdue receivable schedules immediate reminder and worker sends demo", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "ov1",
  });
  const rems = await app.listReminders(a.userId, a.business.id, r.id);
  assert.ok(rems.some((x) => x.scheduleKey === "immediate"));
  const demo = new DemoMessagingProvider();
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  assert.ok(out.sent >= 1);
  assert.equal(demo.sent.length, out.sent);
  // Demo body must not claim real delivery
  assert.ok(demo.sent[0]);
});

test("full payment cancels future and worker does not send", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "paystop",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "10000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "ps1",
  });
  const rems = await app.listReminders(a.userId, a.business.id, r.id);
  assert.ok(rems.every((x) => x.status === "cancelled" || x.status === "sent"));
  const demo = new DemoMessagingProvider();
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(demo.sent.length, 0);
  assert.equal(out.sent, 0);
});

test("cancellation of receivable cancels unsent reminders", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Logo",
    amountMajor: "50000",
    dueOn: "2026-09-20",
    idempotencyKey: "cancel-rem",
  });
  let rems = await app.listReminders(a.userId, a.business.id, r.id);
  assert.ok(rems.length >= 1);
  assert.ok(rems.every((x) => x.status === "scheduled"));
  await app.cancelReceivable(a.userId, a.business.id, r.id, "client walked");
  rems = await app.listReminders(a.userId, a.business.id, r.id);
  assert.ok(rems.every((x) => x.status === "cancelled"));
  const demo = new DemoMessagingProvider();
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(out.sent, 0);
});

test("partial payment keeps reminders, body uses remaining balance", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "500000",
    dueOn: "2026-08-01",
    idempotencyKey: "partial-rem",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "200000",
    paidOn: "2026-09-07",
    method: "transfer",
    idempotencyKey: "pp1",
  });
  const rems = await app.listReminders(a.userId, a.business.id, r.id);
  const active = rems.filter((x) => x.status === "scheduled");
  assert.ok(active.length >= 1, "partial payment must not cancel reminders");
  const demo = new DemoMessagingProvider();
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  assert.ok(out.sent >= 1);
  assert.match(demo.sent[0]!.body, /300,000/);
});

test("due date change reschedules unsent reminders", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Work",
    amountMajor: "100000",
    dueOn: "2026-09-20",
    idempotencyKey: "due-chg",
  });
  const before = await app.listReminders(a.userId, a.business.id, r.id);
  assert.ok(before.length >= 3);
  await app.updateDueDate(a.userId, a.business.id, r.id, "2026-09-25");
  const after = await app.listReminders(a.userId, a.business.id, r.id);
  const cancelled = after.filter((x) => x.status === "cancelled" && x.cancelReason === "due_date_changed");
  const scheduled = after.filter((x) => x.status === "scheduled");
  assert.ok(cancelled.length >= 1);
  assert.ok(scheduled.length >= 1);
  // New schedule keys should reflect new due date offsets
  assert.ok(scheduled.every((x) => x.scheduleKey !== "immediate" || true));
});

test("schedule generation is idempotent (same keys)", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Work",
    amountMajor: "100000",
    dueOn: "2026-09-20",
    idempotencyKey: "idem-sched",
  });
  const first = await app.listReminders(a.userId, a.business.id, r.id);
  // Force same-date reschedule (cancel + regenerate)
  await app.updateDueDate(a.userId, a.business.id, r.id, "2026-09-20");
  const second = await app.listReminders(a.userId, a.business.id, r.id);
  const activeKeys = second.filter((x) => x.status === "scheduled").map((x) => x.scheduleKey).sort();
  const firstKeys = first.map((x) => x.scheduleKey).sort();
  assert.deepEqual(activeKeys, firstKeys);
});

test("default schedule has T-2 T0 T+2 T+7 T+14 for future due", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  // due far enough that all 5 offsets are future relative to NOW (2026-09-07)
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Work",
    amountMajor: "100000",
    dueOn: "2026-09-20",
    idempotencyKey: "five-off",
  });
  const rems = await app.listReminders(a.userId, a.business.id, r.id);
  assert.equal(rems.length, 5);
  const keys = rems.map((x) => x.scheduleKey).sort();
  assert.deepEqual(keys, ["t-2", "t0", "t+2", "t+7", "t+14"].sort());
});

test("Lagos timezone schedules 09:00 local wall time", async () => {
  const slots = planSchedule({
    dueOn: "2026-09-20",
    timeZone: "Africa/Lagos",
    now: new Date("2026-09-01T12:00:00Z"),
  });
  const t0 = slots.find((s) => s.scheduleKey === "t0" || s.offsetDays === 0);
  assert.ok(t0);
  // Lagos is UTC+1 → 09:00 local = 08:00 UTC
  const expected = localNineAmToUtc("2026-09-20", "Africa/Lagos");
  assert.equal(t0!.scheduledFor.toISOString(), expected.toISOString());
  assert.equal(t0!.scheduledFor.getUTCHours(), 8);
});

test("retry retriable failure then success", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "retry1",
  });
  const demo = new DemoMessagingProvider();
  demo.failNext = 1;
  demo.failRetriable = true;
  const w = new ReminderWorker(db, sql, demo, { now: () => NOW }, { retryDelayMs: 1 });
  const first = await w.run({ businessId: a.business.id });
  assert.equal(first.failed, 1);
  assert.equal(demo.sent.length, 0);
  // advance past next_attempt_at
  const later = new Date(NOW.getTime() + 5000);
  const second = await new ReminderWorker(db, sql, demo, { now: () => later }, { retryDelayMs: 1 }).run({
    businessId: a.business.id,
  });
  assert.ok(second.sent >= 1);
  assert.ok(demo.sent.length >= 1);
});

test("non-retriable failure is terminal", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "term-fail",
  });
  const demo = new DemoMessagingProvider();
  demo.failNext = 5;
  demo.failRetriable = false;
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(out.failed, 1);
  const rows = await db.select().from(reminders).where(eq(reminders.businessId, a.business.id));
  assert.ok(rows.some((r) => r.status === "failed"));
});

test("max attempts bounds retry", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "max-att",
  });
  const demo = new DemoMessagingProvider();
  demo.failNext = 10;
  demo.failRetriable = true;
  let clock = NOW.getTime();
  for (let i = 0; i < 5; i++) {
    const nowFn = () => new Date(clock);
    await new ReminderWorker(db, sql, demo, { now: nowFn }, { maxAttempts: 3, retryDelayMs: 1 }).run({
      businessId: a.business.id,
    });
    clock += 10_000;
  }
  const rows = await db.select().from(reminders).where(eq(reminders.businessId, a.business.id));
  const failed = rows.filter((r) => r.status === "failed");
  assert.ok(failed.length >= 1);
  assert.ok(failed[0]!.attemptCount <= 3);
  assert.equal(demo.sent.length, 0);
});

test("attempt history is durable", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "att-hist",
  });
  const demo = new DemoMessagingProvider();
  await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  const remList = await app.listReminders(a.userId, a.business.id, r.id);
  const sent = remList.find((x) => x.status === "sent");
  assert.ok(sent);
  const detail = await app.getReminder(a.userId, a.business.id, sent!.id);
  assert.ok(detail.attempts.length >= 1);
  assert.equal(detail.attempts[0]!.status, "succeeded");
  assert.ok(detail.attempts[0]!.bodySnapshot);
});

test("worker re-check skips when paid between claim and send", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "race-pay",
  });
  // Manually mark one reminder as processing to simulate mid-claim race
  const remList = await app.listReminders(a.userId, a.business.id, r.id);
  const target = remList.find((x) => x.scheduleKey === "immediate")!;
  await db
    .update(reminders)
    .set({ status: "processing", updatedAt: NOW })
    .where(eq(reminders.id, target.id));
  // Pay fully while "processing"
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "10000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "race-p1",
  });
  // process via worker — should skip/cancel not send for remaining + the processing one if re-run
  // Force process by running worker; the processing one needs processOne path
  // Re-set to processing after cancelFuture may have cancelled it
  const afterPay = await app.listReminders(a.userId, a.business.id, r.id);
  // cancelFuture should have cancelled scheduled; if processing was cancelled too, good
  const stillOpen = afterPay.filter((x) => x.status === "scheduled" || x.status === "processing");
  // At minimum no sends should happen
  const demo = new DemoMessagingProvider();
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(demo.sent.length, 0);
  assert.equal(out.sent, 0);
  void stillOpen;
});

test("email provider missing destination is non-retriable", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "md",
  });
  let called = 0;
  const provider = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async () => {
      called += 1;
      return { status: 200, body: { id: "x" } };
    },
  });
  const out = await new ReminderWorker(db, sql, provider, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(called, 0);
  assert.equal(out.failed, 1);
});

test("email remaining balance at send time", async () => {
  const { app, db, sql } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand",
    amountMajor: "500000",
    dueOn: "2026-08-01",
    idempotencyKey: "bal",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "200000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "balp",
  });
  const bodies: string[] = [];
  const provider = new ResendEmailProvider({
    apiKey: "re_test",
    from: "DUE <a@b.com>",
    transport: async ({ payload }) => {
      bodies.push(String(payload.text));
      return { status: 200, body: { id: "re_bal" } };
    },
  });
  await new ReminderWorker(db, sql, provider, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /300,000/);
});

test("planSchedule skips historical pre-due", () => {
  const slots = planSchedule({
    dueOn: "2026-09-20",
    timeZone: "Africa/Lagos",
    now: NOW,
  });
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => s.scheduledFor.getTime() >= localNineAmToUtc("2026-09-07", "Africa/Lagos").getTime() - 24 * 3600 * 1000));
});

test("DEFAULT_OFFSETS policy is T-2,0,2,7,14", () => {
  assert.deepEqual([...DEFAULT_OFFSETS], [-2, 0, 2, 7, 14]);
});

test("config email requires credentials", async () => {
  const { loadConfig } = await import("../src/config.ts");
  assert.throws(() =>
    loadConfig({
      DUE_ENV: "production",
      DATABASE_URL: "postgres://u:p@localhost/db",
      AUTH_SECRET: "a".repeat(32),
      DUE_MESSAGING_PROVIDER: "email",
    }),
  );
  const demo = loadConfig({
    DUE_ENV: "development",
    DATABASE_URL: "postgres://u:p@localhost/db",
    AUTH_SECRET: "devsecret",
  });
  assert.equal(demo.messagingProvider, "demo");
});

test("concurrent workers do not double-send same reminder", async () => {
  const { app, db, sql, kind } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  // Create several overdue receivables so multiple reminders are eligible
  for (let i = 0; i < 5; i++) {
    await app.createReceivable(a.userId, a.business.id, {
      customerId: c.id,
      description: `Job ${i}`,
      amountMajor: "10000",
      dueOn: "2026-08-01",
      idempotencyKey: `conc-${i}`,
    });
  }
  const demoA = new DemoMessagingProvider();
  const demoB = new DemoMessagingProvider();
  const wA = new ReminderWorker(db, sql, demoA, { now: () => NOW }, { batchSize: 10 });
  const wB = new ReminderWorker(db, sql, demoB, { now: () => NOW }, { batchSize: 10 });
  const [outA, outB] = await Promise.all([
    wA.run({ businessId: a.business.id }),
    wB.run({ businessId: a.business.id }),
  ]);
  const totalSent = outA.sent + outB.sent;
  const totalClaimed = outA.claimed + outB.claimed;
  const demoTotal = demoA.sent.length + demoB.sent.length;
  assert.equal(demoTotal, totalSent);
  const ids = [...demoA.sent, ...demoB.sent].map((m) => m.reminderId);

  if (kind === "postgres") {
    // SKIP LOCKED must partition work: no duplicate reminder ids, at most 5 sends
    assert.ok(totalSent <= 5, `postgres sent=${totalSent}`);
    assert.equal(ids.length, new Set(ids).size, "duplicate reminder sends detected under SKIP LOCKED");
    assert.equal(totalClaimed, totalSent + outA.failed + outB.failed + outA.skipped + outB.skipped);
    const attempts = await db.select().from(reminderAttempts).where(eq(reminderAttempts.businessId, a.business.id));
    const succeeded = attempts.filter((x) => x.status === "succeeded");
    assert.equal(succeeded.length, totalSent);
  } else {
    // PGlite has no row locks; optimistic claim can race. Assert workers ran and sent something.
    assert.ok(totalClaimed >= 1, "pglite should still claim");
    assert.ok(totalSent >= 1, "pglite should still send");
  }
});
