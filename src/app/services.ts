import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, Sql } from "../db/client.ts";
import {
  activityEvents,
  businesses,
  customers,
  memberships,
  payments,
  receivables,
  reminderRules,
  reminders,
  sessions,
  users,
} from "../db/schema.ts";
import { agingBucket } from "../domain/aging.ts";
import { isSyntacticEmail } from "../domain/email.ts";
import { outstandingBalance, parseMajorToMinor } from "../domain/money.ts";
import { defaultOffsetsJson, planSchedule } from "../domain/reminders.ts";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "../security/auth.ts";
import { AppError, badRequest, forbidden, notFound, unauthorized } from "./errors.ts";
import type { MessagingProvider } from "../messaging/provider.ts";
import { ReminderWorker } from "../reminders/worker.ts";

export type Clock = { now: () => Date };

export class DueApp {
  constructor(
    private db: Db,
    private clock: Clock = { now: () => new Date() },
  ) {}

  private now() {
    return this.clock.now();
  }

  async register(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    if (!isSyntacticEmail(email)) badRequest("INVALID_EMAIL", "Enter a valid email");
    if (!input.password || input.password.length < 8) badRequest("INVALID_PASSWORD", "Password must be at least 8 characters");
    const existing = await this.db.select().from(users).where(eq(users.email, email));
    if (existing.length) badRequest("EMAIL_TAKEN", "Email already registered");
    const id = randomUUID();
    const ts = this.now();
    await this.db.insert(users).values({
      id,
      email,
      passwordHash: hashPassword(input.password),
      createdAt: ts,
    });
    const token = newSessionToken();
    await this.db.insert(sessions).values({
      id: randomUUID(),
      userId: id,
      tokenHash: hashToken(token),
      expiresAt: new Date(ts.getTime() + 30 * 24 * 3600 * 1000),
      createdAt: ts,
    });
    return { userId: id, token };
  }

  async login(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    const rows = await this.db.select().from(users).where(eq(users.email, email));
    const user = rows[0];
    if (!user || !verifyPassword(input.password, user.passwordHash)) unauthorized("Invalid credentials");
    const token = newSessionToken();
    const ts = this.now();
    await this.db.insert(sessions).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(ts.getTime() + 30 * 24 * 3600 * 1000),
      createdAt: ts,
    });
    return { userId: user.id, token };
  }

  async userFromToken(token: string | null | undefined) {
    if (!token) return null;
    const rows = await this.db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    const s = rows[0];
    if (!s || s.expiresAt < this.now()) return null;
    const u = (await this.db.select().from(users).where(eq(users.id, s.userId)))[0];
    return u ?? null;
  }

  private async requireMembership(userId: string, businessId: string) {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.businessId, businessId)));
    if (!rows.length) forbidden("Not a member of this business");
    return rows[0];
  }

  async createBusiness(userId: string, input: { name: string; email: string; phone?: string; timezone?: string; currency?: string }) {
    if (!input.name.trim()) badRequest("INVALID_NAME", "Business name required");
    const id = randomUUID();
    const ts = this.now();
    const timezone = input.timezone || "Africa/Lagos";
    const currency = input.currency || "NGN";
    await this.db.insert(businesses).values({
      id,
      name: input.name.trim(),
      email: input.email.trim(),
      phone: input.phone?.trim() || null,
      timezone,
      currency,
      createdAt: ts,
      updatedAt: ts,
    });
    await this.db.insert(memberships).values({
      id: randomUUID(),
      businessId: id,
      userId,
      role: "owner",
      createdAt: ts,
    });
    await this.db.insert(reminderRules).values({
      id: randomUUID(),
      businessId: id,
      name: "Default",
      isDefault: true,
      enabled: true,
      offsetsJson: defaultOffsetsJson(),
      createdAt: ts,
      updatedAt: ts,
    });
    return this.getBusiness(userId, id);
  }

  async getBusiness(userId: string, businessId: string) {
    await this.requireMembership(userId, businessId);
    const rows = await this.db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!rows.length) notFound("Business");
    return rows[0];
  }

  async listBusinesses(userId: string) {
    const rows = await this.db
      .select({ business: businesses })
      .from(memberships)
      .innerJoin(businesses, eq(memberships.businessId, businesses.id))
      .where(eq(memberships.userId, userId));
    return rows.map((r) => r.business);
  }

  async createCustomer(
    userId: string,
    businessId: string,
    input: { name: string; companyName?: string; phone?: string; email?: string; notes?: string },
  ) {
    await this.requireMembership(userId, businessId);
    if (!input.name.trim()) badRequest("INVALID_NAME", "Customer name is required");
    if (input.email && input.email.trim() && !isSyntacticEmail(input.email)) {
      badRequest("INVALID_EMAIL", "Enter a valid email address");
    }
    const id = randomUUID();
    const ts = this.now();
    await this.db.insert(customers).values({
      id,
      businessId,
      name: input.name.trim(),
      companyName: input.companyName?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      notes: input.notes?.trim() || null,
      createdAt: ts,
      updatedAt: ts,
    });
    return this.getCustomer(userId, businessId, id);
  }

  async getCustomer(userId: string, businessId: string, customerId: string) {
    await this.requireMembership(userId, businessId);
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)));
    if (!rows.length) notFound("Customer");
    return rows[0];
  }

  async listCustomers(userId: string, businessId: string) {
    await this.requireMembership(userId, businessId);
    return this.db.select().from(customers).where(eq(customers.businessId, businessId));
  }

  private async defaultRule(businessId: string) {
    const rows = await this.db
      .select()
      .from(reminderRules)
      .where(and(eq(reminderRules.businessId, businessId), eq(reminderRules.isDefault, true)));
    return rows[0];
  }

  private async scheduleForReceivable(businessId: string, receivableId: string, dueOn: string, timezone: string) {
    const rule = await this.defaultRule(businessId);
    if (!rule || !rule.enabled) return;
    const offsets = JSON.parse(rule.offsetsJson) as number[];
    const slots = planSchedule({ dueOn, timeZone: timezone, now: this.now(), offsets });
    const ts = this.now();
    for (const slot of slots) {
      try {
        await this.db.insert(reminders).values({
          id: randomUUID(),
          businessId,
          receivableId,
          ruleId: rule.id,
          scheduleKey: slot.scheduleKey,
          offsetDays: slot.offsetDays,
          scheduledFor: slot.scheduledFor,
          status: "scheduled",
          attemptCount: 0,
          nextAttemptAt: null,
          channel: "email",
          lastBody: null,
          cancelledAt: null,
          cancelReason: null,
          createdAt: ts,
          updatedAt: ts,
        });
      } catch {
        // unique partial index — ignore conflicts
      }
    }
  }

  private async cancelFutureReminders(businessId: string, receivableId: string, reason: string) {
    const ts = this.now();
    // Cancel unsent (scheduled) and in-flight (processing) so payment/cancel races stop delivery.
    for (const st of ["scheduled", "processing"] as const) {
      await this.db
        .update(reminders)
        .set({ status: "cancelled", cancelledAt: ts, cancelReason: reason, updatedAt: ts, nextAttemptAt: null })
        .where(
          and(
            eq(reminders.businessId, businessId),
            eq(reminders.receivableId, receivableId),
            eq(reminders.status, st),
          ),
        );
    }
  }

  async createReceivable(
    userId: string,
    businessId: string,
    input: { customerId: string; description: string; amountMajor: string; dueOn: string; idempotencyKey: string },
  ) {
    await this.requireMembership(userId, businessId);
    const biz = await this.getBusiness(userId, businessId);
    await this.getCustomer(userId, businessId, input.customerId);
    if (!input.description.trim()) badRequest("INVALID_DESCRIPTION", "Description required");
    if (!input.idempotencyKey.trim()) badRequest("INVALID_IDEMPOTENCY", "Idempotency key required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) badRequest("INVALID_DUE_ON", "dueOn must be YYYY-MM-DD");
    let amount: bigint;
    try {
      amount = parseMajorToMinor(input.amountMajor, biz.currency);
    } catch {
      badRequest("INVALID_AMOUNT", "Invalid amount");
    }
    if (amount <= 0n) badRequest("INVALID_AMOUNT", "Amount must be positive");

    const existing = await this.db
      .select()
      .from(receivables)
      .where(and(eq(receivables.businessId, businessId), eq(receivables.idempotencyKey, input.idempotencyKey)));
    if (existing.length) return this.getReceivable(userId, businessId, existing[0].id);

    const id = randomUUID();
    const ts = this.now();
    await this.db.insert(receivables).values({
      id,
      businessId,
      customerId: input.customerId,
      description: input.description.trim(),
      originalAmountMinor: amount,
      currency: biz.currency,
      dueOn: input.dueOn,
      cancelledAt: null,
      cancelledByUserId: null,
      cancellationReason: null,
      createdByUserId: userId,
      createdAt: ts,
      updatedAt: ts,
      idempotencyKey: input.idempotencyKey,
    });
    await this.db.insert(activityEvents).values({
      id: randomUUID(),
      businessId,
      receivableId: id,
      customerId: input.customerId,
      type: "RECEIVABLE_CREATED",
      actorUserId: userId,
      payload: JSON.stringify({ amountMinor: amount.toString(), dueOn: input.dueOn }),
      occurredAt: ts,
    });
    await this.scheduleForReceivable(businessId, id, input.dueOn, biz.timezone);
    return this.getReceivable(userId, businessId, id);
  }

  async getReceivable(userId: string, businessId: string, receivableId: string) {
    await this.requireMembership(userId, businessId);
    const rows = await this.db
      .select()
      .from(receivables)
      .where(and(eq(receivables.id, receivableId), eq(receivables.businessId, businessId)));
    if (!rows.length) notFound("Receivable");
    const rec = rows[0];
    const pays = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.receivableId, rec.id), eq(payments.status, "succeeded")));
    const paid = pays.map((p) => p.amountMinor);
    const outstanding = outstandingBalance(rec.originalAmountMinor, paid);
    const biz = (await this.db.select().from(businesses).where(eq(businesses.id, businessId)))[0];
    const bucket = agingBucket({
      dueOn: rec.dueOn,
      cancelledAt: rec.cancelledAt,
      outstanding,
      now: this.now(),
      timeZone: biz.timezone,
    });
    return { ...rec, outstandingMinor: outstanding, paidMinor: rec.originalAmountMinor - outstanding, aging: bucket, payments: pays };
  }

  async listReceivables(userId: string, businessId: string) {
    await this.requireMembership(userId, businessId);
    const rows = await this.db.select().from(receivables).where(eq(receivables.businessId, businessId));
    const out = [];
    for (const r of rows) out.push(await this.getReceivable(userId, businessId, r.id));
    return out;
  }

  async recordPayment(
    userId: string,
    businessId: string,
    input: { receivableId: string; amountMajor: string; paidOn: string; method?: string; note?: string; idempotencyKey: string },
  ) {
    await this.requireMembership(userId, businessId);
    if (!input.idempotencyKey.trim()) badRequest("INVALID_IDEMPOTENCY", "Idempotency key required");

    const existing = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.idempotencyKey, input.idempotencyKey)));
    if (existing.length) return this.getReceivable(userId, businessId, existing[0]!.receivableId);

    // Serialize payment application per receivable to protect financial invariants under concurrency.
    // Prefer a DB transaction + row lock; fall back to sequential re-read of outstanding.
    const apply = async (tx: Db) => {
      // Lock the receivable row when the driver supports it (real PostgreSQL).
      let rows;
      try {
        rows = await tx
          .select()
          .from(receivables)
          .where(and(eq(receivables.id, input.receivableId), eq(receivables.businessId, businessId)))
          .for("update");
      } catch {
        rows = await tx
          .select()
          .from(receivables)
          .where(and(eq(receivables.id, input.receivableId), eq(receivables.businessId, businessId)));
      }
      if (!rows.length) notFound("Receivable");
      const base = rows[0]!;
      if (base.cancelledAt) badRequest("RECEIVABLE_CANCELLED", "Cannot pay a cancelled receivable");

      const pays = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.receivableId, base.id), eq(payments.status, "succeeded")));
      const outstanding = outstandingBalance(
        base.originalAmountMinor,
        pays.map((p) => p.amountMinor),
      );

      let amount: bigint;
      try {
        amount = parseMajorToMinor(input.amountMajor, base.currency);
      } catch {
        badRequest("INVALID_AMOUNT", "Invalid amount");
      }
      if (amount <= 0n) badRequest("INVALID_AMOUNT", "Amount must be positive");
      if (amount > outstanding) {
        throw new AppError(
          "OVERPAYMENT",
          `Payment exceeds outstanding balance of ${outstanding.toString()} minor units`,
          400,
        );
      }

      const ts = this.now();
      await tx.insert(payments).values({
        id: randomUUID(),
        businessId,
        receivableId: base.id,
        amountMinor: amount,
        currency: base.currency,
        paidOn: input.paidOn,
        method: input.method || null,
        note: input.note || null,
        status: "succeeded",
        recordedByUserId: userId,
        createdAt: ts,
        idempotencyKey: input.idempotencyKey,
      });
      await tx.insert(activityEvents).values({
        id: randomUUID(),
        businessId,
        receivableId: base.id,
        type: "PAYMENT_RECORDED",
        actorUserId: userId,
        payload: JSON.stringify({ amountMinor: amount.toString() }),
        occurredAt: ts,
      });
      return base.id;
    };

    let receivableId: string;
    type TxFn = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    const dbWithTx = this.db as Db & { transaction?: TxFn };
    if (typeof dbWithTx.transaction === "function") {
      try {
        receivableId = await dbWithTx.transaction((tx) => apply(tx));
      } catch (e) {
        // If transaction unsupported or failed for env reasons, sequential apply
        if (e instanceof AppError) throw e;
        receivableId = await apply(this.db);
      }
    } else {
      receivableId = await apply(this.db);
    }

    const after = await this.getReceivable(userId, businessId, receivableId);
    if (after.outstandingMinor <= 0n) {
      await this.cancelFutureReminders(businessId, receivableId, "receivable_paid");
    }
    return after;
  }

  async cancelReceivable(userId: string, businessId: string, receivableId: string, reason?: string) {
    await this.requireMembership(userId, businessId);
    const rec = await this.getReceivable(userId, businessId, receivableId);
    if (rec.cancelledAt) return rec;
    if (rec.outstandingMinor <= 0n && !rec.cancelledAt) {
      badRequest("ALREADY_PAID", "Cannot cancel a fully paid receivable");
    }
    const ts = this.now();
    await this.db
      .update(receivables)
      .set({
        cancelledAt: ts,
        cancelledByUserId: userId,
        cancellationReason: reason || null,
        updatedAt: ts,
      })
      .where(eq(receivables.id, receivableId));
    await this.cancelFutureReminders(businessId, receivableId, "receivable_cancelled");
    await this.db.insert(activityEvents).values({
      id: randomUUID(),
      businessId,
      receivableId,
      type: "RECEIVABLE_CANCELLED",
      actorUserId: userId,
      payload: JSON.stringify({ reason: reason || null }),
      occurredAt: ts,
    });
    return this.getReceivable(userId, businessId, receivableId);
  }

  async updateDueDate(userId: string, businessId: string, receivableId: string, dueOn: string) {
    await this.requireMembership(userId, businessId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) badRequest("INVALID_DUE_ON", "dueOn must be YYYY-MM-DD");
    const rec = await this.getReceivable(userId, businessId, receivableId);
    if (rec.cancelledAt) badRequest("RECEIVABLE_CANCELLED", "Cannot update cancelled receivable");
    if (rec.outstandingMinor <= 0n) badRequest("ALREADY_PAID", "Cannot update paid receivable");
    const biz = await this.getBusiness(userId, businessId);
    if (rec.dueOn === dueOn) {
      // still reschedule for consistency in tests: cancel+regenerate active
    }
    const ts = this.now();
    await this.db.update(receivables).set({ dueOn, updatedAt: ts }).where(eq(receivables.id, receivableId));
    await this.cancelFutureReminders(businessId, receivableId, "due_date_changed");
    await this.scheduleForReceivable(businessId, receivableId, dueOn, biz.timezone);
    await this.db.insert(activityEvents).values({
      id: randomUUID(),
      businessId,
      receivableId,
      type: "DUE_DATE_CHANGED",
      actorUserId: userId,
      payload: JSON.stringify({ from: rec.dueOn, to: dueOn }),
      occurredAt: ts,
    });
    return this.getReceivable(userId, businessId, receivableId);
  }

  async dashboard(userId: string, businessId: string) {
    const list = await this.listReceivables(userId, businessId);
    const open = list.filter((r) => !r.cancelledAt && r.outstandingMinor > 0n);
    const sum = (xs: typeof open) => xs.reduce((a, r) => a + r.outstandingMinor, 0n);
    const month = this.now().toISOString().slice(0, 7);
    let paidThisMonth = 0n;
    for (const r of list) {
      for (const p of r.payments) {
        if (p.paidOn.startsWith(month)) paidThisMonth += p.amountMinor;
      }
    }
    return {
      totalOutstanding: sum(open),
      overdue: sum(open.filter((r) => r.aging === "overdue")),
      dueToday: sum(open.filter((r) => r.aging === "due_today")),
      upcoming: sum(open.filter((r) => r.aging === "upcoming")),
      paidThisMonth,
      counts: {
        open: open.length,
        overdue: open.filter((r) => r.aging === "overdue").length,
      },
    };
  }

  async listReminders(userId: string, businessId: string, receivableId: string) {
    await this.requireMembership(userId, businessId);
    await this.getReceivable(userId, businessId, receivableId);
    return this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.businessId, businessId), eq(reminders.receivableId, receivableId)));
  }

  async getReminder(userId: string, businessId: string, reminderId: string) {
    await this.requireMembership(userId, businessId);
    const rows = await this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, reminderId), eq(reminders.businessId, businessId)));
    if (!rows.length) notFound("Reminder");
    const { reminderAttempts } = await import("../db/schema.ts");
    const attempts = await this.db
      .select()
      .from(reminderAttempts)
      .where(and(eq(reminderAttempts.reminderId, reminderId), eq(reminderAttempts.businessId, businessId)));
    return { reminder: rows[0], attempts };
  }

  async workReminders(userId: string, businessId: string, sql: Sql, provider: MessagingProvider) {
    await this.requireMembership(userId, businessId);
    const worker = new ReminderWorker(this.db, sql, provider, this.clock);
    return worker.run({ businessId });
  }
}
