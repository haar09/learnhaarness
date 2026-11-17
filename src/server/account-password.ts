import { passwordHelper } from "./password-client.ts";
import { sessionAuthEnabled, clearSessionCookie } from "./session-auth.ts";

const MAX_BODY = 4096;
export async function accountPasswordResponse(request: Request): Promise<Response> {
 const reply = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
 if (!process.env.LH_PASSWORD_SOCKET) return reply(503, "Password changes are not configured on this installation.");
 const origin = request.headers.get("origin");
 const host = request.headers.get("host");
 let parsed: URL;
 try { parsed = new URL(origin ?? ""); } catch { return reply(403, "A same-origin request is required."); }
 if (parsed.host !== host || parsed.protocol !== "https:" || request.headers.get("sec-fetch-site") === "cross-site") return reply(403, "A same-origin request is required.");
 if (!request.headers.get("content-type")?.startsWith("application/json")) return reply(415, "JSON is required.");
 let data: unknown;
 try {
  const reader = request.body?.getReader();
  if (!reader) return reply(400, "Missing request body.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BODY) { await reader.cancel(); return reply(413, "Request is too large."); } chunks.push(value); }
  data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
 } catch { return reply(400, "Invalid request."); }
 if (!data || typeof data !== "object") return reply(400, "Invalid request.");
 const { currentPassword, newPassword, confirmPassword } = data as Record<string, unknown>;
 if (typeof currentPassword !== "string" || typeof newPassword !== "string" || typeof confirmPassword !== "string" || Buffer.byteLength(currentPassword) > 72 || Buffer.byteLength(newPassword) > 72 || newPassword.length < 12 || newPassword !== confirmPassword || !currentPassword || /\0/.test(currentPassword + newPassword)) return reply(400, "Enter your current password and matching new passwords (12 characters minimum, 72 bytes maximum).");
 try {
  const result = await passwordHelper({ op: "change", currentPassword, newPassword, confirmPassword });
  if (result.status === 200) return Response.json({ ok: true, signInRequired: sessionAuthEnabled() }, { headers: { "Cache-Control": "no-store", ...(sessionAuthEnabled() ? { "Set-Cookie": clearSessionCookie() } : {}) } });
  if ([400, 403, 429].includes(result.status)) return reply(result.status, result.status === 403 ? "Current password is incorrect." : result.status === 429 ? "Too many attempts. Try again in 15 minutes." : "Invalid password request.");
 } catch { /* Never log request contents or helper errors. */ }
 return reply(503, "Could not change the password. Please try again later.");
}
