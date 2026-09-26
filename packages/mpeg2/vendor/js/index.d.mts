// Local declarations for the unmodified mpeg2-rs packet facade; not generated Rust code.
import type { DecodedFrame } from '../pkg/mpeg2_wasm.js';
export { default as init, initSync } from '../pkg/mpeg2_wasm.js';

export type TimedFrame = { frame: DecodedFrame | undefined; timestamp: number; duration: number };
export interface PacketDecoder {
	readonly maxPacketBytes: number;
	readonly maxFrameBytes: number;
	readonly maxReferenceBytes: number;
	decode(input: Uint8Array, timing: { timestamp: number; duration: number }): TimedFrame[];
	drain(): TimedFrame | undefined;
	finishSegment(): TimedFrame | undefined;
	reset(): void;
	free(): void;
}
export function createPacketDecoder(options?: { maxPacketBytes?: number; maxFrameBytes?: number }): PacketDecoder;
