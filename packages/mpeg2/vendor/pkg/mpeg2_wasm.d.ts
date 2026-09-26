/* tslint:disable */
/* eslint-disable */

/**
 * Owns untaken frames. free() releases them; takeFrame() transfers ownership.
 */
export class DecodedBatch {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    takeFrame(): DecodedFrame | undefined;
    readonly frameCount: number;
}

/**
 * Owns one frame. Each take-plane method returns an independent JS Uint8Array
 * and relinquishes its Rust vector. Calling it again returns an empty array.
 */
export class DecodedFrame {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    takeCb(): Uint8Array;
    takeCr(): Uint8Array;
    takeY(): Uint8Array;
    readonly cbStride: number;
    readonly chromaFormat: string;
    readonly chromaHeight: number;
    readonly chromaWidth: number;
    readonly codedHeight: number;
    readonly codedWidth: number;
    readonly colorMatrix: number | undefined;
    readonly colorPrimaries: number | undefined;
    readonly colorTransfer: number | undefined;
    readonly crStride: number;
    readonly frameRateDenominator: number;
    readonly frameRateNumerator: number;
    readonly height: number;
    readonly pixelAspectDenominator: number;
    readonly pixelAspectNumerator: number;
    readonly progressiveSequence: boolean;
    readonly progressive: boolean;
    readonly temporalReference: number;
    readonly topFieldFirst: boolean;
    readonly width: number;
    readonly yStride: number;
}

/**
 * Complete-picture packet input. Timings are transport metadata, never codec ordering.
 */
export class PacketVideoDecoder {
    free(): void;
    [Symbol.dispose](): void;
    decode(input: Uint8Array, timestamp: number, duration: number): TimedPacketFrame[];
    discardLeadingB(input: Uint8Array): PrerollDiscardReport;
    drain(): TimedPacketFrame | undefined;
    finishSegment(): TimedPacketFrame | undefined;
    constructor(max_packet_bytes: number, max_frame_bytes: number);
    reset(): void;
    readonly maxFrameBytes: number;
    readonly maxPacketBytes: number;
    readonly maxReferenceBytes: number;
}

/**
 * Header-only discard receipt. No decoded frame or timing is associated with it.
 */
export class PrerollDiscardReport {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly anchorTemporalReference: number;
    readonly packetId: bigint;
    readonly temporalReference: number;
}

/**
 * Transport owner consumed by the JS facade; taking its frame transfers pixel ownership.
 */
export class TimedPacketFrame {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    takeFrame(): DecodedFrame | undefined;
    readonly duration: number;
    readonly timestamp: number;
}

/**
 * Owns one complete ES and persistent reference state. free() cancels without draining.
 * Previously returned frames remain owned by the caller, including after a later error.
 */
export class VideoDecoder {
    free(): void;
    [Symbol.dispose](): void;
    constructor(input: Uint8Array, max_frame_bytes: number, max_frames: number);
    /**
     * Undefined means final EOF, never a request for more input. Errors are sticky.
     */
    nextFrame(): DecodedFrame | undefined;
    readonly maxFrameBytes: number;
    readonly maxFrames: number;
    readonly maxReferenceBytes: number;
}

/**
 * Decode the entire input or throw. Use js/index.mjs to validate before the
 * generated glue copies the input into WASM memory.
 */
export function decode(input: Uint8Array, max_output_bytes: number): DecodedBatch;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decodedbatch_free: (a: number, b: number) => void;
    readonly __wbg_decodedframe_free: (a: number, b: number) => void;
    readonly __wbg_get_prerolldiscardreport_anchorTemporalReference: (a: number) => number;
    readonly __wbg_get_prerolldiscardreport_packetId: (a: number) => bigint;
    readonly __wbg_get_prerolldiscardreport_temporalReference: (a: number) => number;
    readonly __wbg_packetvideodecoder_free: (a: number, b: number) => void;
    readonly __wbg_prerolldiscardreport_free: (a: number, b: number) => void;
    readonly __wbg_timedpacketframe_free: (a: number, b: number) => void;
    readonly __wbg_videodecoder_free: (a: number, b: number) => void;
    readonly decode: (a: number, b: number, c: number) => [number, number, number];
    readonly decodedbatch_frameCount: (a: number) => number;
    readonly decodedbatch_takeFrame: (a: number) => number;
    readonly decodedframe_cbStride: (a: number) => number;
    readonly decodedframe_chromaFormat: (a: number) => [number, number];
    readonly decodedframe_chromaHeight: (a: number) => number;
    readonly decodedframe_chromaWidth: (a: number) => number;
    readonly decodedframe_codedHeight: (a: number) => number;
    readonly decodedframe_codedWidth: (a: number) => number;
    readonly decodedframe_colorMatrix: (a: number) => number;
    readonly decodedframe_colorPrimaries: (a: number) => number;
    readonly decodedframe_colorTransfer: (a: number) => number;
    readonly decodedframe_crStride: (a: number) => number;
    readonly decodedframe_frameRateDenominator: (a: number) => number;
    readonly decodedframe_frameRateNumerator: (a: number) => number;
    readonly decodedframe_height: (a: number) => number;
    readonly decodedframe_pixelAspectDenominator: (a: number) => number;
    readonly decodedframe_pixelAspectNumerator: (a: number) => number;
    readonly decodedframe_progressive: (a: number) => number;
    readonly decodedframe_progressiveSequence: (a: number) => number;
    readonly decodedframe_takeCb: (a: number) => [number, number];
    readonly decodedframe_takeCr: (a: number) => [number, number];
    readonly decodedframe_takeY: (a: number) => [number, number];
    readonly decodedframe_temporalReference: (a: number) => number;
    readonly decodedframe_topFieldFirst: (a: number) => number;
    readonly decodedframe_width: (a: number) => number;
    readonly decodedframe_yStride: (a: number) => number;
    readonly packetvideodecoder_decode: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly packetvideodecoder_discardLeadingB: (a: number, b: number, c: number) => [number, number, number];
    readonly packetvideodecoder_drain: (a: number) => [number, number, number];
    readonly packetvideodecoder_finishSegment: (a: number) => [number, number, number];
    readonly packetvideodecoder_maxFrameBytes: (a: number) => number;
    readonly packetvideodecoder_maxPacketBytes: (a: number) => number;
    readonly packetvideodecoder_maxReferenceBytes: (a: number) => number;
    readonly packetvideodecoder_new: (a: number, b: number) => [number, number, number];
    readonly packetvideodecoder_reset: (a: number) => void;
    readonly timedpacketframe_duration: (a: number) => number;
    readonly timedpacketframe_takeFrame: (a: number) => number;
    readonly timedpacketframe_timestamp: (a: number) => number;
    readonly videodecoder_maxFrameBytes: (a: number) => number;
    readonly videodecoder_maxFrames: (a: number) => number;
    readonly videodecoder_maxReferenceBytes: (a: number) => number;
    readonly videodecoder_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly videodecoder_nextFrame: (a: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
