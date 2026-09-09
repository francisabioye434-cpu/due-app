
/** Convert YYYY-MM-DD + local 09:00 in IANA tz to UTC Date. */
export function localNineAmToUtc(dateYmd: string, timeZone: string): Date {
  // Approximate via iterative offset (no external lib)
  const [y, m, d] = dateYmd.split("-").map(Number);
  // start guess: UTC 09:00
  let guess = Date.UTC(y, m - 1, d, 9, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const ly = get("year"), lm = get("month"), ld = get("day");
    let lh = get("hour");
    if (lh === 24) lh = 0;
    const lmin = get("minute");
    const want = Date.UTC(y, m - 1, d, 9, 0, 0);
    const have = Date.UTC(ly, lm - 1, ld, lh, lmin, 0);
    guess += want - have;
  }
  return new Date(guess);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function todayYmdInTz(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // en-CA gives YYYY-MM-DD
  return parts;
}
