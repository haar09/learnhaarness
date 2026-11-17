/** Browser-safe PCM/WAV boundary shared by microphone capture and upload tests. */
export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_MIN_PCM_BYTES = 320; // Groq requires at least 0.01 seconds.
export const DICTATION_MAX_SECONDS = 10 * 60;
export const DICTATION_MAX_PCM_BYTES = DICTATION_SAMPLE_RATE * 2 * DICTATION_MAX_SECONDS;
export const DICTATION_LIMIT_MESSAGE = "10-minute dictation limit reached. Recording stopped; start a new dictation to continue.";
export type PcmChunk = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

/** Keeps only the permitted recording, without retaining oversized backing buffers.
 * Reaching the boundary signals the caller to stop immediately and tell the user. */
export function createPcmRecording(maxBytes = DICTATION_MAX_PCM_BYTES) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes % 2) throw new Error("Invalid PCM recording limit");
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let byteLength = 0;
	return {
		get byteLength() { return byteLength; },
		append(chunk: PcmChunk): boolean {
			const input = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			if (input.byteLength % 2) throw new Error("Invalid PCM audio frame");
			const take = Math.min(input.byteLength, maxBytes - byteLength);
			if (take) { chunks.push(input.slice(0, take)); byteLength += take; }
			return byteLength < maxBytes;
		},
		wav(): Blob {
			const header = new ArrayBuffer(44);
			const view = new DataView(header);
			const word = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
			word(0, "RIFF"); view.setUint32(4, 36 + byteLength, true); word(8, "WAVE");
			word(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
			view.setUint16(22, 1, true); view.setUint32(24, DICTATION_SAMPLE_RATE, true);
			view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
			word(36, "data"); view.setUint32(40, byteLength, true);
			return new Blob([header, ...chunks], { type: "audio/wav" });
		},
	};
}
