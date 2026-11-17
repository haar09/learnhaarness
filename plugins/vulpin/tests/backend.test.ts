import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { after, before, test } from "node:test";
import type { PluginBackendContext, PluginTools } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { connection, CREDENTIAL_FILE } from "../src/contract.ts";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vulpin-test-"));
const token = "synthetic-test-credential-never-real";
const seen: { url: string; body?: unknown }[] = [];
let deny = false, stall = false, oversized = false, mismatched = false, incomplete = false, management = false, baseUrl = "";
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  seen.push({ url: req.url!, body: body ? JSON.parse(body) : undefined });
  if (stall && req.url?.endsWith("read")) return;
  res.setHeader("Content-Type", "application/json");
  if (deny || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(JSON.stringify({ error: token })); return; }
  const route = req.url!.split("/").at(-1)!;
  if (route === "status") res.end(JSON.stringify({ account: { id: "account-1", email: "learner@example.com" } }));
  else if (route.startsWith("files")) res.end(JSON.stringify({ files: [{ id: "file-1", title: "Geometry", preparedAvailable: true }, { id: "unprepared", preparedAvailable: false }], nextCursor: "file-2" }));
  else if (route === "search") res.end(JSON.stringify({ results: [{ fileId: "file-1", pageRef: "page-7", pageNumber: 7, snippet: "Triangle theorem" }], coverage: { partial: true } }));
  else if (route === "read" && oversized) res.end(JSON.stringify({ pages: [], padding: "x".repeat(24 * 1024 * 1024) }));
  else if (route === "read" && JSON.parse(body).fileId === "unprepared") { res.writeHead(409); res.end('{"error":"source_unavailable"}'); }
  else if (route === "read" && incomplete) res.end(JSON.stringify({pages:[]}));
  else if (route === "read") res.end(JSON.stringify({ pages: [{ fileId: "file-1", pageRef: mismatched ? "wrong-page" : "page-7", pageNumber: 7, title: "Geometry", kind: management ? "management" : "own", sourceVersion: "a".repeat(64), mimeType: "image/png", imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=" }] }));
  else { res.writeHead(404); res.end('{}'); }
});
before(async () => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
function host(directory: string) {
  const handles = new Map<string, (input: unknown) => unknown | Promise<unknown>>();
  const controller = new AbortController(); let contribution: PluginTools | undefined;
  const instructions: { agents: string[]; text: string }[] = [];
  const ctx = { dataDirectory: directory, signal: controller.signal,
    handle(name: string, fn: (input: unknown) => unknown) { handles.set(name, fn); return () => handles.delete(name); },
    registerInstructions(value: { agents: string[]; text: string }) { instructions.push(value); return () => instructions.pop(); },
    registerTools(value: PluginTools) { contribution = value; return () => { contribution = undefined; }; }, events: { emit() {} },
  } as unknown as PluginBackendContext;
  const dispose = activate(ctx);
  return { call: (name: string, input?: unknown) => Promise.resolve(handles.get(name)!(input)), tools: () => contribution!.create({ chatId: "chat-test", agent: "teacher" }), instructions, controller, dispose };
}
test("private connection survives restart and all agents receive tools without secret-bearing settings", async () => {
  const directory = path.join(root, "connection"), h = host(directory);
  assert.deepEqual(await h.call("status"), { configured: false, connected: false });
  const result = await h.call("connect", { baseUrl, token });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual((result as { account: unknown }).account, { id: "account-1", email: "learner@example.com" });
  const filename = path.join(directory, CREDENTIAL_FILE);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(filename, "utf8")).token, token);
  assert.deepEqual(h.instructions[0]!.agents, ["prober", "teacher", "practice"]);
  assert.match(h.instructions[0]!.text, /descriptors.*never evidence/i);
  assert.deepEqual(h.tools().map(tool => tool.name), ["vulpin_list_files", "vulpin_search", "vulpin_read_pages"]);
  h.dispose(); const next = host(directory);
  assert.equal((await next.call("status") as { connected: boolean }).connected, true);
  await next.call("disconnect"); assert.equal(fs.existsSync(filename), false);
  await assert.rejects(() => next.tools()[0]!.execute("call", {}), /disconnected/); next.dispose();
});
test("lazy remote list/search and native page images preserve citations and avoid duplicate image details", async () => {
  const h = host(path.join(root, "tools")); await h.call("connect", { baseUrl, token });
  const [list, search, read] = h.tools();
  const result = await list!.execute("list", { query: "geometry", limit: 2 }); assert.equal((result.details as { files: unknown[] }).files.length, 2);
  const found = await search!.execute("search", { queries: ["triangles"], limit: 2 }); assert.equal((found.details as { coverage: { partial: boolean } }).coverage.partial, true);
  const pages = await read!.execute("read", { pageRefs: ["page-7"] }); assert.equal(pages.content.filter(part => part.type === "image").length, 1);
  assert.deepEqual(pages.details, { pages: [{ fileId: "file-1", pageRef: "page-7", pageNumber: 7, title: "Geometry", kind: "own", sourceVersion: "a".repeat(64) }] });
  assert.equal(JSON.stringify(pages.details).includes("imageBase64"), false);
  assert.deepEqual(seen.at(-2)!.body, { queries: ["triangles"], limit: 2 }); assert.deepEqual(seen.at(-1)!.body, { pageRefs: ["page-7"] });
  await assert.rejects(() => read!.execute("bad", { fileId: "file-1", pages: [1, 2, 3, 4, 5] }), /1–4/);
  await assert.rejects(() => read!.execute("bad", { fileId: "file-1", pageRefs: ["page-7"] }), /only/);
  await assert.rejects(() => read!.execute("bad", { fileId: "unprepared", pages: [1] }), /not prepared/); h.dispose();
});
test("incomplete and unrelated read responses fail before accepting source images", async () => {
  const h = host(path.join(root, "correspondence")); await h.call("connect", { baseUrl, token });
  try {
    mismatched = true; await assert.rejects(() => h.tools()[2]!.execute("read", { pageRefs: ["page-7"] }), /do not match/);
    mismatched = false; incomplete = true; await assert.rejects(() => h.tools()[2]!.execute("read", { pageRefs: ["page-7"] }), /invalid page batch|incomplete/);
    incomplete = false;
    await assert.rejects(() => h.tools()[1]!.execute("search", {queries:["x".repeat(513)]}), /Invalid query/);
    await assert.rejects(() => h.tools()[0]!.execute("list", {query:"x".repeat(201)}), /Invalid query/);
  } finally { mismatched = incomplete = false; h.dispose(); }
});
test("management citations suppress identity metadata and version pins travel to the API", async () => {
  const h = host(path.join(root, "policy")); await h.call("connect", { baseUrl, token });
  try {
    management = true; const result = await h.tools()[2]!.execute("read", { pageRefs: ["page-7"] });
    const serialized = JSON.stringify(result.details); assert.equal(serialized.includes("Geometry"), false); assert.equal(serialized.includes("pageNumber"), false); assert.match(serialized, /School source/);
    management = false; await h.tools()[2]!.execute("read", { fileId: "file-1", pages: [7], expectedVersion: "a".repeat(64) });
    assert.deepEqual(seen.at(-1)!.body, {fileId:"file-1",pages:[7],expectedVersion:"a".repeat(64)});
    await assert.rejects(() => h.tools()[2]!.execute("read", {fileId:"file-1",pages:[7],expectedVersion:"b".repeat(64)}), /version changed/);
  } finally { management = false; h.dispose(); }
});
test("upstream denied response body never enters settings or tool errors", async () => {
  const h = host(path.join(root, "denied")); await h.call("connect", { baseUrl, token }); deny = true;
  try { assert.equal(JSON.stringify(await h.call("status")).includes(token), false);
    await assert.rejects(() => h.tools()[0]!.execute("list", {}), error => error instanceof Error && /access denied/.test(error.message) && !error.message.includes(token));
    await assert.rejects(() => h.call("connect", { baseUrl, token }), /access denied/);
  } finally { deny = false; h.dispose(); }
});
test("oversized batches fail explicitly", async () => {
  const h = host(path.join(root, "oversized")); await h.call("connect", { baseUrl, token }); oversized = true;
  try { await assert.rejects(() => h.tools()[2]!.execute("read", { pageRefs: ["page-7"] }), /too large/); } finally { oversized = false; h.dispose(); }
});
test("disconnect and disable cancel pending work and fence captured tools", async () => {
  const h = host(path.join(root, "abort")); await h.call("connect", { baseUrl, token }); stall = true;
  try { const tools = h.tools(); const pending = tools[2]!.execute("read", { pageRefs: ["page-7"] });
    await new Promise(resolve => setTimeout(resolve, 20)); await h.call("disconnect"); await assert.rejects(() => pending, /abort/i);
    await assert.rejects(() => tools[0]!.execute("list", {}), /disconnected/);
    await h.call("connect", { baseUrl, token }); h.controller.abort(); await assert.rejects(() => tools[0]!.execute("list", {}), /abort/i);
  } finally { stall = false; h.dispose(); }
});
test("origins, header safety and future formats are validated", () => {
  for (const bad of ["http://example.com", "https://user:password@example.com", "https://example.com/secret", "https://example.com?token=bad"]) assert.throws(() => connection({ version: 1, baseUrl: bad, token }));
  assert.throws(() => connection({ version: 2, baseUrl, token }), /Unsupported/);
  assert.throws(() => connection({ version: 1, baseUrl, token: "bad\nheader" }));
});
