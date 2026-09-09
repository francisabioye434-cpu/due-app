
const PLACEHOLDER_SECRETS = new Set([
  "due-dev-only-change-me",
  "changeme",
  "secret",
  "password",
]);

export type AppEnv = "production" | "development" | "test";

export type AppConfig = {
  env: AppEnv;
  port: number;
  databaseUrl: string | null;
  authSecret: string;
  publicOrigin: string | null;
  secureCookies: boolean;
  csrfRequireOrigin: boolean;
  messagingProvider: "demo" | "email";
  resendApiKey: string | null;
  emailFrom: string | null;
  emailReplyTo: string | null;
  resendWebhookSecret: string | null;
  usePglite: boolean;
};

export function resolveEnv(raw = process.env.DUE_ENV || process.env.NODE_ENV): AppEnv {
  if (raw === "production") return "production";
  if (raw === "test") return "test";
  return "development";
}

export function loadConfig(envSource: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = resolveEnv(envSource.DUE_ENV || envSource.NODE_ENV);
  const databaseUrl = envSource.DATABASE_URL || null;
  const authSecret = envSource.AUTH_SECRET || "";
  const port = Number(envSource.PORT || 3000);
  const usePglite = !databaseUrl || databaseUrl.startsWith("pglite");

  if (env === "production") {
    if (!databaseUrl || !databaseUrl.startsWith("postgres")) {
      throw new Error("DATABASE_URL must be a postgres:// URL in production");
    }
    if (!authSecret || authSecret.length < 32 || PLACEHOLDER_SECRETS.has(authSecret)) {
      throw new Error("AUTH_SECRET must be a non-placeholder secret of at least 32 characters in production");
    }
  } else if (!authSecret && env !== "test") {
    // allow test without explicit if set below
  }
  if (env === "test" && !authSecret) {
    // ok if caller sets
  } else if (!authSecret) {
    throw new Error("AUTH_SECRET is required");
  }

  const secureCookies = env === "production" ? true : envSource.DUE_SECURE_COOKIES === "1";
  const csrfRequireOrigin = env === "production" ? true : envSource.DUE_CSRF_REQUIRE_ORIGIN === "1";

  const rawProvider = (envSource.DUE_MESSAGING_PROVIDER || "demo").toLowerCase();
  if (rawProvider !== "demo" && rawProvider !== "email") {
    throw new Error("DUE_MESSAGING_PROVIDER must be demo or email");
  }
  const messagingProvider = rawProvider as "demo" | "email";
  if (env === "production" && !envSource.DUE_MESSAGING_PROVIDER) {
    throw new Error("Production requires explicit DUE_MESSAGING_PROVIDER=demo or email");
  }
  if (messagingProvider === "email") {
    if (!envSource.RESEND_API_KEY || envSource.RESEND_API_KEY.length < 8) {
      throw new Error("RESEND_API_KEY is required when DUE_MESSAGING_PROVIDER=email");
    }
    if (!envSource.DUE_EMAIL_FROM || !envSource.DUE_EMAIL_FROM.includes("@")) {
      throw new Error("DUE_EMAIL_FROM is required when DUE_MESSAGING_PROVIDER=email");
    }
  }

  return {
    env,
    port: Number.isFinite(port) ? port : 3000,
    databaseUrl,
    authSecret: authSecret || "test-secret-not-for-production-use-32",
    publicOrigin: envSource.DUE_PUBLIC_ORIGIN || null,
    secureCookies,
    csrfRequireOrigin,
    messagingProvider,
    resendApiKey: envSource.RESEND_API_KEY || null,
    emailFrom: envSource.DUE_EMAIL_FROM || null,
    emailReplyTo: envSource.DUE_EMAIL_REPLY_TO || null,
    resendWebhookSecret: envSource.RESEND_WEBHOOK_SECRET || null,
    usePglite,
  };
}
