import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { boundedInteger, connection, CREDENTIAL_FILE, INSTRUCTIONS, object, string, type Connection, type Status } from "./contract.ts";
import { request } from "./client.ts";

const listInput = Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })), cursor: Type.Optional(Type.String({ maxLength: 1000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) });
const searchInput = Type.Object({ queries: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 3 }), courseId: Type.Optional(Type.String({ maxLength: 1000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })) });
const readInput = Type.Object({ fileId: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 800 }), { minItems: 1, maxItems: 4 })), pageRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 4 })), expectedVersion: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$", description: "sourceVersion returned for this file; reuse for subsequent batches to avoid mixed revisions" })) });
const PREVIEW_MAX_CURSOR_LENGTH = 512;
const previewFields = {
  folderId: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: PREVIEW_MAX_CURSOR_LENGTH })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const outlineInput = Type.Object(previewFields, { additionalProperties: false });
const briefsInput = Type.Object({
  ...previewFields,
  fileId: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  sourceVersion: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$", description: "Use the version returned by file or outline discovery" })),
}, { additionalProperties: false });
const BRIEF_TURN_PAGES = 200;
const BRIEF_TURN_BYTES = 256 * 1024;
const jsonResult = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data });

export function activate(ctx: PluginBackendContext): () => void {
  const credentialPath = path.join(ctx.dataDirectory, CREDENTIAL_FILE);
  let config: Connection | undefined;
  try { config = connection(JSON.parse(fs.readFileSync(credentialPath, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Vulpin connection file is invalid. Repair or remove the protected connection file."); }
  let generation = new AbortController();
  let revision = 0;
  let mutation = false;
  const assertActive = () => ctx.signal.throwIfAborted();
  const changed = () => { generation.abort(); generation = new AbortController(); revision++; ctx.events.emit("connection-changed"); };
  const scopedSignal = (signal?: AbortSignal) => AbortSignal.any([ctx.signal, generation.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  const call = async (route: string, body?: unknown, signal?: AbortSignal) => {
    assertActive();
    if (!config) throw new Error("Vulpin is disconnected. Connect in Settings → Vulpin.");
    const activeSignal = scopedSignal(signal);
    const result = await request(config, route, body, activeSignal);
    activeSignal.throwIfAborted();
    assertActive();
    return result;
  };
  const status = async (): Promise<Status> => {
    assertActive();
    if (!config) return { configured: false, connected: false };
    const current = config;
    const currentRevision = revision;
    try {
      const response = await call("status");
      if (revision !== currentRevision) return { configured: Boolean(config), connected: false };
      const account = object(response.account);
      return { configured: true, connected: true, baseUrl: current.baseUrl, account: { id: string(account.id, "account ID"), email: string(account.email, "account email") } };
    } catch (error) {
      assertActive();
      if (revision !== currentRevision) return { configured: Boolean(config), connected: false };
      return { configured: true, connected: false, baseUrl: current.baseUrl, error: error instanceof Error ? error.message : "Vulpin connection failed" };
    }
  };
  const disposers = [
    ctx.handle("status", status),
    ctx.handle("connect", async input => {
      assertActive();
      if (mutation) throw new Error("A Vulpin connection update is already in progress");
      mutation = true;
      const currentRevision = revision;
      try {
        const next = connection({ ...object(input), version: 1 });
        const response = await request(next, "status", undefined, scopedSignal());
        const account = object(response.account);
        const safeAccount = { id: string(account.id, "account ID"), email: string(account.email, "account email") };
        assertActive();
        if (revision !== currentRevision) throw new Error("Vulpin connection changed while connecting. Try again.");
        fs.mkdirSync(ctx.dataDirectory, { recursive: true, mode: 0o700 });
        const temporary = `${credentialPath}.tmp-${randomUUID()}`;
        try {
          fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
          fs.renameSync(temporary, credentialPath);
        } finally { fs.rmSync(temporary, { force: true }); }
        config = next;
        changed();
        return { configured: true, connected: true, baseUrl: next.baseUrl, account: safeAccount } satisfies Status;
      } finally { mutation = false; }
    }),
    ctx.handle("disconnect", () => {
      assertActive();
      fs.rmSync(credentialPath, { force: true });
      config = undefined;
      changed();
      return { configured: false, connected: false } satisfies Status;
    }),
    ctx.registerInstructions({ agents: ["prober", "teacher", "practice"], text: INSTRUCTIONS }),
    ctx.registerTools({ agents: ["prober", "teacher", "practice"], create: () => {
      let briefPages = 0;
      let briefBytes = 0;
      let pendingBrief: Promise<unknown> = Promise.resolve();
      const tools: AgentTool<any>[] = [
        { name: "vulpin_list_files", label: "Vulpin files", description: "Discover accessible Vulpin source descriptors and preparation status, lazily. Descriptors are not document content. Use nextCursor for another small batch.", parameters: listInput,
          execute: async (_id, input, signal) => {
            const value = object(input); const params = new URLSearchParams({ limit: String(boundedInteger(value.limit, 20, 50)) });
            if (value.query !== undefined) params.set("query", string(value.query, "query", 200));
            if (value.cursor !== undefined) params.set("cursor", string(value.cursor, "cursor"));
            return jsonResult(await call(`files?${params}`, undefined, signal));
          } },
        { name: "vulpin_search", label: "Search Vulpin", description: "Search Vulpin's existing lexical and vector index with 1–3 related queries. Returns bounded snippets, pageRefs and index coverage. Read the actual pages before relying on a source; no hits may reflect incomplete indexing.", parameters: searchInput,
          execute: async (_id, input, signal) => {
            const value = object(input);
            if (!Array.isArray(value.queries) || value.queries.length < 1 || value.queries.length > 3) throw new Error("Provide 1–3 queries");
            const body = { queries: value.queries.map(query => string(query, "query", 512)), limit: boundedInteger(value.limit, 6, 6), ...(value.courseId === undefined ? {} : { courseId: string(value.courseId, "course ID") }) };
            const result = await call("search", body, signal);
            if (!Array.isArray(result.results)) throw new Error("Vulpin returned invalid search results");
            return jsonResult({ ...result, results: result.results.map(raw => {
              const hit = object(raw);
              if (hit.kind !== "management") return hit;
              const { title: _title, pageNumber: _pageNumber, ...safe } = hit;
              return { ...safe, citationLabel: "School source" };
            }) });
          } },
        { name: "vulpin_read_pages", label: "Read Vulpin pages", description: "Read source page images for vision, at most 4 per call. Provide either pageRefs from search OR fileId and one-based page numbers. Cite returned titles/page numbers/pageRefs for own/shared sources; cite management sources only as 'School source'. Request fewer pages for image-heavy files. Unprepared or unauthorized sources fail honestly; source images are not text extraction.", parameters: readInput,
          execute: async (_id, input, signal) => {
            const value = object(input);
            let body: unknown;
            if (value.pageRefs !== undefined) {
              if (value.fileId !== undefined || value.pages !== undefined || value.expectedVersion !== undefined || !Array.isArray(value.pageRefs) || value.pageRefs.length < 1 || value.pageRefs.length > 4) throw new Error("Provide only 1–4 pageRefs, or fileId with 1–4 page numbers");
              body = { pageRefs: [...new Set(value.pageRefs.map(ref => string(ref, "page reference")))] };
            } else {
              if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 4) throw new Error("Provide fileId with 1–4 page numbers");
              if (value.expectedVersion !== undefined && (typeof value.expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(value.expectedVersion))) throw new Error("Invalid expectedVersion");
              body = { ...(value.expectedVersion === undefined ? {} : { expectedVersion: value.expectedVersion }), fileId: string(value.fileId, "file ID"), pages: [...new Set(value.pages.map(page => boundedInteger(page, 1, 800)))] };
            }
            const requested = body as { fileId?: string; pages?: number[]; pageRefs?: string[]; expectedVersion?: string };
            const result = await call("read", body, signal);
            if (!Array.isArray(result.pages) || result.pages.length < 1 || result.pages.length > 4) throw new Error("Vulpin returned an invalid page batch");
            const expectedCount = requested.pageRefs?.length ?? requested.pages!.length;
            if (result.pages.length !== expectedCount) throw new Error("Vulpin returned an incomplete page batch. No pages were accepted; retry a smaller batch.");
            const received = new Set<string | number>();
            const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
            const citations: Record<string, unknown>[] = [];
            for (const raw of result.pages) {
              const page = object(raw);
              if (page.mimeType !== "image/png" || typeof page.imageBase64 !== "string" || !page.imageBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(page.imageBase64)) throw new Error("Vulpin returned an invalid page image");
              const navigation = { fileId: string(page.fileId, "file ID"), pageRef: string(page.pageRef, "page reference"), pageNumber: boundedInteger(page.pageNumber, 1, 800), ...(page.title === undefined ? {} : { title: string(page.title, "title", 2000) }) };
              if (!["own", "shared", "management"].includes(String(page.kind)) || typeof page.sourceVersion !== "string" || !/^[0-9a-f]{64}$/.test(page.sourceVersion)) throw new Error("Vulpin returned invalid source identity metadata");
              if (requested.expectedVersion && page.sourceVersion !== requested.expectedVersion) throw new Error("Vulpin source version changed. Read the updated source before continuing.");
              const key = requested.pageRefs ? navigation.pageRef : navigation.pageNumber;
              if (received.has(key) || (requested.pageRefs ? !requested.pageRefs.includes(navigation.pageRef) : navigation.fileId !== requested.fileId || !requested.pages!.includes(navigation.pageNumber))) throw new Error("Vulpin returned pages that do not match the request");
              received.add(key);
              const citation = page.kind === "management"
                ? { fileId: navigation.fileId, pageRef: navigation.pageRef, sourceVersion: page.sourceVersion, kind: page.kind, citationLabel: "School source" }
                : { ...navigation, sourceVersion: page.sourceVersion, kind: page.kind };
              citations.push(citation);
              content.push({ type: "text", text: JSON.stringify(citation) }, { type: "image", data: page.imageBase64, mimeType: "image/png" });
            }
            content.unshift({ type: "text", text: "Vulpin source page images follow. Inspect them with vision; if your model cannot receive images, report that limitation. Cite own/shared title and page number/pageRef; management sources must be cited only as 'School source', without title, date or page numbers. Never provide storage/download links. Reuse sourceVersion as expectedVersion for later batches from a file. Only these pages have been read." });
            return { content, details: { pages: citations } };
          } },
        { name: "vulpin_list_outline", label: "Vulpin note outline",
          description: "Discover accessible Vulpin sections and their paths. Supply a returned folderId to list note titles, preparation status and versions in that section. Follow nextCursor with the same scope, even after an empty batch.",
          parameters: outlineInput,
          execute: async (_id, input, signal) => {
            const value = object(input);
            const result = await call("outline", {
              ...(value.folderId === undefined ? {} : { folderId: string(value.folderId, "folder ID") }),
              ...(value.cursor === undefined ? {} : { cursor: string(value.cursor, "cursor", PREVIEW_MAX_CURSOR_LENGTH) }),
              limit: boundedInteger(value.limit, 20, 50),
            }, signal);
            return jsonResult(result);
          } },
        { name: "vulpin_read_briefs", label: "Vulpin page previews",
          description: "Read existing page headings and short index descriptions as text. Supply either a discovered folderId or a fileId with its sourceVersion. Follow nextCursor with the same scope. Use previews for topic lists and outlines. Open ready pages with vulpin_read_pages using fileId, pageNumber and sourceVersion as expectedVersion before citing detailed claims.",
          parameters: briefsInput,
          execute: (_id, input, signal) => {
            const result = pendingBrief.then(async () => {
              signal?.throwIfAborted();
              if (briefPages >= BRIEF_TURN_PAGES || briefBytes >= BRIEF_TURN_BYTES) throw new Error("Vulpin page preview limit reached for this turn.");
              const value = object(input);
              let scope: { folderId: string } | { fileId: string; sourceVersion: string };
              if (value.folderId !== undefined) {
                if (value.fileId !== undefined || value.sourceVersion !== undefined) throw new Error("Provide either folderId or fileId with sourceVersion.");
                scope = { folderId: string(value.folderId, "folder ID") };
              } else {
                if (typeof value.sourceVersion !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceVersion)) throw new Error("Provide the file's sourceVersion from Vulpin discovery.");
                scope = { fileId: string(value.fileId, "file ID"), sourceVersion: value.sourceVersion };
              }
              const limit = Math.min(boundedInteger(value.limit, 20, 50), BRIEF_TURN_PAGES - briefPages);
              const maxBytes = BRIEF_TURN_BYTES - briefBytes;
              const response = await call("briefs", {
                ...scope, limit, maxBytes,
                ...(value.cursor === undefined ? {} : { cursor: string(value.cursor, "cursor", PREVIEW_MAX_CURSOR_LENGTH) }),
              }, signal);
              const output = jsonResult(response);
              const bytes = Buffer.byteLength(output.content[0]!.text);
              if (!Array.isArray(response.pages) || response.pages.length > limit || bytes > maxBytes) throw new Error("Vulpin returned an invalid or oversized page preview batch.");
              briefPages += response.pages.length;
              briefBytes += bytes;
              return output;
            });
            pendingBrief = result.catch(() => undefined);
            return result;
          } },
      ];
      return tools;
    } }),
  ];
  return () => { generation.abort(); for (const dispose of disposers.reverse()) dispose(); };
}
