
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return value || null;
}

export function isSyntacticEmail(raw: string | null | undefined): boolean {
  const value = normalizeEmail(raw);
  return !!value && value.length <= 254 && EMAIL_RE.test(value);
}

export function usableCustomerEmail(raw: string | null | undefined): string | null {
  const value = normalizeEmail(raw);
  if (!value || !isSyntacticEmail(value)) return null;
  return value;
}

export function emailSubject(stage: string, businessName: string): string {
  if (stage === "upcoming") return `Upcoming payment reminder from ${businessName}`;
  if (stage === "due_today") return `Payment due today — ${businessName}`;
  if (stage === "immediate_overdue") return `Overdue payment reminder from ${businessName}`;
  return `Payment follow-up from ${businessName}`;
}
