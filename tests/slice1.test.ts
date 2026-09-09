import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, createDb, migrate, resetData } from "../src/db/client.ts";
import { DueApp } from "../src/app/services.ts";
import { AppError } from "../src/app/errors.ts";

const NOW = new Date("2026-09-07T12:00:00Z");
let shared: Awaited<ReturnType<typeof createDb>> | null = null;

async function fresh() {
  if (!shared) {
    shared = await createDb();
    await migrate(shared.sql);
  }
  await resetData(shared.sql);
  return { db: shared.db, sql: shared.sql, app: new DueApp(shared.db, { now: () => NOW }) };
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
  return { userId: session.userId, business };
}

test("register business customer receivable dashboard", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi", email: "kemi@example.com" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id,
    description: "Brand work",
    amountMajor: "500000",
    dueOn: "2026-09-10",
    idempotencyKey: "r1",
  });
  assert.equal(r.originalAmountMinor, 50000000n);
  assert.equal(r.outstandingMinor, 50000000n);
  assert.equal(r.aging, "upcoming");
  const d = await app.dashboard(a.userId, a.business.id);
  assert.equal(d.totalOutstanding, 50000000n);
  assert.equal(d.upcoming, 50000000n);
});

test("partial then full payment and overpayment reject", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id, description: "Work", amountMajor: "500000", dueOn: "2026-08-01", idempotencyKey: "p1",
  });
  assert.equal(r.aging, "overdue");
  const mid = await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id, amountMajor: "200000", paidOn: "2026-09-07", method: "cash", idempotencyKey: "pay1",
  });
  assert.equal(mid.outstandingMinor, 30000000n);
  await assert.rejects(
    () => app.recordPayment(a.userId, a.business.id, {
      receivableId: r.id, amountMajor: "350000", paidOn: "2026-09-07", method: "cash", idempotencyKey: "pay2",
    }),
    (e: unknown) => e instanceof AppError && e.code === "OVERPAYMENT",
  );
  const full = await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id, amountMajor: "300000", paidOn: "2026-09-07", method: "cash", idempotencyKey: "pay3",
  });
  assert.equal(full.outstandingMinor, 0n);
  assert.equal(full.aging, "paid");
});

test("cancel after partial keeps payment history", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id, description: "Work", amountMajor: "500000", dueOn: "2026-08-01", idempotencyKey: "c1",
  });
  await app.recordPayment(a.userId, a.business.id, {
    receivableId: r.id, amountMajor: "200000", paidOn: "2026-09-07", method: "cash", idempotencyKey: "cp1",
  });
  const cancelled = await app.cancelReceivable(a.userId, a.business.id, r.id, "client withdrew");
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.payments.length, 1);
  assert.equal(cancelled.originalAmountMinor, 50000000n);
  const d = await app.dashboard(a.userId, a.business.id);
  assert.equal(d.totalOutstanding, 0n);
});

test("tenant isolation", async () => {
  const { app } = await fresh();
  const a = await owner(app, "a@example.com");
  const b = await owner(app, "b@example.com");
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id, description: "Priv", amountMajor: "10000", dueOn: "2026-09-10", idempotencyKey: "t1",
  });
  await assert.rejects(() => app.getReceivable(b.userId, b.business.id, r.id), (e: unknown) => e instanceof AppError && e.status === 404);
});

test("duplicate receivable idempotency", async () => {
  const { app } = await fresh();
  const a = await owner(app);
  const c = await app.createCustomer(a.userId, a.business.id, { name: "Kemi" });
  const r1 = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id, description: "Work", amountMajor: "10000", dueOn: "2026-09-10", idempotencyKey: "same",
  });
  const r2 = await app.createReceivable(a.userId, a.business.id, {
    customerId: c.id, description: "Work", amountMajor: "10000", dueOn: "2026-09-10", idempotencyKey: "same",
  });
  assert.equal(r1.id, r2.id);
});
