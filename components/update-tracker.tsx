"use client";

import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { UpdateStatus } from "@/src/core";

export function UpdateTracker() {
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(false);
	async function refresh() {
		setLoading(true); setError(false);
		try { const response = await fetch("/api/update-status"); if (!response.ok) throw new Error(); setStatus(await response.json()); }
		catch { setError(true); }
		finally { setLoading(false); }
	}
	useEffect(() => { void refresh(); }, []);
	const behind = status?.releasesBehind;
	const label = !status ? "Updates" : behind == null ? "Release status unknown" : behind === 0 ? "Latest release" : `${behind} releases behind`;
	return <details className="relative min-w-0 text-xs text-muted-foreground" data-testid="update-tracker">
		<summary className="cursor-pointer list-none rounded-md px-2 py-1.5 transition-colors hover:bg-accent hover:text-foreground" aria-label="Application updates">{label}</summary>
		<div className="absolute bottom-full right-0 z-50 mb-2 w-64 space-y-3 rounded-xl border bg-card p-4 text-foreground shadow-xl">
			<p className="font-medium">Application updates</p>
			{status && <>
				<p>Installed: v{status.installed.version} (custom build)<br /><span className="text-muted-foreground">{status.installed.commit ? status.installed.commit.slice(0, 12) : "Commit unknown"}</span></p>
				<p>Latest release: {status.latest ? <a className="underline" href={status.latest.url} target="_blank" rel="noreferrer">{status.latest.version}</a> : "Unavailable"}</p>
				<p>Releases behind: {status.releasesBehind === null ? "Unknown" : status.releasesBehind}</p>
				{status.errors.map((message, index) => <p key={index} role="status" className="text-muted-foreground">{message}</p>)}
				<p className="text-muted-foreground">Checked {new Date(status.checkedAt).toLocaleString()}. Stable releases only. Checks are cached for 15 minutes. Updates are installed manually.</p>
			</>}
			{error && <p role="status">Update check unavailable. Try again later.</p>}
			<button type="button" disabled={loading} onClick={() => void refresh()} className="flex items-center gap-2 rounded border px-2 py-1 disabled:opacity-50"><RefreshCwIcon className="size-3" />{loading ? "Checking…" : "Check status"}</button>
		</div>
	</details>;
}
