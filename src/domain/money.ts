
export function parseMajorToMinor(major: string, currency = "NGN"): bigint {
  const cleaned = major.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error("INVALID_AMOUNT");
  const [w, f = ""] = cleaned.split(".");
  const frac = (f + "00").slice(0, 2);
  return BigInt(w) * 100n + BigInt(frac);
}

export function formatMinor(minor: bigint, currency = "NGN"): string {
  const neg = minor < 0n;
  const v = neg ? -minor : minor;
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, "0");
  const n = `${whole.toLocaleString("en-US")}.${frac}`;
  if (currency === "NGN") return `₦${neg ? "-" : ""}${n}`;
  return `${neg ? "-" : ""}${n} ${currency}`;
}

export function outstandingBalance(original: bigint, paid: bigint[]): bigint {
  const sum = paid.reduce((a, b) => a + b, 0n);
  return original - sum;
}
