import { createConnection } from "node:net";
export interface PasswordHelperResult { status: number; revision?: string }
export function passwordHelper(data: Record<string, unknown>): Promise<PasswordHelperResult> {
 return new Promise((resolve, reject) => {
  const path = process.env.LH_PASSWORD_SOCKET;
  if (!path) { reject(new Error("unavailable")); return; }
  const socket = createConnection(path); let response = "";
  socket.setTimeout(60000, () => socket.destroy(new Error("timeout")));
  socket.on("connect", () => socket.end(JSON.stringify(data) + "\n"));
  socket.on("data", chunk => { response += chunk.toString(); if (response.length > 4096) socket.destroy(new Error("oversize")); });
  socket.on("error", reject);
  socket.on("end", () => { try { resolve(JSON.parse(response)); } catch { reject(new Error("invalid response")); } });
 });
}
