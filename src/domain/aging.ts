
import { todayYmdInTz } from "./time.ts";

export type AgingBucket = "upcoming" | "due_today" | "overdue" | "paid" | "cancelled";

export function agingBucket(opts: {
  dueOn: string;
  cancelledAt: Date | null;
  outstanding: bigint;
  now: Date;
  timeZone: string;
}): AgingBucket {
  if (opts.cancelledAt) return "cancelled";
  if (opts.outstanding <= 0n) return "paid";
  const today = todayYmdInTz(opts.now, opts.timeZone);
  if (opts.dueOn > today) return "upcoming";
  if (opts.dueOn === today) return "due_today";
  return "overdue";
}
