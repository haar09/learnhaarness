import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CREDENTIAL_FILE } from "../src/contract.ts";
import { isSensitivePath, resolveSourcePath, walkFiles } from "../../../src/agent/tools/fs-shared.ts";
import { readTool } from "../../../src/agent/tools/read.ts";
import { findTool } from "../../../src/agent/tools/find.ts";
import { grepTool } from "../../../src/agent/tools/grep.ts";
test("file tools deny credential/temp paths, canonical aliases and discovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vulpin-secret-"));
  try {
    const credential = path.join(root, CREDENTIAL_FILE), temporary = `${credential}.tmp-12345678-1234-4123-8123-123456789abc`;
    for (const filename of [credential, temporary]) fs.writeFileSync(filename, '{"token":"vulpin-synthetic-secret-marker"}', { mode: 0o600 });
    const alias = path.join(root, "ordinary-notes.json"); fs.symlinkSync(credential, alias);
    fs.writeFileSync(path.join(root, "notes.md"), "ordinary geometry notes");
    for (const filename of [credential, temporary, alias]) { assert.throws(() => resolveSourcePath(filename), /protected location/); await assert.rejects(() => readTool.execute("read", { path: filename }), /protected location/); }
    assert.equal(isSensitivePath(credential), true);
    const discovered: string[] = []; await walkFiles(root, filename => { discovered.push(path.basename(filename)); return false; }); assert.deepEqual(discovered, ["notes.md"]);
    const found = await findTool.execute("find", { path: root, pattern: "**/*" }); assert.equal(JSON.stringify(found).includes(CREDENTIAL_FILE), false);
    const grep = await grepTool.execute("grep", { path: root, pattern: "vulpin-synthetic-secret-marker", literal: true }); assert.equal(JSON.stringify(grep).includes("vulpin-synthetic-secret-marker"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
