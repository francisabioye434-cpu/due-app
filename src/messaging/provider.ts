
export type MessageChannel = "demo" | "email";

export type OutgoingMessage = {
  businessId: string;
  reminderId: string;
  receivableId: string;
  channel: MessageChannel;
  destination: string | null;
  subject: string;
  body: string;
  scheduledFor: Date;
  idempotencyKey: string;
  metadata: Record<string, string>;
};

export type ProviderResult =
  | {
      ok: true;
      provider: string;
      providerMessageId: string;
      retriable: false;
      acceptance: "accepted";
    }
  | {
      ok: false;
      provider: string;
      failureCode: string;
      failureMessage: string;
      retriable: boolean;
    };

export interface MessagingProvider {
  readonly name: string;
  readonly channel: MessageChannel;
  send(message: OutgoingMessage): Promise<ProviderResult>;
}
