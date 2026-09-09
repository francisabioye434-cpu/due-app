import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resolveEnv } from "../src/config.ts";
import { originAllowed } from "../src/security/csrf.ts";

test("resolveEnv maps production", () => {
  assert.equal(resolveEnv("production"), "production");
  assert.equal(resolveEnv("test"), "test");
});

test("production config rejects placeholder secret", () => {
  assert.throws(() =>
    loadConfig({
      DUE_ENV: "production",
      DATABASE_URL: "postgres://u:p@localhost/db",
      AUTH_SECRET: "due-dev-only-change-me",
    }),
  );
});

test("production enables secure cookies and origin requirement", () => {
  const cfg = loadConfig({
    DUE_ENV: "production",
    DATABASE_URL: "postgres://u:p@localhost/db",
    AUTH_SECRET: "a".repeat(32),
    DUE_MESSAGING_PROVIDER: "demo",
  });
  assert.equal(cfg.secureCookies, true);
  assert.equal(cfg.csrfRequireOrigin, true);
});

test("originAllowed fail-closed when required and headers missing", () => {
  assert.equal(originAllowed("localhost:3000", undefined, undefined, true), false);
  assert.equal(originAllowed("localhost:3000", "http://localhost:3000", undefined, true), true);
});

test("dev defaults to demo provider", () => {
  const cfg = loadConfig({
    DUE_ENV: "development",
    DATABASE_URL: "postgres://u:p@localhost/db",
    AUTH_SECRET: "devsecret",
  });
  assert.equal(cfg.messagingProvider, "demo");
});

test("production without explicit messaging provider fails", () => {
  assert.throws(() =>
    loadConfig({
      DUE_ENV: "production",
      DATABASE_URL: "postgres://u:p@localhost/db",
      AUTH_SECRET: "a".repeat(32),
    }),
  );
});

test("email provider without credentials fails", () => {
  assert.throws(() =>
    loadConfig({
      DUE_ENV: "production",
      DATABASE_URL: "postgres://u:p@localhost/db",
      AUTH_SECRET: "a".repeat(32),
      DUE_MESSAGING_PROVIDER: "email",
    }),
  );
});
