import type { UpdateStatus } from "../core/contracts/update-status.ts";

const REPOSITORY = "amosblomqvist/learnharness";
const TTL = 15 * 60 * 1000;
interface Release { id: number; tag_name: string; html_url: string; draft: boolean; prerelease: boolean }
function release(value: unknown): value is Release {
	if (!value || typeof value !== "object") return false;
	const r = value as Release;
	return Number.isSafeInteger(r.id) && typeof r.tag_name === "string" && typeof r.html_url === "string" && r.html_url.startsWith(`https://github.com/${REPOSITORY}/releases/`) && r.draft === false && r.prerelease === false;
}
export async function checkUpdates(version: string, commit: string | undefined, fetcher: typeof fetch = fetch): Promise<UpdateStatus> {
	const sha = commit && /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
	const result: UpdateStatus = { installed: { version, commit: sha }, latest: null, releasesBehind: null, errors: [], checkedAt: new Date().toISOString() };
	const deadline = Date.now() + 20000;
	async function github(path: string) {
		if (Date.now() >= deadline) throw new Error("Release check unavailable. Try again later.");
		const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "LearnHarness-update-check", "X-GitHub-Api-Version": "2022-11-28" },
			signal: AbortSignal.timeout(8000), cache: "no-store",
		});
		if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "GitHub rate limit reached. Try again later." : response.status === 404 ? "GitHub release information is unavailable." : "GitHub could not be reached. Try again later.");
		return response.json();
	}
	try {
		const latest: unknown = await github("releases/latest");
		if (!release(latest)) throw new Error("GitHub release information is unavailable.");
		result.latest = { version: latest.tag_name, url: latest.html_url };
		if (!sha) throw new Error("Installed commit is unknown; releases behind cannot be determined.");
		let count = 0;
		let foundLatest = false;
		const seen = new Set<number>();
		// A contained stable release is the installed baseline. Never use the
		// package version alone: unreleased main builds can share a release version.
		for (let page = 1; page <= 10; page++) {
			const entries: unknown = await github(`releases?per_page=100&page=${page}`);
			if (!Array.isArray(entries)) throw new Error("GitHub release list is unavailable.");
			for (const entry of entries) {
				if (!release(entry)) continue;
				if (!foundLatest) { if (entry.id !== latest.id) continue; foundLatest = true; }
				if (seen.has(entry.id)) throw new Error("Release list changed during the check. Try again later.");
				seen.add(entry.id);
				const comparison = await github(`compare/${encodeURIComponent(entry.tag_name)}...${sha}`);
				if (comparison.status === "identical" || comparison.status === "ahead") {
					result.releasesBehind = count;
					return result;
				}
				if (comparison.status !== "behind") throw new Error("Installed build has diverged from stable releases; releases behind is unknown.");
				count++;
			}
			if (entries.length < 100) break;
		}
		throw new Error("A stable release baseline could not be verified; releases behind is unknown.");
	} catch (error) {
		result.errors.push(error instanceof Error && /^(GitHub|Installed|Release list|A stable)/.test(error.message) ? error.message : "Release check unavailable. Try again later.");
	}
	return result;
}

let cached: { expires: number; value: Promise<UpdateStatus> } | undefined;
export function updateStatus(): Promise<UpdateStatus> {
	if (!cached || Date.now() >= cached.expires) {
		cached = { expires: Date.now() + TTL, value: checkUpdates(process.env.LH_VERSION ?? "unknown", process.env.LH_BUILD_COMMIT) };
	}
	return cached.value;
}
