import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { reminderAttempts, reminderDeliveryEvents } from "../db/schema.ts";

export function verifyResendSignature(input: {
  payload: string;
  id: string;
  timestamp: string;
  signature: string;
  secret: string;
}): boolean {
  const secret = input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret;
  const key = Buffer.from(secret, "base64");
  const toSign = `${input.id}.${input.timestamp}.${input.payload}`;
  const digest = createHmac("sha256", key).update(toSign).digest("base64");
  const expected = `v1,${digest}`;
  const provided = input.signature.split(" ").find((p) => p.startsWith("v1,")) || input.signature;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function recordResendEvent(
  db: Db,
  input: { eventId: string; eventType: string; emailId?: string; payload: string; occurredAt: Date },
): Promise<"stored" | "duplicate"> {
  const existing = await db
    .select()
    .from(reminderDeliveryEvents)
    .where(eq(reminderDeliveryEvents.providerEventId, input.eventId));
  if (existing.length) return "duplicate";
  let attemptId: string | null = null;
  let businessId: string | null = null;
  if (input.emailId) {
    const attempts = await db.select().from(reminderAttempts).where(eq(reminderAttempts.providerMessageId, input.emailId));
    attemptId = attempts[0]?.id ?? null;
    businessId = attempts[0]?.businessId ?? null;
  }
  if (!businessId) return "stored";
  await db.insert(reminderDeliveryEvents).values({
    id: randomUUID(),
    businessId,
    reminderAttemptId: attemptId,
    provider: "resend",
    providerEventId: input.eventId,
    eventType: input.eventType,
    payload: input.payload,
    occurredAt: input.occurredAt,
    receivedAt: new Date(),
  });
  return "stored";
}
