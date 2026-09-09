
import { formatMinor } from "./money.ts";
import { addDaysYmd, localNineAmToUtc, todayYmdInTz } from "./time.ts";

export const DEFAULT_OFFSETS = [-2, 0, 2, 7, 14] as const;
export const MAX_REMINDER_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 60_000;

export type OffsetDays = (typeof DEFAULT_OFFSETS)[number] | number;

export function defaultOffsetsJson(): string {
  return JSON.stringify([...DEFAULT_OFFSETS]);
}

export function stageForOffset(offsetDays: number, scheduleKey: string): string {
  if (scheduleKey === "immediate" || scheduleKey.startsWith("immediate")) return "immediate_overdue";
  if (offsetDays < 0) return "upcoming";
  if (offsetDays === 0) return "due_today";
  return "overdue";
}

export function reminderBody(opts: {
  stage: string;
  customerName: string;
  businessName: string;
  outstandingMinor: bigint;
  dueOn: string;
}): string {
  const amount = formatMinor(opts.outstandingMinor);
  if (opts.stage === "upcoming") {
    return `Hi ${opts.customerName}, this is a friendly reminder from ${opts.businessName} that ${amount} is due on ${opts.dueOn}.`;
  }
  if (opts.stage === "due_today") {
    return `Hi ${opts.customerName}, payment of ${amount} is due today to ${opts.businessName}.`;
  }
  return `Hi ${opts.customerName}, ${amount} owed to ${opts.businessName} is overdue (due ${opts.dueOn}). Please arrange payment.`;
}

export type PlannedSlot = { scheduleKey: string; offsetDays: number; scheduledFor: Date };

export function planSchedule(opts: {
  dueOn: string;
  timeZone: string;
  now: Date;
  offsets?: number[];
}): PlannedSlot[] {
  const offsets = opts.offsets ?? [...DEFAULT_OFFSETS];
  const today = todayYmdInTz(opts.now, opts.timeZone);
  const slots: PlannedSlot[] = [];
  const overdueAlready = opts.dueOn < today;

  if (overdueAlready) {
    slots.push({
      scheduleKey: "immediate",
      offsetDays: 0,
      scheduledFor: opts.now,
    });
    for (const off of offsets) {
      if (off <= 0) continue;
      const day = addDaysYmd(opts.dueOn, off);
      if (day < today) continue;
      slots.push({
        scheduleKey: `t${off >= 0 ? "+" : ""}${off}`,
        offsetDays: off,
        scheduledFor: localNineAmToUtc(day, opts.timeZone),
      });
    }
    return slots;
  }

  for (const off of offsets) {
    const day = addDaysYmd(opts.dueOn, off);
    if (day < today) continue;
    slots.push({
      scheduleKey: off === 0 ? "t0" : off > 0 ? `t+${off}` : `t${off}`,
      offsetDays: off,
      scheduledFor: localNineAmToUtc(day, opts.timeZone),
    });
  }
  return slots;
}
