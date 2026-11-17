import test from "node:test";
import assert from "node:assert/strict";
import { accountPasswordResponse } from "../src/server/account-password.ts";

test("password route rejects cross-origin, oversized and mismatched requests before helper", async () => {
 const old = process.env.LH_PASSWORD_SOCKET;
 process.env.LH_PASSWORD_SOCKET = "/unreachable-password-test.sock";
 try {
  const request = (body: unknown, origin = "https://learning.example") => new Request("https://learning.example/api/account/password", { method: "POST", headers: { host: "learning.example", origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await accountPasswordResponse(request({}, "https://other.example"))).status, 403);
  assert.equal((await accountPasswordResponse(request({ newPassword: "x".repeat(5000) }))).status, 413);
  assert.equal((await accountPasswordResponse(request({ currentPassword: "old", newPassword: "long-new-password", confirmPassword: "mismatch" }))).status, 400);
 } finally { if (old === undefined) delete process.env.LH_PASSWORD_SOCKET; else process.env.LH_PASSWORD_SOCKET = old; }
});
