import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { businesses, reminderRules, reminders } from "../db/schema.ts";
import { DEFAULT_OFFSETS, planSchedule as domainPlan } from "../domain/reminders.ts";

type Business = typeof businesses.$inferSelect;
type Tx = Pick<Db, "insert" | "select" | "update">;

export async function ensureDefaultRule(tx: Tx, businessId: string, now: Date) {
  const existing = await tx
    .select()
    .from(reminderRules)
    .where(and(eq(reminderRules.businessId, businessId), eq(reminderRules.isDefault, true)));
  if (existing.length) return existing[0]!;
  const id = randomUUID();
  await tx.insert(reminderRules).values({
    id,
    businessId,
    name: "Default",
    isDefault: true,
    enabled: true,
    offsetsJson: JSON.stringify([...DEFAULT_OFFSETS]),
    createdAt: now,
    updatedAt: now,
  });
  return (await tx.select().from(reminderRules).where(eq(reminderRules.id, id)))[0]!;
}

export function planSchedule(dueOn: string, timezone: string, now: Date) {
  return domainPlan({ dueOn, timeZone: timezone, now, offsets: [...DEFAULT_OFFSETS] });
}

export async function generateReminderSchedule(
  tx: Tx,
  receivable: { id: string; businessId: string; dueOn: string },
  business: Business,
  now = new Date(),
) {
  const rule = await ensureDefaultRule(tx, receivable.businessId, now);
  if (!rule.enabled) return [];
  const planned = planSchedule(receivable.dueOn, business.timezone, now);
  const created: string[] = [];
  for (const p of planned) {
    const id = randomUUID();
    try {
      await tx.insert(reminders).values({
        id,
        businessId: receivable.businessId,
        receivableId: receivable.id,
        ruleId: rule.id,
        scheduleKey: p.scheduleKey,
        offsetDays: p.offsetDays,
        scheduledFor: p.scheduledFor,
        channel: "email",
        status: "scheduled",
        attemptCount: 0,
        nextAttemptAt: null,
        lastBody: null,
        cancelledAt: null,
        cancelReason: null,
        createdAt: now,
        updatedAt: now,
      });
      created.push(id);
    } catch {
      // unique active schedule — idempotent
    }
  }
  return created;
}

export async function cancelUnsentReminders(tx: Tx, receivableId: string, now: Date, reason: string) {
  for (const st of ["scheduled", "processing"] as const) {
    await tx
      .update(reminders)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelReason: reason,
        updatedAt: now,
        nextAttemptAt: null,
      })
      .where(and(eq(reminders.receivableId, receivableId), eq(reminders.status, st)));
  }
}

export async function rescheduleForDueDateChange(
  tx: Tx,
  receivable: { id: string; businessId: string; dueOn: string },
  business: Business,
  now: Date,
) {
  await cancelUnsentReminders(tx, receivable.id, now, "due_date_changed");
  await generateReminderSchedule(tx, receivable, business, now);
}
