import type { Concurrency, DecoderOptions, DecoderStats, PacketTiming, PrerollReport, TimedFrame } from './types.js';
/** One stateful decoder. Submit complete picture packets serially in coded order. */
export declare class Decoder {
    #private;
    private constructor();
    static create(options?: DecoderOptions): Promise<Decoder>;
    get concurrency(): Concurrency;
    get maxPacketBytes(): number;
    get maxFrameBytes(): number;
    get maxReferenceBytes(): number;
    get stats(): DecoderStats;
    decode(bytes: Uint8Array, timing: PacketTiming): Promise<TimedFrame[]>;
    discardLeadingB(bytes: Uint8Array): Promise<PrerollReport>;
    finishSegment(): Promise<TimedFrame | undefined>;
    drain(): Promise<TimedFrame | undefined>;
    reset(): Promise<void>;
    cancel(reason?: unknown): void;
    close(): Promise<void>;
}
