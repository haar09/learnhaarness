import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUpdates } from "../src/server/update-status.ts";
const commit = "a".repeat(40);
const release = (id: number, extra = {}) => ({ id, tag_name: `v${id}`, html_url: `https://github.com/amosblomqvist/learnharness/releases/tag/v${id}`, draft: false, prerelease: false, ...extra });
function mock(entries: unknown[], states: Record<string, string>): typeof fetch {
	return (async (url: string | URL | Request) => {
		const path = String(url);
		if (path.endsWith("releases/latest")) return Response.json(release(3));
		if (path.includes("releases?")) return Response.json(entries);
		const tag = path.split("compare/")[1]?.split("...")[0] ?? "";
		return Response.json({ status: states[tag] });
	}) as typeof fetch;
}
test("counts stable releases until verified contained baseline, excluding drafts and prereleases", async () => {
	const result = await checkUpdates("0.6.1", commit, mock([release(4, { prerelease: true }), release(3), release(8, { draft: true }), release(2), release(1)], { v3: "behind", v2: "behind", v1: "ahead" }));
	assert.equal(result.releasesBehind, 2);
	assert.equal(result.latest?.version, "v3");
});
test("installed main ahead of latest stable release is zero releases behind", async () => {
	for (const status of ["ahead", "identical"]) {
		const result = await checkUpdates("0.6.1", commit, mock([release(3)], { v3: status }));
		assert.equal(result.releasesBehind, 0);
	}
});
test("unknown SHA, divergent build, and unverified baseline never fabricate zero", async () => {
	assert.equal((await checkUpdates("0.6.1", undefined, mock([], {}))).releasesBehind, null);
	for (const status of ["diverged", "behind", "unexpected"]) {
		const result = await checkUpdates("0.6.1", commit, mock([release(3)], { v3: status }));
		assert.equal(result.releasesBehind, null);
		assert.ok(result.errors.length);
	}
});
test("paginates release list rather than truncating the count", async () => {
	const first = [release(3), ...Array.from({ length: 99 }, (_, id) => release(100 + id, { prerelease: true }))];
	const base = mock(first, { v3: "behind", v2: "ahead" });
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => String(url).includes("page=2") ? Response.json([release(2)]) : base(url, init)) as typeof fetch;
	assert.equal((await checkUpdates("0.6.1", commit, fetcher)).releasesBehind, 1);
});
test("rate limits and offline checks retain unavailable status", async () => {
	for (const fetcher of [(async () => new Response(null, { status: 403 })) as typeof fetch, (async () => { throw new Error("offline"); }) as typeof fetch]) {
		const result = await checkUpdates("0.6.1", commit, fetcher);
		assert.equal(result.releasesBehind, null);
		assert.ok(result.errors.length);
	}
});
