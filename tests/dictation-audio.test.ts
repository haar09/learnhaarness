import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { createPcmRecording, DICTATION_MAX_PCM_BYTES } from "../components/dictation-audio.ts";

test("PCM WAV preserves view offsets, sample order and the canonical mono16k16bit header", async () => {
	const recording = createPcmRecording();
	const samples = new Int16Array([123, -32768, 0, 32767, 456]);
	recording.append(samples.subarray(1, 4));
	samples.fill(0);
	const blob = recording.wav(); assert.equal(blob.type, "audio/wav");
	const bytes = await blob.arrayBuffer(), view = new DataView(bytes);
	const word = (offset: number) => new TextDecoder().decode(bytes.slice(offset, offset + 4));
	assert.equal(word(0), "RIFF"); assert.equal(word(8), "WAVE"); assert.equal(word(12), "fmt "); assert.equal(word(36), "data");
	assert.equal(view.getUint32(4, true), 42); assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1);
	assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint32(28, true), 32000);
	assert.equal(view.getUint16(32, true), 2); assert.equal(view.getUint16(34, true), 16); assert.equal(view.getUint32(40, true), 6);
	assert.deepEqual(Array.from(new Int16Array(bytes, 44)), [-32768, 0, 32767]);
});

test("bounded PCM storage explicitly signals the ten-minute limit without retaining oversized frames", async () => {
	assert.equal(DICTATION_MAX_PCM_BYTES, 19_200_000);
	const recording = createPcmRecording(6);
	assert.equal(recording.append(new Int16Array([1, 2])), true);
	assert.equal(recording.append(new Int16Array([3, 4, 5])), false);
	assert.equal(recording.append(new Int16Array([6])), false);
	assert.equal(recording.byteLength, 6);
	assert.deepEqual(Array.from(new Int16Array(await recording.wav().arrayBuffer(), 44)), [1, 2, 3]);
	assert.throws(() => recording.append(new Uint8Array(1)), /Invalid PCM/);
});

test("worklet flush emits the partial final frame before acknowledgement, once, and stops producing audio", () => {
	let Constructor!: new () => { port: { onmessage: (event: unknown) => void }; process: (inputs: Float32Array[][]) => boolean };
	const messages: { type: string; buffer?: Int16Array }[] = [];
	const context = vm.createContext({
		AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (message: { type: string; buffer?: Int16Array }) => messages.push(message) }; },
		registerProcessor(_name: string, constructor: typeof Constructor) { Constructor = constructor; },
	});
	vm.runInContext(fs.readFileSync(new URL("../public/worklets/pcm-capture.js", import.meta.url), "utf8"), context);
	const worklet = new Constructor();
	worklet.process([[new Float32Array([0.5, -1, 0])]]);
	worklet.port.onmessage({ data: { type: "flush" } });
	assert.deepEqual(messages.map(message => message.type), ["level", "audio", "flushed"]);
	assert.deepEqual(Array.from(messages[1]!.buffer!), [16383, -32768, 0]);
	worklet.process([[new Float32Array([1])]]);
	worklet.port.onmessage({ data: { type: "flush" } });
	assert.equal(messages.filter(message => message.type === "audio").length, 1);
});
