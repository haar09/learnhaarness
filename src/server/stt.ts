import { isDictationLanguage } from "../core/dictation";

export const GROQ_STT_MODEL = "whisper-large-v3-turbo";
const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
// Mono, 16 kHz, signed PCM16: ten minutes plus the canonical WAV header.
export const MAX_DICTATION_WAV_BYTES = 16_000 * 2 * 600 + 44;
const NO_STORE = { "Cache-Control": "no-store" };

type KeyReader = (id: string) => string | undefined | null;

/** Readiness only: never mint tokens or expose the saved credential. */
export function sttConfig(readKey: KeyReader) {
	if (readKey("GROQ_API_KEY")) return { provider: "groq", model: GROQ_STT_MODEL };
	return { provider: readKey("DEEPGRAM_API_KEY") ? "deepgram" : null };
}

class SttError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
	signal?.throwIfAborted();
	if (!stream) return new Uint8Array();
	const reader = stream.getReader();
	const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
	signal?.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new SttError(413, "Dictation recording exceeds the 10-minute limit.");
			}
			chunks.push(value);
		}
	} finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return bytes;
}

/** Accept only the PCM format produced by our recorder, not arbitrary uploads. */
function validateWav(bytes: Uint8Array) {
	const invalid = () => { throw new SttError(400, "Invalid recording. Record mono 16 kHz PCM16 WAV audio."); };
	// Groq's minimum audio length is 0.01 seconds (160 samples).
	if (bytes.length < 44 + 320) return invalid();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (offset: number, value: string) => [...value].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
	if (!tag(0, "RIFF") || !tag(8, "WAVE") || !tag(12, "fmt ") || !tag(36, "data") ||
		view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 ||
		view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
		view.getUint32(24, true) !== 16_000 || view.getUint32(28, true) !== 32_000 ||
		view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
		view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2 !== 0) invalid();
}

/** Server-side OpenAI-compatible Whisper transport. Audio is never persisted. */
export async function transcribeDictation(
	request: Request,
	readKey: KeyReader,
	transport: typeof fetch = fetch,
): Promise<Response> {
	const fail = (status: number, message: string) => Response.json({ message }, { status, headers: NO_STORE });
	const key = readKey("GROQ_API_KEY");
	if (!key) return fail(503, "Add a Groq API key in Settings → Keys → Dictation.");
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "audio/wav") {
		return fail(415, "Dictation expects audio/wav.");
	}
	const length = Number(request.headers.get("content-length") ?? 0);
	if (!Number.isFinite(length) || length < 0) return fail(400, "Invalid recording length.");
	if (length > MAX_DICTATION_WAV_BYTES) return fail(413, "Dictation recording exceeds the 10-minute limit.");
	const language = new URL(request.url).searchParams.get("language") ?? "multi";
	if (!isDictationLanguage(language)) return fail(400, "Unsupported dictation language.");
	try {
		const uploadSignal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
		const audio = await readLimited(request.body, MAX_DICTATION_WAV_BYTES, uploadSignal);
		validateWav(audio);
		request.signal.throwIfAborted();
		const form = new FormData();
		form.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
		form.set("model", GROQ_STT_MODEL);
		form.set("response_format", "json");
		if (language !== "multi") form.set("language", language.split("-")[0]!);
		const providerSignal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
		const response = await transport(GROQ_STT_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			body: form,
			// No retries: a recording must never incur duplicate transcription charges.
			signal: providerSignal,
		});
		if (!response.ok) {
			await response.body?.cancel();
			if (response.status === 401 || response.status === 403) return fail(502, "Groq rejected the API key. Check the key and model access in Settings.");
			if (response.status === 429) return fail(429, "Groq rate or quota limit reached. Check your Groq account and try again later.");
			return fail(502, `Groq transcription failed (${response.status}). Please try recording again.`);
		}
		// Do not proxy arbitrary provider bodies (which may include request details).
		const body = await readLimited(response.body, 2_000_000, providerSignal).catch(error => {
			if (error instanceof SttError) throw new SttError(502, "Invalid Groq transcription response.");
			throw error;
		});
		const data: unknown = JSON.parse(new TextDecoder().decode(body));
		if (typeof data !== "object" || data === null || !("text" in data) || typeof data.text !== "string") {
			return fail(502, "Groq returned no transcription text.");
		}
		return Response.json({ text: data.text.trim() }, { headers: NO_STORE });
	} catch (error) {
		if (error instanceof SttError) return fail(error.status, error.message);
		if (request.signal.aborted) return fail(499, "Dictation cancelled.");
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			return fail(504, "Groq transcription timed out. Please try recording again.");
		}
		return fail(502, "Groq transcription unavailable. Please try recording again.");
	}
}
