import manifest from "../../vendor/fsrs/manifest.json";

export const REVIEW_ENGINE = manifest;
export interface ReviewMemory { stability: number; difficulty: number }
export interface FsrsItemState { memory: ReviewMemory; interval: number }
export interface FsrsStates { again: FsrsItemState; hard: FsrsItemState; good: FsrsItemState; easy: FsrsItemState }
export interface ReviewEngine {
	nextStates(memory: ReviewMemory | null, days: number, retention?: number): FsrsStates;
}

interface EngineExports {
	memory: WebAssembly.Memory;
	lh_alloc(length: number): number;
	lh_free(pointer: number, length: number): void;
	lh_next(pointer: number, length: number): bigint;
}

/** The same pinned upstream WASM bytes run in the browser and on the host. */
export async function createReviewEngine(bytes: Uint8Array): Promise<ReviewEngine> {
	const data = bytes.slice().buffer;
	const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(value => value.toString(16).padStart(2, "0")).join("");
	if (hash !== manifest.sha256) throw new Error("The scheduling engine failed its integrity check. Reconnect and reload.");
	const { instance } = await WebAssembly.instantiate(data);
	const wasm = instance.exports as unknown as EngineExports;
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	return {
		nextStates(memory, days, retention = 0.9) {
			const input = encoder.encode(JSON.stringify({ memory, days, retention }));
			const pointer = wasm.lh_alloc(input.length);
			let resultPointer = 0;
			let resultLength = 0;
			try {
				new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
				const result = BigInt.asUintN(64, wasm.lh_next(pointer, input.length));
				resultPointer = Number(result >> 32n);
				resultLength = Number(result & 0xffffffffn);
				const parsed = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, resultPointer, resultLength))) as { ok?: FsrsStates; error?: string };
				if (!parsed.ok) throw new Error(parsed.error ?? "The scheduling engine returned no result.");
				return parsed.ok;
			} finally {
				wasm.lh_free(pointer, input.length);
				if (resultLength) wasm.lh_free(resultPointer, resultLength);
			}
		},
	};
}
