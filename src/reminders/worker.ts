import { randomUUID } from "node:crypto";
import { and, eq, lte, or, isNull, sql as dsql } from "drizzle-orm";
import type { Db, Sql } from "../db/client.ts";
import { activityEvents, businesses, customers, payments, receivables, reminderAttempts, reminders } from "../db/schema.ts";
import { outstandingBalance } from "../domain/money.ts";
import { MAX_REMINDER_ATTEMPTS, reminderBody, stageForOffset, DEFAULT_RETRY_DELAY_MS } from "../domain/reminders.ts";
import { emailSubject, usableCustomerEmail } from "../domain/email.ts";
import type { MessagingProvider } from "../messaging/provider.ts";

export type WorkerClock = { now: () => Date };

function isPostgresJs(sql: Sql): sql is ReturnType<typeof import("postgres")> {
  return typeof (sql as { unsafe?: unknown }).unsafe === "function" && !("exec" in sql);
}

export class ReminderWorker {
  constructor(
    private db: Db,
    private sql: Sql,
    private provider: MessagingProvider,
    private clock: WorkerClock = { now: () => new Date() },
    private opts: { batchSize?: number; maxAttempts?: number; retryDelayMs?: number } = {},
  ) {}

  /**
   * Claim eligible reminders.
   * On real PostgreSQL: single UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING
   * so concurrent workers cannot double-claim.
   * On PGlite: optimistic select-then-update (single process / tests).
   */
  private async claimIds(now: Date, batchSize: number, businessId?: string): Promise<string[]> {
    if (isPostgresJs(this.sql)) {
      // postgres.js tagged templates need ISO strings for timestamps in dynamic SQL
      const nowIso = now.toISOString();
      const rows = businessId
        ? await this.sql`
            WITH picked AS (
              SELECT id FROM reminders
              WHERE status = 'scheduled'
                AND scheduled_for <= ${nowIso}::timestamptz
                AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso}::timestamptz)
                AND business_id = ${businessId}
              ORDER BY scheduled_for
              LIMIT ${batchSize}
              FOR UPDATE SKIP LOCKED
            )
            UPDATE reminders r
            SET status = 'processing', updated_at = ${nowIso}::timestamptz
            FROM picked
            WHERE r.id = picked.id
            RETURNING r.id
          `
        : await this.sql`
            WITH picked AS (
              SELECT id FROM reminders
              WHERE status = 'scheduled'
                AND scheduled_for <= ${nowIso}::timestamptz
                AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso}::timestamptz)
              ORDER BY scheduled_for
              LIMIT ${batchSize}
              FOR UPDATE SKIP LOCKED
            )
            UPDATE reminders r
            SET status = 'processing', updated_at = ${nowIso}::timestamptz
            FROM picked
            WHERE r.id = picked.id
            RETURNING r.id
          `;
      return (rows as unknown as { id: string }[]).map((r) => r.id);
    }

    // PGlite / fallback: optimistic claim
    const candidates = await this.db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.status, "scheduled"),
          lte(reminders.scheduledFor, now),
          or(isNull(reminders.nextAttemptAt), lte(reminders.nextAttemptAt, now)),
          businessId ? eq(reminders.businessId, businessId) : dsql`true`,
        ),
      )
      .limit(batchSize)
      .orderBy(reminders.scheduledFor);

    const claimed: string[] = [];
    for (const c of candidates) {
      await this.db
        .update(reminders)
        .set({ status: "processing", updatedAt: now })
        .where(and(eq(reminders.id, c.id), eq(reminders.status, "scheduled")));
      const check = await this.db
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, c.id), eq(reminders.status, "processing")));
      if (check.length) claimed.push(c.id);
    }
    return claimed;
  }

  async run(filter?: { businessId?: string }): Promise<{ claimed: number; sent: number; failed: number; skipped: number }> {
    const batchSize = this.opts.batchSize ?? 25;
    const now = this.clock.now();
    const claimed = await this.claimIds(now, batchSize, filter?.businessId);

    let sent = 0, failed = 0, skipped = 0;
    for (const id of claimed) {
      try {
        const result = await this.processOne(id);
        if (result === "sent") sent += 1;
        else if (result === "failed") failed += 1;
        else skipped += 1;
      } catch {
        failed += 1;
        await this.db
          .update(reminders)
          .set({
            status: "scheduled",
            nextAttemptAt: new Date(this.clock.now().getTime() + (this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)),
            updatedAt: this.clock.now(),
          })
          .where(eq(reminders.id, id));
      }
    }
    return { claimed: claimed.length, sent, failed, skipped };
  }

  private async processOne(reminderId: string): Promise<"sent" | "failed" | "skipped"> {
    const now = this.clock.now();
    const rem = (await this.db.select().from(reminders).where(eq(reminders.id, reminderId)))[0];
    if (!rem || rem.status !== "processing") return "skipped";

    // Re-check financial truth before dispatch (payment/cancel race window)
    const rec = (await this.db.select().from(receivables).where(eq(receivables.id, rem.receivableId)))[0];
    if (!rec || rec.cancelledAt) {
      await this.skipCancel(rem.id, rem.businessId, rem.receivableId, now, rec?.cancelledAt ? "receivable_cancelled" : "missing_receivable");
      return "skipped";
    }
    const payRows = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.receivableId, rec.id), eq(payments.status, "succeeded")));
    const outstanding = outstandingBalance(rec.originalAmountMinor, payRows.map((p) => p.amountMinor));
    if (outstanding <= 0n) {
      await this.skipCancel(rem.id, rem.businessId, rem.receivableId, now, "receivable_paid");
      return "skipped";
    }

    const biz = (await this.db.select().from(businesses).where(eq(businesses.id, rem.businessId)))[0];
    const customer = (await this.db.select().from(customers).where(eq(customers.id, rec.customerId)))[0];
    const stage = stageForOffset(rem.offsetDays, rem.scheduleKey);
    const draft = reminderBody({
      stage,
      customerName: customer?.name ?? "customer",
      businessName: biz?.name ?? "business",
      outstandingMinor: outstanding,
      dueOn: rec.dueOn,
    });
    const body = (rec.description ? `${draft} Regarding: ${rec.description}.` : draft).slice(0, 2000);
    const subject = emailSubject(stage, biz?.name ?? "business");
    const destination = this.provider.channel === "email" ? usableCustomerEmail(customer?.email) : "demo@local";
    const attemptNumber = rem.attemptCount + 1;
    const attemptId = randomUUID();

    await this.db.insert(reminderAttempts).values({
      id: attemptId,
      businessId: rem.businessId,
      reminderId: rem.id,
      attemptNumber,
      provider: this.provider.name,
      startedAt: now,
      completedAt: null,
      status: "processing",
      failureCode: null,
      failureMessage: null,
      providerMessageId: null,
      channel: this.provider.channel,
      destination,
      subject,
      bodySnapshot: body,
      retriable: null,
      acceptance: null,
      createdAt: now,
    });

    let result;
    if (this.provider.channel === "email" && !destination) {
      result = {
        ok: false as const,
        provider: this.provider.name,
        failureCode: "MISSING_DESTINATION",
        failureMessage: "Customer has no usable email address",
        retriable: false,
      };
    } else {
      try {
        result = await this.provider.send({
          businessId: rem.businessId,
          reminderId: rem.id,
          receivableId: rem.receivableId,
          channel: this.provider.channel,
          destination,
          subject,
          body,
          scheduledFor: rem.scheduledFor,
          idempotencyKey: `due-attempt-${attemptId}`,
          metadata: { description: rec.description, currency: rec.currency },
        });
      } catch (err) {
        result = {
          ok: false as const,
          provider: this.provider.name,
          failureCode: "WORKER_ERROR",
          failureMessage: err instanceof Error ? err.message : "unknown",
          retriable: true,
        };
      }
    }

    const done = this.clock.now();
    const maxAttempts = this.opts.maxAttempts ?? MAX_REMINDER_ATTEMPTS;
    if (result.ok) {
      await this.db.update(reminderAttempts).set({
        completedAt: done,
        status: "succeeded",
        providerMessageId: result.providerMessageId,
        acceptance: "accepted",
        retriable: false,
      }).where(eq(reminderAttempts.id, attemptId));
      await this.db.update(reminders).set({
        status: "sent",
        attemptCount: attemptNumber,
        lastBody: body,
        updatedAt: done,
      }).where(eq(reminders.id, rem.id));
      await this.db.insert(activityEvents).values({
        id: randomUUID(),
        businessId: rem.businessId,
        receivableId: rem.receivableId,
        type: this.provider.channel === "email" ? "REMINDER_EMAIL_ACCEPTED" : "REMINDER_DEMO_SENT",
        payload: JSON.stringify({ reminderId: rem.id, attemptId, provider: this.provider.name, providerMessageId: result.providerMessageId }),
        occurredAt: done,
      });
      return "sent";
    }

    const terminal = !result.retriable || attemptNumber >= maxAttempts;
    await this.db.update(reminderAttempts).set({
      completedAt: done,
      status: "failed",
      failureCode: result.failureCode,
      failureMessage: result.failureMessage,
      retriable: result.retriable,
      acceptance: "rejected",
    }).where(eq(reminderAttempts.id, attemptId));
    await this.db.update(reminders).set({
      status: terminal ? "failed" : "scheduled",
      attemptCount: attemptNumber,
      lastBody: body,
      nextAttemptAt: terminal ? null : new Date(done.getTime() + (this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)),
      updatedAt: done,
    }).where(eq(reminders.id, rem.id));
    await this.db.insert(activityEvents).values({
      id: randomUUID(),
      businessId: rem.businessId,
      receivableId: rem.receivableId,
      type: "REMINDER_FAILED",
      payload: JSON.stringify({ reminderId: rem.id, attemptId, terminal, code: result.failureCode }),
      occurredAt: done,
    });
    return "failed";
  }

  private async skipCancel(id: string, businessId: string, receivableId: string, now: Date, reason: string) {
    await this.db.update(reminders).set({
      status: "cancelled",
      cancelledAt: now,
      cancelReason: reason,
      updatedAt: now,
    }).where(eq(reminders.id, id));
    await this.db.insert(activityEvents).values({
      id: randomUUID(),
      businessId,
      receivableId,
      type: "REMINDER_CANCELLED",
      payload: JSON.stringify({ reminderId: id, reason }),
      occurredAt: now,
    });
  }
}
