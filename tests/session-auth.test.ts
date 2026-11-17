import test from "node:test";
import assert from "node:assert/strict";
import { signSession, validSession, safeNext, loginResponse, verifySessionResponse } from "../src/server/session-auth.ts";

const key = Buffer.alloc(32, 9);
test("signed sessions expire, reject tampering and revoke on password revision change", () => {
 const now = 1700000000000;
 const token = signSession("revision-one", true, key, now);
 assert.equal(validSession(token, "revision-one", key, now), true);
 assert.equal(validSession(token, "revision-two", key, now), false);
 assert.equal(validSession(token, "revision-one", Buffer.alloc(32, 4), now), false);
 assert.equal(validSession(token + "bad", "revision-one", key, now), false);
 assert.equal(validSession(token, "revision-one", key, now + 31 * 86400000), false);
 const short = signSession("revision-one", false, key, now);
 assert.equal(validSession(short, "revision-one", key, now + 13 * 3600000), false);
});
test("return paths reject external redirects, backslashes and auth loops", () => {
 for (const path of ["https://evil.invalid", "//evil.invalid", "/\\evil.invalid", "/login?next=/", "/api/auth/logout", "/\nmalicious"]) assert.equal(safeNext(path), "/");
 assert.equal(safeNext("/connect-chatgpt?step=1"), "/connect-chatgpt?step=1");
});
test("self-host auth off leaves desktop login unavailable; configured auth rejects CSRF and unauth APIs", async () => {
 const previous = { enabled: process.env.LH_SESSION_AUTH, origin: process.env.LH_SESSION_ORIGIN };
 try {
  delete process.env.LH_SESSION_AUTH;
  assert.equal((await loginResponse(new Request("https://learning.example/login"))).status, 404);
  process.env.LH_SESSION_AUTH = "1"; process.env.LH_SESSION_ORIGIN = "https://learning.example";
  const csrf = new Request("https://learning.example/login", { method: "POST", headers: { host: "learning.example", origin: "https://other.invalid" }, body: "username=learning&password=secret" });
  assert.equal((await loginResponse(csrf)).status, 403);
  const api = await verifySessionResponse(new Request("https://learning.example/api/auth/verify", { headers: { "x-forwarded-uri": "/api/settings", accept: "text/html" } }));
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("www-authenticate"), null);
  const page = await verifySessionResponse(new Request("https://learning.example/api/auth/verify", { headers: { "x-forwarded-uri": "/connect-chatgpt", accept: "text/html" } }));
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login?next=%2Fconnect-chatgpt");
 } finally {
  if (previous.enabled === undefined) delete process.env.LH_SESSION_AUTH; else process.env.LH_SESSION_AUTH = previous.enabled;
  if (previous.origin === undefined) delete process.env.LH_SESSION_ORIGIN; else process.env.LH_SESSION_ORIGIN = previous.origin;
 }
});
