import type { Frame } from './frame.js';
export type Concurrency = 0 | 1 | 2 | 4;
export interface DecoderOptions {
    /** Omit for capability/hardware selection. 0 performs CPU work in this realm. */
    concurrency?: Concurrency;
    maxPacketBytes?: number;
    maxFrameBytes?: number;
    /** Aborts initialization and the entire decoder lifetime. */
    signal?: AbortSignal;
}
export interface PacketTiming {
    timestamp: number;
    duration: number;
}
export interface TimedFrame extends PacketTiming {
    frame: Frame;
}
export interface PrerollReport {
    validation: 'headers-only';
    packetId: bigint;
    temporalReference: number;
    anchorTemporalReference: number;
}
export interface DecoderStats {
    readonly concurrency: Concurrency;
    readonly poolWorkers: number;
    readonly createdWorkers: number;
    readonly allocatedBytes: number;
    readonly peakBytes: number;
    readonly moduleInitMs: number;
    readonly poolStartupMs: number;
    readonly decoderSetupMs: number;
    readonly maxMemoryBytes?: number;
    /** Direct decoders share the lazily initialized scalar WASM instance. */
    readonly memoryScope?: string;
}
