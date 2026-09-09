import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyResendSignature } from "../src/messaging/webhooks.ts";
import { loadConfig } from "../src/config.ts";

function sign(secretB64: string, id: string, timestamp: string, payload: string): string {
  const digest = createHmac("sha256", Buffer.from(secretB64, "base64")).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return `v1,${digest}`;
}

test("valid signed webhook accepted", () => {
  const rawSecret = Buffer.from("unit-test-webhook-secret").toString("base64");
  const payload = '{"type":"email.delivered"}';
  const sig = sign(rawSecret, "evt_1", "1000", payload);
  assert.equal(verifyResendSignature({ payload, id: "evt_1", timestamp: "1000", signature: sig, secret: `whsec_${rawSecret}` }), true);
});

test("tampered payload rejected", () => {
  const rawSecret = Buffer.from("unit-test-webhook-secret").toString("base64");
  const sig = sign(rawSecret, "evt_1", "1000", '{"type":"email.delivered"}');
  assert.equal(
    verifyResendSignature({ payload: '{"type":"email.bounced"}', id: "evt_1", timestamp: "1000", signature: sig, secret: `whsec_${rawSecret}` }),
    false,
  );
});

test("email mode with key and from starts", () => {
  const ok = loadConfig({
    DUE_ENV: "production",
    DATABASE_URL: "postgres://u:p@localhost/db",
    AUTH_SECRET: "a".repeat(32),
    DUE_MESSAGING_PROVIDER: "email",
    RESEND_API_KEY: "re_test_not_real",
    DUE_EMAIL_FROM: "DUE <alerts@example.com>",
  });
  assert.equal(ok.messagingProvider, "email");
});
