import type { Connection } from "./contract.ts";
import { object } from "./contract.ts";
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
export async function request(config: Connection, route: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/api/integrations/learnharness/${route}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Cannot reach Vulpin. Check the server URL and connection.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new Error("Vulpin access denied. Reconnect in Settings → Vulpin or choose an accessible source.");
    if (response.status === 404) throw new Error("Vulpin source or connector endpoint was not found.");
    if (response.status === 409) throw new Error("Vulpin source pages are not prepared, no longer accessible, or changed since the previous batch. Refresh source descriptors/version before continuing or prepare this file in Vulpin.");
    if (response.status === 429) throw new Error("Vulpin is busy. Retry later with a smaller request.");
    throw new Error(`Vulpin request failed (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Vulpin returned an empty response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Vulpin response is too large. Request fewer pages or results.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  signal.throwIfAborted();
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new Error("Vulpin returned an invalid response"); }
}
