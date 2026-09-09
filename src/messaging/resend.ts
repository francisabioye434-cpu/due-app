
import type { MessageChannel, MessagingProvider, OutgoingMessage, ProviderResult } from "./provider.ts";

export type ResendTransport = (input: {
  apiKey: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}) => Promise<{ status: number; body: unknown }>;

export const RESEND_API_URL = "https://api.resend.com/emails";

export async function defaultResendTransport(input: {
  apiKey: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ status: number; body: unknown }> {
  const res: any = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify(input.payload),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: Number(res.status), body: parsed };
}

export function classifyResendStatus(status: number, body: unknown): {
  failureCode: string;
  failureMessage: string;
  retriable: boolean;
} {
  const message =
    typeof body === "object" && body && "message" in body && typeof (body as { message: unknown }).message === "string"
      ? (body as { message: string }).message
      : `Resend HTTP ${status}`;
  if (status === 429) return { failureCode: "RATE_LIMITED", failureMessage: message, retriable: true };
  if (status === 409) return { failureCode: "CONCURRENT_IDEMPOTENT", failureMessage: message, retriable: true };
  if (status >= 500) return { failureCode: "PROVIDER_UNAVAILABLE", failureMessage: message, retriable: true };
  if (status === 401 || status === 403) return { failureCode: "SENDER_REJECTED", failureMessage: message, retriable: false };
  return { failureCode: "PROVIDER_REJECTED", failureMessage: message, retriable: false };
}

export class ResendEmailProvider implements MessagingProvider {
  readonly name = "resend";
  readonly channel: MessageChannel = "email";

  constructor(
    private opts: {
      apiKey: string;
      from: string;
      replyTo?: string | null;
      transport?: ResendTransport;
    },
  ) {}

  async send(message: OutgoingMessage): Promise<ProviderResult> {
    if (!message.destination) {
      return {
        ok: false,
        provider: this.name,
        failureCode: "MISSING_DESTINATION",
        failureMessage: "Customer has no usable email address",
        retriable: false,
      };
    }
    const payload: Record<string, unknown> = {
      from: this.opts.from,
      to: [message.destination],
      subject: message.subject,
      text: message.body,
    };
    if (this.opts.replyTo) payload.reply_to = this.opts.replyTo;
    try {
      const transport = this.opts.transport ?? defaultResendTransport;
      const { status, body } = await transport({
        apiKey: this.opts.apiKey,
        payload,
        idempotencyKey: message.idempotencyKey,
      });
      if (status >= 200 && status < 300) {
        const id =
          typeof body === "object" && body && "id" in body && typeof (body as { id: unknown }).id === "string"
            ? (body as { id: string }).id
            : "";
        if (!id) {
          return { ok: false, provider: this.name, failureCode: "PROVIDER_REJECTED", failureMessage: "Resend accepted without id", retriable: false };
        }
        return { ok: true, provider: this.name, providerMessageId: id, retriable: false, acceptance: "accepted" };
      }
      return { ok: false, provider: this.name, ...classifyResendStatus(status, body) };
    } catch (err) {
      return {
        ok: false,
        provider: this.name,
        failureCode: "NETWORK",
        failureMessage: err instanceof Error ? err.message : "network error",
        retriable: true,
      };
    }
  }
}
