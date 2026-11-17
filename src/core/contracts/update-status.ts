export interface UpdateStatus {
	installed: { version: string; commit: string | null };
	latest: { version: string; url: string } | null;
	releasesBehind: number | null;
	errors: string[];
	checkedAt: string;
}
