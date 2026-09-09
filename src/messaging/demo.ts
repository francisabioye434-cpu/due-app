
import type { MessageChannel, MessagingProvider, OutgoingMessage, ProviderResult } from "./provider.ts";

export class DemoMessagingProvider implements MessagingProvider {
  readonly name = "demo";
  readonly channel: MessageChannel = "demo";
  readonly sent: OutgoingMessage[] = [];
  failNext = 0;
  failReminderIds = new Set<string>();
  failCode = "DEMO_FAILURE";
  failRetriable = true;

  async send(message: OutgoingMessage): Promise<ProviderResult> {
    if (this.failReminderIds.has(message.reminderId) || this.failNext > 0) {
      if (this.failNext > 0) this.failNext -= 1;
      return {
        ok: false,
        provider: this.name,
        failureCode: this.failCode,
        failureMessage: "Demo provider simulated failure",
        retriable: this.failRetriable,
      };
    }
    this.sent.push(message);
    return {
      ok: true,
      provider: this.name,
      providerMessageId: `demo-${message.reminderId}-${this.sent.length}`,
      retriable: false,
      acceptance: "accepted",
    };
  }
}
