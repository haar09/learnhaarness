import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GROQ_STT_MODEL, MAX_DICTATION_WAV_BYTES, sttConfig, transcribeDictation } from "../src/server/stt.ts";

function wav(samples = 320) {
	const audio = new Uint8Array(44 + samples * 2);
	const view = new DataView(audio.buffer);
	const tag = (offset: number, text: string) => [...text].forEach((c, i) => audio[offset + i] = c.charCodeAt(0));
	tag(0, "RIFF"); tag(8, "WAVE"); tag(12, "fmt "); tag(36, "data");
	view.setUint32(4, audio.length - 8, true); view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
	view.setUint16(32, 2, true); view.setUint16(34, 16, true);
	view.setUint32(40, samples * 2, true);
	return audio;
}
function request(language = "tr-TR", body: BodyInit = wav(), headers: HeadersInit = {}, signal?: AbortSignal) {
	return new Request(`http://localhost/api/stt/transcribe?language=${language}`, {
		method: "POST", headers: { "Content-Type": "audio/wav", ...headers }, body, signal,
		// Required by Node for the chunked input test.
		...(body instanceof ReadableStream ? { duplex: "half" } : {}),
	});
}
const key = (id: string) => id === "GROQ_API_KEY" ? "server-only-secret" : undefined;
const neverFetch: typeof fetch = async () => { throw new Error("must not contact provider"); };

describe("Groq dictation server", () => {
	it("config prefers Groq, retains Deepgram, and exposes no secrets", () => {
		assert.deepEqual(sttConfig(() => undefined), { provider: null });
		assert.deepEqual(sttConfig(id => id === "DEEPGRAM_API_KEY" ? "secret" : undefined), { provider: "deepgram" });
		assert.deepEqual(sttConfig(() => "secret"), { provider: "groq", model: GROQ_STT_MODEL });
	});
	it("missing key fails without reading audio or contacting Groq", async () => {
		const response = await transcribeDictation(request(), () => undefined, neverFetch);
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("cache-control"), "no-store");
	});
	it("forwards WAV as multipart with server-held key and normalized Turkish; returns only text", async () => {
		let calls = 0;
		const response = await transcribeDictation(request(), key, async (url, options) => {
			calls++;
			assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
			assert.equal(options?.method, "POST");
			assert.equal(new Headers(options?.headers).get("authorization"), "Bearer server-only-secret");
			assert.ok(options?.signal instanceof AbortSignal);
			const body = options?.body as FormData;
			assert.equal(body.get("model"), "whisper-large-v3-turbo");
			assert.equal(body.get("language"), "tr");
			assert.equal(body.get("response_format"), "json");
			assert.equal((body.get("file") as File).type, "audio/wav");
			assert.deepEqual(new Uint8Array(await (body.get("file") as File).arrayBuffer()), wav());
			return Response.json({ text: " Merhaba dünya. ", other: "private provider metadata" });
		});
		assert.equal(calls, 1);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { text: "Merhaba dünya." });
		assert.equal(response.headers.get("cache-control"), "no-store");
	});
	it("multilingual omits language, and empty recognized speech is valid", async () => {
		const response = await transcribeDictation(request("multi"), key, async (_url, options) => {
			assert.equal((options?.body as FormData).has("language"), false);
			return Response.json({ text: "" });
		});
		assert.deepEqual(await response.json(), { text: "" });
	});
	it("rejects malformed audio, bad language, MIME and oversized requests before provider calls", async () => {
		const stereo = wav(); new DataView(stereo.buffer).setUint16(22, 2, true);
		const wrongSize = wav(); new DataView(wrongSize.buffer).setUint32(40, 20, true);
		const cases: [Request, number][] = [
			[request("not-a-language"), 400],
			[request("tr", wav(), { "Content-Type": "text/plain" }), 415],
			[request("tr", new Uint8Array()), 400], [request("tr", wav(100)), 400],
			[request("tr", stereo), 400], [request("tr", wrongSize), 400],
			[request("tr", wav(), { "Content-Length": String(MAX_DICTATION_WAV_BYTES + 1) }), 413],
		];
		for (const [input, status] of cases) assert.equal((await transcribeDictation(input, key, neverFetch)).status, status);
	});
	it("enforces size while reading even with no Content-Length and cancels overflow stream", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) { controller.enqueue(new Uint8Array(1_000_000)); },
			cancel() { cancelled = true; },
		});
		assert.equal((await transcribeDictation(request("tr", body), key, neverFetch)).status, 413);
		assert.equal(cancelled, true);
	});
	it("provider errors never expose raw response or credentials and are never retried", async () => {
		for (const status of [400, 401, 403, 429, 500]) {
			let calls = 0;
			const result = await transcribeDictation(request(), key, async () => {
				calls++;
				return new Response("server-only-secret raw provider details", { status });
			});
			assert.equal(calls, 1);
			assert.equal(result.status, status === 429 ? 429 : 502);
			assert.doesNotMatch(await result.text(), /server-only-secret|raw provider details/);
		}
	});
	it("handles malformed provider responses, network failure, and timeout", async () => {
		for (const result of [Response.json({ unexpected: true }), new Response("invalid json")]) {
			assert.equal((await transcribeDictation(request(), key, async () => result)).status, 502);
		}
		assert.equal((await transcribeDictation(request(), key, async () => { throw new Error("private network detail"); })).status, 502);
		assert.equal((await transcribeDictation(request(), key, async () => { throw new DOMException("timeout", "TimeoutError"); })).status, 504);
	});
	it("aborted requests do not start a provider call", async () => {
		const controller = new AbortController(); controller.abort();
		assert.equal((await transcribeDictation(request("tr", wav(), {}, controller.signal), key, neverFetch)).status, 499);
	});
	it("cancelling the request aborts an in-flight provider call", async () => {
		const controller = new AbortController();
		const result = await transcribeDictation(request("tr", wav(), {}, controller.signal), key, async (_url, options) => {
			controller.abort();
			assert.equal(options?.signal?.aborted, true);
			throw new DOMException("cancelled", "AbortError");
		});
		assert.equal(result.status, 499);
	});
	it("cancelling a stalled upload cancels its reader without a provider call", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(stream) { stream.enqueue(wav().slice(0, 44)); },
			cancel() { cancelled = true; },
		});
		const pending = transcribeDictation(request("tr", body, {}, controller.signal), key, neverFetch);
		controller.abort();
		assert.equal((await pending).status, 499);
		assert.equal(cancelled, true);
	});
});
