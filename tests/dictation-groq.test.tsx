import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { DICTATION_ACTIVE_ELSEWHERE, DICTATION_KEYLESS, useDictation, type Dictation } from "../components/dictation.tsx";
import { DICTATION_LIMIT_MESSAGE, DICTATION_MAX_PCM_BYTES } from "../components/dictation-audio.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { isDictationActive } from "../components/dictation-state.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class AudioGraph {
	state = "running"; destination = {}; audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Socket { static OPEN = 1; static CONNECTING = 0; constructor() { assert.fail("Groq must not open a Deepgram socket"); } }
class Worklet {
	static all: Worklet[] = []; static tail = new Int16Array(); static acknowledge = true;
	flushes = 0; disconnected = false;
	port = {
		onmessage: null as ((event: { data: unknown }) => void) | null,
		postMessage: () => {
			this.flushes++;
			if (!Worklet.acknowledge) return;
			queueMicrotask(() => { if (Worklet.tail.length) this.audio(Worklet.tail); this.port.onmessage?.({ data: { type: "flushed" } }); });
		},
	};
	constructor() { Worklet.all.push(this); }
	connect() {} disconnect() { this.disconnected = true; }
	audio(buffer: Int16Array) { this.port.onmessage?.({ data: { type: "audio", buffer } }); }
}
let dispose: (() => Promise<void>) | undefined, restore: (() => void) | undefined;
async function fixture() {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		provider: "groq" as "groq" | "deepgram" | null, config: undefined as Promise<Response> | undefined,
		mic: undefined as Promise<{ getTracks: () => { stop: () => void }[] }> | undefined,
		transcript: undefined as Promise<Response> | undefined, fail: false, captures: 0, stops: 0, tokens: 0,
		appends: [] as string[], other: [] as string[], uploads: [] as { url: string; body: Blob; signal: AbortSignal }[],
		deliver: undefined as ((text: string) => Promise<void>) | undefined,
	};
	Worklet.all = []; Worklet.tail = new Int16Array(); Worklet.acknowledge = true;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => { state.captures++; return state.mic ?? { getTracks: () => [{ stop() { state.stops++; } }] }; } } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "tr-TR" } } });
			if (url === "/api/stt/config") return state.config ?? Response.json({ provider: state.provider, ...(state.provider === "groq" ? { model: "whisper-large-v3-turbo" } : {}) });
			if (url === "/api/stt/token") { state.tokens++; return Response.json({ token: "unused-token" }); }
			assert.equal(url, "/api/stt/transcribe?language=tr-TR"); assert.equal(init?.method, "POST");
			assert.equal((init?.headers as Record<string, string>)["Content-Type"], "audio/wav"); assert.ok(state.stops > 0, "microphone stops before upload");
			state.uploads.push({ url, body: init!.body as Blob, signal: init!.signal as AbortSignal });
			return state.transcript ?? (state.fail ? Response.json({ message: "Groq transcription unavailable" }, { status: 502 }) : Response.json({ text: "Merhaba dünya" }));
		},
	})) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
	restore = () => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; } };
	let latest!: Dictation, other!: Dictation;
	function Harness() {
		latest = useDictation({ append: text => { if (state.deliver) return state.deliver(text); state.appends.push(text); } });
		other = useDictation({ destination: "explicit", append: text => { state.other.push(text); } }); return null;
	}
	const { createRoot } = await import("react-dom/client"); const root = createRoot(document.getElementById("root")!);
	dispose = async () => { await act(async () => { root.unmount(); }); };
	await act(async () => { root.render(<Harness />); }); await act(async () => { notifySettingsSaved("dictation"); });
	return { state, get dictation() { return latest; }, get other() { return other; }, get worklet() { return Worklet.all.at(-1)!; }, unmount: () => dispose!() };
}
afterEach(async () => { await dispose?.(); restore?.(); dispose = restore = undefined; });
const frame = () => new Int16Array(200).fill(42);

test("Groq stop uploads one WAV including final worklet tail, and all finish waiters await transcription exactly once", async () => {
	const f = await fixture(), response = deferred<Response>(); f.state.transcript = response.promise;
	await act(async () => { f.dictation.toggle(); }); assert.equal(f.dictation.phase, "recording"); assert.equal(f.state.tokens, 0);
	Worklet.tail = new Int16Array([123, -456]); await act(async () => { f.worklet.audio(frame()); });
	let first!: Promise<void>, second!: Promise<void>; let finished = false;
	await act(async () => { first = f.dictation.finish().then(() => { finished = true; }); second = f.dictation.finish(); f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping"); assert.equal(finished, false); assert.equal(f.state.uploads.length, 1); assert.equal(f.worklet.flushes, 1);
	assert.equal(f.state.stops, 1); assert.deepEqual(f.state.appends, []);
	const wav = await f.state.uploads[0]!.body.arrayBuffer(); assert.equal(wav.byteLength, 44 + 404); assert.deepEqual(Array.from(new Int16Array(wav, wav.byteLength - 4)), [123, -456]);
	await act(async () => { response.resolve(Response.json({ text: "  Merhaba dünya  " })); await Promise.all([first, second]); });
	assert.equal(finished, true); assert.deepEqual(f.state.appends, ["Merhaba dünya"]); assert.equal(isDictationActive(), false);
	await f.dictation.finish(); assert.equal(f.state.uploads.length, 1); assert.equal(f.state.tokens, 0);
});

test("failed Groq transcription rejects finish and preserves the existing draft without provider retry", async () => {
	const f = await fixture(); f.state.fail = true;
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.worklet.audio(frame()); });
	await act(async () => { await assert.rejects(f.dictation.finish(), /Groq transcription unavailable/); });
	assert.deepEqual(f.state.appends, []); assert.match(f.dictation.error!, /unavailable/); assert.equal(f.state.tokens, 0);
	await assert.rejects(f.dictation.finish(), /unavailable/);
});

for (const action of ["cancel", "unmount"] as const) test(`${action} during upload aborts finish and ignores late transcription`, async () => {
	const f = await fixture(), response = deferred<Response>(); f.state.transcript = response.promise;
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.worklet.audio(frame()); });
	let finished!: Promise<unknown>; await act(async () => { finished = f.dictation.finish().then(() => assert.fail("must not send old draft"), error => error); });
	assert.equal(f.state.uploads.length, 1);
	if (action === "cancel") await act(async () => { f.dictation.cancel(); }); else await f.unmount();
	const error = await finished; assert.ok(error instanceof DOMException); assert.equal(error.name, "AbortError"); assert.equal(f.state.uploads[0]!.signal.aborted, true);
	if (action === "cancel") { await act(async () => { f.other.toggle(); }); assert.equal(isDictationActive(), true); }
	await act(async () => { response.resolve(Response.json({ text: "late words" })); }); assert.deepEqual(f.state.appends, []);
	if (action === "cancel") assert.equal(isDictationActive(), true, "late upload cannot release a newer owner's capture");
});

test("cancel and empty stop never upload, while a too-short nonempty recording fails locally", async () => {
	const f = await fixture(); await act(async () => { f.dictation.toggle(); f.dictation.cancel(); }); assert.equal(f.state.uploads.length, 0);
	await act(async () => { f.dictation.toggle(); }); await act(async () => { await f.dictation.finish(); }); assert.equal(f.state.uploads.length, 0);
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.worklet.audio(new Int16Array([1])); });
	await act(async () => { await assert.rejects(f.dictation.finish(), /too short/); }); assert.equal(f.state.uploads.length, 0);
});

test("config gates microphone capture, cancellation fences late settings, and saved keys select Groq without token premint", async () => {
	const f = await fixture(), config = deferred<Response>(); f.state.config = config.promise;
	await act(async () => { f.dictation.toggle(); }); assert.equal(f.state.captures, 0);
	await act(async () => { f.dictation.cancel(); config.resolve(Response.json({ provider: "groq" })); }); assert.equal(f.state.captures, 0);
	f.state.config = undefined; f.state.provider = null;
	await act(async () => { f.dictation.toggle(); }); assert.equal(f.dictation.error, DICTATION_KEYLESS); assert.equal(f.state.captures, 0);
	f.state.provider = "groq"; await act(async () => { notifySettingsSaved("keys"); f.dictation.toggle(); });
	assert.equal(f.state.captures, 1); assert.equal(f.state.tokens, 0);
});

test("late microphone permission is stopped after cancel; capture ownership remains exclusive", async () => {
	const f = await fixture(), mic = deferred<{ getTracks: () => { stop: () => void }[] }>(); f.state.mic = mic.promise;
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.other.toggle(); }); assert.equal(f.other.error, DICTATION_ACTIVE_ELSEWHERE);
	await act(async () => { f.dictation.cancel(); mic.resolve({ getTracks: () => [{ stop() { f.state.stops++; } }] }); });
	assert.equal(f.state.stops, 1); assert.equal(Worklet.all.length, 0); assert.equal(f.state.uploads.length, 0);
});

test("Groq finish also awaits asynchronous transcript delivery", async () => {
	const f = await fixture(), delivery = deferred<void>(); let draft = "old", sent: string | undefined;
	f.state.deliver = async text => { await delivery.promise; draft = text; };
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.worklet.audio(frame()); });
	let finish!: Promise<void>; await act(async () => { finish = f.dictation.finish().then(() => { sent = draft; }); });
	assert.equal(f.dictation.phase, "stopping"); assert.equal(sent, undefined);
	await act(async () => { delivery.resolve(); await finish; }); assert.equal(sent, "Merhaba dünya");
});

test("the bounded recording auto-stops at ten minutes with an explicit notice and a valid maximum WAV", async () => {
	const f = await fixture(); await act(async () => { f.dictation.toggle(); }); await act(async () => { f.worklet.audio(new Int16Array(DICTATION_MAX_PCM_BYTES / 2)); });
	assert.equal(f.state.stops, 1); assert.equal(f.state.uploads.length, 1); assert.equal(f.state.uploads[0]!.body.size, DICTATION_MAX_PCM_BYTES + 44);
	assert.equal(f.dictation.error, DICTATION_LIMIT_MESSAGE); assert.deepEqual(f.state.appends, ["Merhaba dünya"]);
});

test("missing worklet flush acknowledgement fails finish rather than uploading a truncated ending", async () => {
	const f = await fixture(); Worklet.acknowledge = false;
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.worklet.audio(frame()); });
	await act(async () => { await assert.rejects(f.dictation.finish(), /Could not finish microphone capture/); });
	assert.equal(f.state.uploads.length, 0); assert.equal(isDictationActive(), false);
});
