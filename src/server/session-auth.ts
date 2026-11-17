import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { passwordHelper } from "./password-client.ts";

export const SESSION_COOKIE = "__Host-lh_session";
const PERSISTENT_SECONDS = 30 * 24 * 60 * 60;
export function sessionAuthEnabled() { return process.env.LH_SESSION_AUTH === "1"; }
function origin() {
 const value = process.env.LH_SESSION_ORIGIN;
 if (!value || new URL(value).origin !== value || !value.startsWith("https://")) throw new Error("unavailable");
 return value;
}
function secret() {
 const path = process.env.LH_SESSION_SECRET_FILE;
 if (!path) throw new Error("unavailable");
 const value = readFileSync(path);
 if (value.byteLength < 32) throw new Error("unavailable");
 return value;
}
export function safeNext(value: string | null) {
 if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value) || value.startsWith("/login") || value.startsWith("/api/auth/")) return "/";
 try { const result = new URL(value, "https://localhost"); return result.origin === "https://localhost" ? result.pathname + result.search : "/"; } catch { return "/"; }
}
export function signSession(revision: string, remember: boolean, key: Buffer, now = Date.now()) {
 const payload = Buffer.from(JSON.stringify({ revision, exp: Math.floor(now / 1000) + (remember ? PERSISTENT_SECONDS : 12 * 3600), nonce: randomBytes(16).toString("hex") })).toString("base64url");
 return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
}
export function validSession(token: string, revision: string, key: Buffer, now = Date.now()) {
 try {
  if (token.length > 2048) return false;
  const parts = token.split("."); if (parts.length !== 2) return false;
  const [payload, signature] = parts as [string, string];
  const supplied = Buffer.from(signature, "base64url"), expected = createHmac("sha256", key).update(payload).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  const seconds = Math.floor(now / 1000);
  return data.revision === revision && Number.isSafeInteger(data.exp) && data.exp > seconds && data.exp <= seconds + PERSISTENT_SECONDS && typeof data.nonce === "string";
 } catch { return false; }
}
export function clearSessionCookie() { return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`; }
async function authenticated(request: Request) {
 const token = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
 if (!token) return false;
 const version = await passwordHelper({ op: "version" });
 if (version.status !== 200 || !version.revision) return false;
 return validSession(token, version.revision, secret());
}
function sameOrigin(request: Request) {
 return request.headers.get("origin") === origin() && request.headers.get("host") === new URL(origin()).host && request.headers.get("sec-fetch-site") !== "cross-site";
}
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Content-Type-Options": "nosniff" };
function escaped(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
function loginPage(next: string, message = "", status = 200) {
 return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · LearnHarness</title><style>html{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#121212;color:#eee;font:16px system-ui;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:100%;max-width:410px;border:1px solid #3b3b3b;border-radius:16px;padding:32px;background:#1c1c1c}h1{font-size:26px;margin:0 0 8px}.brand{font-size:13px;letter-spacing:.1em;color:#aaa;margin-bottom:28px}p{color:#aaa;line-height:1.5}label{display:block;margin-top:20px;font-size:14px}input:not([type=checkbox]){width:100%;padding:12px;margin-top:8px;background:#111;color:white;border:1px solid #555;border-radius:7px;font:inherit}button{width:100%;margin-top:24px;padding:12px;background:#eee;color:#111;border:0;border-radius:7px;font:inherit;font-weight:600}.remember{display:flex;gap:10px;align-items:center}.error{color:#ffc4be}</style><main class="card"><div class="brand">◌ LEARNHARNESS</div><h1>Welcome back</h1><p>Sign in to your personal learning space.</p>${message ? `<p role="alert" class="error">${escaped(message)}</p>` : ""}<form method="post" action="/login"><input type="hidden" name="next" value="${escaped(next)}"><label>Username<input name="username" autocomplete="username" required maxlength="100" autofocus></label><label>Password<input type="password" name="password" autocomplete="current-password" required maxlength="72"></label><label class="remember"><input type="checkbox" name="remember" value="yes" checked>Remember me for 30 days</label><button type="submit">Sign in</button></form><p style="font-size:12px">Your password stays on this server. Use Sign out on shared devices.</p></main></html>`, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
}
export async function loginResponse(request: Request): Promise<Response> {
 if (!sessionAuthEnabled()) return new Response(null, { status: 404 });
 const next = safeNext(new URL(request.url).searchParams.get("next"));
 if (request.method === "GET") return loginPage(next);
 try {
  if (!sameOrigin(request)) return loginPage("/", "Please sign in from this website.", 403);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") return loginPage("/", "Invalid sign-in request.", 400);
  const reader = request.body?.getReader(); if (!reader) return loginPage("/", "Invalid sign-in request.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4096) { await reader.cancel(); return loginPage("/", "Invalid sign-in request.", 413); } chunks.push(value); }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if (["username", "password", "remember", "next"].some(field => fields.getAll(field).length > 1)) return loginPage("/", "Invalid sign-in request.", 400);
  const result = await passwordHelper({ op: "verify", username: fields.get("username"), password: fields.get("password") });
  const destination = safeNext(fields.get("next"));
  if (result.status !== 200 || !result.revision) return loginPage(destination, result.status === 429 ? "Too many sign-in attempts. Try again in 15 minutes." : "Could not sign in. Check your username and password.", result.status === 429 ? 429 : 401);
  const remember = fields.get("remember") === "yes";
  const cookie = `${SESSION_COOKIE}=${signSession(result.revision, remember, secret())}; Path=/; Secure; HttpOnly; SameSite=Lax${remember ? `; Max-Age=${PERSISTENT_SECONDS}` : ""}`;
  return new Response(null, { status: 303, headers: { ...headers, Location: destination, "Set-Cookie": cookie } });
 } catch { return loginPage("/", "Sign-in is temporarily unavailable. Please try again.", 503); }
}
export async function verifySessionResponse(request: Request): Promise<Response> {
 if (!sessionAuthEnabled()) return new Response(null, { status: 503, headers });
 try {
  if (await authenticated(request)) return new Response(null, { status: 204, headers });
  const path = safeNext(request.headers.get("x-forwarded-uri"));
  const method = request.headers.get("x-forwarded-method") ?? "GET";
  if ((method === "GET" || method === "HEAD") && !path.startsWith("/api") && request.headers.get("accept")?.includes("text/html")) return new Response(null, { status: 302, headers: { ...headers, Location: "/login?next=" + encodeURIComponent(path) } });
  return Response.json({ error: "Sign in is required." }, { status: 401, headers });
 } catch { return Response.json({ error: "Sign in is temporarily unavailable." }, { status: 503, headers }); }
}
export async function logoutResponse(request: Request): Promise<Response> {
 try { if (!sessionAuthEnabled() || !sameOrigin(request)) return new Response(null, { status: 403, headers }); }
 catch { return new Response(null, { status: 503, headers }); }
 return new Response(null, { status: 303, headers: { ...headers, Location: "/login", "Set-Cookie": clearSessionCookie() } });
}
export function sessionInfoResponse() { return Response.json({ enabled: sessionAuthEnabled() }, { headers }); }
