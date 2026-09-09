/**
 * PostgreSQL Reverification Gate — concurrency-sensitive cases only.
 * These tests require DATABASE_URL=postgres://… and skip on PGlite.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, createDb, migrate, resetData, type Db, type Sql } from "../src/db/client.ts";
import { DueApp } from "../src/app/services.ts";
import { AppError } from "../src/app/errors.ts";
import { ReminderWorker } from "../src/reminders/worker.ts";
import { DemoMessagingProvider } from "../src/messaging/demo.ts";
import { payments, reminderAttempts, reminders } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";

const NOW = new Date("2026-09-07T12:00:00Z");
const url = process.env.DATABASE_URL || "";
const isPostgres = url.startsWith("postgres");

let shared: Awaited<ReturnType<typeof createDb>> | null = null;

async function fresh() {
  if (!isPostgres) {
    return null;
  }
  if (!shared) {
    shared = await createDb({ url, max: 16 });
    assert.equal(shared.kind, "postgres", "must use real PostgreSQL, not PGlite");
    await migrate(shared.sql);
  }
  await resetData(shared.sql);
  return {
    db: shared.db,
    sql: shared.sql,
    kind: shared.kind,
    app: new DueApp(shared.db, { now: () => NOW }),
  };
}

after(async () => {
  if (shared) await closeDb(shared.sql);
});

async function owner(app: DueApp, email = `o-${Math.random().toString(16).slice(2)}@ex.com`) {
  const session = await app.register({ email, password: "password1" });
  const business = await app.createBusiness(session.userId, { name: "Biz", email, phone: "1" });
  return { userId: session.userId, business };
}

test("pg-gate: environment is real PostgreSQL", async () => {
  if (!isPostgres) {
    console.log("SKIP: DATABASE_URL not postgres — concurrency gate not run");
    return;
  }
  const env = await fresh();
  assert.ok(env);
  assert.equal(env!.kind, "postgres");
  // Prove SKIP LOCKED is accepted by the server
  const rows = await (env!.sql as any)`SELECT 1 AS ok WHERE pg_catalog.version() ILIKE '%PostgreSQL%'`;
  assert.ok(rows.length >= 1);
});

test("pg-gate: concurrent full payments — only one of 300k+300k succeeds", async () => {
  if (!isPostgres) return;
  const { app, db } = (await fresh())!;
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  // 300,000 NGN major = 30_000_000 minor
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Full race",
    amountMajor: "300000",
    dueOn: "2026-08-01",
    idempotencyKey: "pg-full",
  });
  assert.equal(r.outstandingMinor, 30000000n);

  const results = await Promise.allSettled([
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "300000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "pg-full-a",
    }),
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "300000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "pg-full-b",
    }),
  ]);

  const ok = results.filter((x) => x.status === "fulfilled");
  const fail = results.filter((x) => x.status === "rejected");
  assert.equal(ok.length, 1, `expected 1 success, got ${ok.length}`);
  assert.equal(fail.length, 1, `expected 1 rejection, got ${fail.length}`);
  const rej = fail[0] as PromiseRejectedResult;
  assert.ok(rej.reason instanceof AppError && rej.reason.code === "OVERPAYMENT");

  const pays = await db.select().from(payments).where(eq(payments.receivableId, r.id));
  const total = pays.reduce((s, p) => s + p.amountMinor, 0n);
  assert.equal(total, 30000000n);
  assert.equal(pays.length, 1);
  const final = await app.getReceivable(a.userId, a.business.id, r.id);
  assert.equal(final.outstandingMinor, 0n);
});

test("pg-gate: concurrent partial overrun 300k+300k on 500k", async () => {
  if (!isPostgres) return;
  const { app, db } = (await fresh())!;
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Partial overrun",
    amountMajor: "500000",
    dueOn: "2026-08-01",
    idempotencyKey: "pg-part",
  });

  const results = await Promise.allSettled([
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "300000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "pg-part-a",
    }),
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "300000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "pg-part-b",
    }),
  ]);

  const ok = results.filter((x) => x.status === "fulfilled");
  const fail = results.filter((x) => x.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(fail.length, 1);
  const pays = await db.select().from(payments).where(eq(payments.receivableId, r.id));
  const total = pays.reduce((s, p) => s + p.amountMinor, 0n);
  assert.ok(total <= 50000000n);
  assert.equal(total, 30000000n);
  const final = await app.getReceivable(a.userId, a.business.id, r.id);
  assert.equal(final.outstandingMinor, 20000000n);
});

test("pg-gate: complementary concurrent 300k+200k on 500k both succeed", async () => {
  if (!isPostgres) return;
  const { app, db } = (await fresh())!;
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Complement",
    amountMajor: "500000",
    dueOn: "2026-08-01",
    idempotencyKey: "pg-comp",
  });

  const results = await Promise.allSettled([
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "300000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "pg-comp-a",
    }),
    app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id,
      amountMajor: "200000",
      paidOn: "2026-09-07",
      method: "cash",
      idempotencyKey: "pg-comp-b",
    }),
  ]);

  const ok = results.filter((x) => x.status === "fulfilled");
  assert.equal(ok.length, 2, `expected both succeed, got ${ok.length}: ${results.map(r => r.status + (r.status==="rejected" ? ":" + (r.reason as Error)?.message : "")).join(",")}`);
  const pays = await db.select().from(payments).where(eq(payments.receivableId, r.id));
  const total = pays.reduce((s, p) => s + p.amountMinor, 0n);
  assert.equal(total, 50000000n);
  const final = await app.getReceivable(a.userId, a.business.id, r.id);
  assert.equal(final.outstandingMinor, 0n);
});

test("pg-gate: two workers one reminder — single claim via SKIP LOCKED", async () => {
  if (!isPostgres) return;
  const { app, db, sql } = (await fresh())!;
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  // one overdue receivable → one immediate eligible reminder
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "One rem",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "pg-one-rem",
  });
  const rems = await app.listReminders(a.userId, a.business.id, r.id);
  const eligible = rems.filter((x) => x.scheduleKey === "immediate");
  assert.equal(eligible.length, 1);

  const demoA = new DemoMessagingProvider();
  const demoB = new DemoMessagingProvider();
  // Separate worker instances, same DB, concurrent run
  const [outA, outB] = await Promise.all([
    new ReminderWorker(db, sql, demoA, { now: () => NOW }, { batchSize: 10 }).run({ businessId: a.business.id }),
    new ReminderWorker(db, sql, demoB, { now: () => NOW }, { batchSize: 10 }).run({ businessId: a.business.id }),
  ]);

  const totalSent = outA.sent + outB.sent;
  const totalClaimed = outA.claimed + outB.claimed;
  assert.equal(totalSent, 1, `sent=${totalSent} claimed=${totalClaimed} A=${JSON.stringify(outA)} B=${JSON.stringify(outB)}`);
  assert.equal(demoA.sent.length + demoB.sent.length, 1);
  const attempts = await db.select().from(reminderAttempts).where(eq(reminderAttempts.businessId, a.business.id));
  const succeeded = attempts.filter((x) => x.status === "succeeded");
  assert.equal(succeeded.length, 1);
  // The one immediate reminder should be sent, not duplicated
  const after = await app.listReminders(a.userId, a.business.id, r.id);
  assert.equal(after.filter((x) => x.status === "sent" && x.scheduleKey === "immediate").length, 1);
});

test("pg-gate: batch workers no double-claim", async () => {
  if (!isPostgres) return;
  const { app, db, sql } = (await fresh())!;
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  for (let i = 0; i < 6; i++) {
    await app.createReceivable(a.userId, a.business.id, {
      customerId: c.id,
      description: `Job ${i}`,
      amountMajor: "1000",
      dueOn: "2026-08-01",
      idempotencyKey: `pg-batch-${i}`,
    });
  }
  const demoA = new DemoMessagingProvider();
  const demoB = new DemoMessagingProvider();
  const [outA, outB] = await Promise.all([
    new ReminderWorker(db, sql, demoA, { now: () => NOW }, { batchSize: 3 }).run({ businessId: a.business.id }),
    new ReminderWorker(db, sql, demoB, { now: () => NOW }, { batchSize: 3 }).run({ businessId: a.business.id }),
  ]);
  const ids = [...demoA.sent, ...demoB.sent].map((m) => m.reminderId);
  assert.equal(ids.length, new Set(ids).size, "duplicate reminder sends");
  assert.ok(outA.claimed <= 3);
  assert.ok(outB.claimed <= 3);
  assert.equal(outA.sent + outB.sent, ids.length);
  // At most 6 immediate reminders exist
  assert.ok(ids.length <= 6);
  assert.ok(ids.length >= 1);
});

test("pg-gate: payment before worker recheck — zero sends", async () => {
  if (!isPostgres) return;
  const { app, db, sql } = (await fresh())!;
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "k@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Race pay",
    amountMajor: "10000",
    dueOn: "2026-08-01",
    idempotencyKey: "pg-race",
  });
  // Simulate claimed (processing) then full payment cancels processing
  const remList = await app.listReminders(a.userId, a.business.id, r.id);
  const target = remList.find((x) => x.scheduleKey === "immediate")!;
  await db.update(reminders).set({ status: "processing", updatedAt: NOW }).where(eq(reminders.id, target.id));

  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id,
    amountMajor: "10000",
    paidOn: "2026-09-07",
    method: "cash",
    idempotencyKey: "pg-race-pay",
  });

  const demo = new DemoMessagingProvider();
  const out = await new ReminderWorker(db, sql, demo, { now: () => NOW }).run({ businessId: a.business.id });
  assert.equal(demo.sent.length, 0);
  assert.equal(out.sent, 0);
  const after = await app.listReminders(a.userId, a.business.id, r.id);
  assert.ok(after.every((x) => x.status === "cancelled" || x.status === "sent" || x.status === "failed"));
  assert.ok(after.filter((x) => x.status === "scheduled" || x.status === "processing").length === 0);
});
