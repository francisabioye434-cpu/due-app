
import { loadConfig } from "../config.ts";
import { DemoMessagingProvider } from "./demo.ts";
import type { MessagingProvider } from "./provider.ts";
import { ResendEmailProvider } from "./resend.ts";

export function createMessagingProvider(envSource: NodeJS.ProcessEnv = process.env): MessagingProvider {
  const cfg = loadConfig(envSource);
  if (cfg.messagingProvider === "demo") return new DemoMessagingProvider();
  if (!cfg.resendApiKey || !cfg.emailFrom) {
    throw new Error("EMAIL provider requires RESEND_API_KEY and DUE_EMAIL_FROM");
  }
  return new ResendEmailProvider({
    apiKey: cfg.resendApiKey,
    from: cfg.emailFrom,
    replyTo: cfg.emailReplyTo,
  });
}
