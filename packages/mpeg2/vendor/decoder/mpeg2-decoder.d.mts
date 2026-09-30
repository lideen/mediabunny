/**
 * MPEG-2 complete-picture decoding with owned YCbCr frames and optional browser workers.
 * Container demuxing, seeking and playback belong to the caller or a separate adapter.
 * @packageDocumentation
 */

/**
 * Execution mode, not the number of packets allowed in flight.
 * `0` runs synchronously in the calling realm; `1` uses one dedicated worker.
 * `2` and `4` use that many shared-memory slice workers plus a coordinator.
 * Every mode requires WebAssembly SIMD128. Worker modes require browser-style
 * module workers and permission to load blob workers and compile WASM.
 * Shared modes also require cross-origin isolation and SharedArrayBuffer.
 */
export declare type Concurrency = 0 | 1 | 2 | 4;

/**
 * Stateful MPEG-2 picture-packet decoder with owned planar YCbCr output.
 * Submit complete pictures serially in coded order, not presentation order.
 * Only one decode, discard, finish, drain or reset operation may be in flight.
 * Worker concurrency parallelizes slice reconstruction, not packet submission.
 * Operations reject on failure; codec errors remain sticky until reset, while
 * cancellation, closure and fatal runtime/worker failures require a new decoder.
 * This class does not demux containers, seek, schedule playback or deinterlace.
 */
export declare class Decoder {
    #private;
    private constructor();
    /**
     * Initializes a decoder and its selected runtime before accepting packets.
     * WASM and worker sources are embedded; no runtime asset URLs are required.
     * Rejects invalid options, unsupported execution requirements or startup failure.
     * Mode 0 shares the scalar runtime and can block the caller despite this async API.
     * @param options - Budgets, execution mode and optional lifetime abort signal.
     */
    static create(options?: DecoderOptions): Promise<Decoder>;
    /** Execution mode selected at creation; it does not change between packets or on reset. */
    get concurrency(): Concurrency;
    /** Configured compressed-byte limit for each submitted picture packet. */
    get maxPacketBytes(): number;
    /** Configured padded Y + Cb + Cr byte limit per reconstructed picture, not its visible output size. */
    get maxFrameBytes(): number;
    /** Live padded reference/reconstruction payload budget: three times maxFrameBytes. Excludes caller-owned outputs and overhead. */
    get maxReferenceBytes(): number;
    /** Current diagnostic snapshot. Memory figures cover WASM linear memory, not the application's total memory. */
    get stats(): DecoderStats;
    /**
     * Decodes exactly one complete frame-picture packet, including its preceding
     * sequence/GOP headers when present. Headers for the next picture belong in
     * the next packet. Arbitrary network chunks and multiple pictures are invalid.
     * Start a reference chain with the required sequence headers and an I picture.
     * Input is copied, not detached; subsequent calls must wait for this promise.
     * @param bytes - Compressed elementary-stream bytes in coded order.
     * @param timing - Presentation timing for this picture, preserved without unit conversion.
     * @returns Zero to two owned frames in presentation order. An anchor may remain
     * delayed until later decode calls or a terminal drain/finish operation.
     */
    decode(bytes: Uint8Array, timing: PacketTiming): Promise<TimedFrame[]>;
    /**
     * Discards an unrequested leading B packet after a cold open-GOP anchor.
     * Valid only in that initial leading-B run, before the anchor's temporal reference;
     * it is not a general skip or error-recovery operation. Supply complete packets
     * serially in coded order. Input is copied, not detached.
     * Validates headers and ordering without decoding slice entropy or producing pixels.
     * @returns A headers-only receipt, not proof that the discarded picture decodes.
     */
    discardLeadingB(bytes: Uint8Array): Promise<PrerollReport>;
    /**
     * Ends an intentional partial coded selection and emits its complete pending
     * anchor, if any. Does not require or validate an unsubmitted B-picture tail.
     * Further input requires reset; repeated successful finishes return undefined.
     * Does not recover a sticky error or certify whole-stream integrity.
     */
    finishSegment(): Promise<TimedFrame | undefined>;
    /**
     * Declares strict sequence EOF, validates the final reference interval and emits
     * any delayed anchor once. Rejects an incomplete required B-picture tail.
     * Further input requires reset; repeated successful drains return undefined.
     * Use finishSegment instead when deliberately stopping a partial selection.
     */
    drain(): Promise<TimedFrame | undefined>;
    /**
     * Drops references, pending output/timing and recoverable codec errors, then
     * starts a new packet-identity sequence with the same budgets and runtime.
     * Does not seek or locate a random-access point; the caller must supply a new
     * valid reference chain. Delivered frames remain valid. Cannot revive a closed,
     * cancelled or fatally failed decoder. Await any preceding packet operation first.
     */
    reset(): Promise<void>;
    /**
     * Permanently cancels this decoder without draining. Pending and later operations
     * reject with reason, defaulting to an AbortError. Repeated cancellation is harmless.
     * Worker resources are terminated; direct CPU work cannot be preempted while it
     * blocks the realm. Delivered frames remain valid. Await close for cleanup.
     */
    cancel(reason?: unknown): void;
    /**
     * Releases this decoder without emitting delayed output. Rejects pending output
     * delivery and prevents later packet operations. In worker modes, waits for earlier
     * codec work before terminating workers; cleanup failure may reject this promise.
     * Safe to repeat, including after cancel. Delivered frames remain valid and the
     * shared direct runtime remains allocated for reuse by other direct decoders.
     */
    close(): Promise<void>;
}

/** Initialization settings for one stream decoder. Unknown option keys are rejected. */
export declare interface DecoderOptions {
    /**
     * Omit to choose once at initialization: `0` without Worker, `1` without
     * shared-memory support or a valid positive hardwareConcurrency hint, otherwise
     * the largest of `1`, `2`, `4` no greater than the hint. Explicit requests fail
     * if their requirements are unavailable; they do not silently fall back.
     */
    concurrency?: Concurrency;
    /** Maximum compressed bytes per picture packet. Integer 1..8,388,608; defaults to 8 MiB. */
    maxPacketBytes?: number;
    /**
     * Maximum macroblock-padded Y + Cb + Cr bytes per reconstructed picture,
     * checked before allocation. Integer 1..8,388,608; defaults to 8 MiB.
     * This counts padding even though returned planes contain only visible pixels.
     * Retained caller outputs, input copies and allocator overhead are not covered.
     */
    maxFrameBytes?: number;
    /**
     * Aborts initialization and the entire decoder lifetime with the signal's reason.
     * Pending and later operations reject; reset cannot revive an aborted decoder.
     * Direct CPU work cannot be interrupted while it blocks the calling realm.
     */
    signal?: AbortSignal;
}

/**
 * Diagnostic snapshot, not a whole-process memory or end-to-end startup measurement.
 * Byte counts describe WASM linear memory, excluding JS outputs, workers' JS heaps,
 * JS-side input copies and host overhead. Freeing allocations need not shrink linear memory.
 * Direct decoders share one lazily initialized runtime; worker decoders own theirs.
 */
export declare interface DecoderStats {
    /** Execution mode actually selected at creation. */
    readonly concurrency: Concurrency;
    /** Live slice-pool workers, excluding the coordinator. Zero in modes 0 and 1 and after pool disposal. */
    readonly poolWorkers: number;
    /** Slice-pool workers created over this decoder's lifetime, excluding the coordinator. */
    readonly createdWorkers: number;
    /** Linear-memory byte length, read directly in mode 0 or last reported by the worker. Not live payload bytes. */
    readonly allocatedBytes: number;
    /** Largest observed linear-memory byte length. In mode 0 this is the current shared runtime length. */
    readonly peakBytes: number;
    /** Milliseconds awaiting runtime initialization, including worker-side import when applicable; may reuse a warm direct runtime. */
    readonly moduleInitMs: number;
    /** Milliseconds around slice-pool startup in the coordinator, excluding its own launch. Zero in direct mode. */
    readonly poolStartupMs: number;
    /** Milliseconds constructing the native packet decoder after runtime and pool initialization. */
    readonly decoderSetupMs: number;
    /** Configured linear-memory ceiling for shared modes: 268,435,456 bytes. Undefined for scalar modes, not an unlimited-memory promise. */
    readonly maxMemoryBytes?: number;
    /** Descriptive scope label for shared direct-runtime statistics; currently absent for worker-owned runtimes. */
    readonly memoryScope?: string;
}

/**
 * One decoded frame with owned 8-bit, limited-range planar YCbCr pixels.
 * Planes contain the visible crop, not reconstruction padding or RGB conversion.
 * Interlaced frame pictures contain woven rows, with no deinterlacing or field split.
 * Pixels and metadata survive subsequent decoding, reset, cancel and close.
 * Take each plane once to retain it; clear untaken planes when no longer needed.
 * Caller-retained pixels are outside decoder memory budgets.
 */
export declare class Frame {
    #private;
    /** Visible luma width in pixels after right-edge cropping. */
    readonly width: number;
    /** Visible luma height in pixels after bottom-edge cropping. */
    readonly height: number;
    /** Planar subsampling: half-width chroma in both formats, half-height only in yuv420p. */
    readonly chromaFormat: 'yuv420p' | 'yuv422p';
    /** Macroblock-padded reconstruction width before cropping; not the width of the returned Y plane. */
    readonly codedWidth: number;
    /** Reconstruction height including frame/field macroblock padding, before visible cropping. */
    readonly codedHeight: number;
    /** Visible width of each chroma plane in samples, rounding half the luma width upward. */
    readonly chromaWidth: number;
    /** Visible chroma height: rounded-up half luma height for 4:2:0, full height for 4:2:2. */
    readonly chromaHeight: number;
    /** Byte distance between successive rows in the returned Y plane. */
    readonly yStride: number;
    /** Byte distance between successive rows in the returned Cb plane. */
    readonly cbStride: number;
    /** Byte distance between successive rows in the returned Cr plane. */
    readonly crStride: number;
    /** Picture-level progressive_frame flag; may be true within an interlaced sequence. */
    readonly progressive: boolean;
    /** Sequence-level progressive_sequence flag, distinct from this picture's scan mode. */
    readonly progressiveSequence: boolean;
    /** Temporal top-field-first flag for interlaced output. Does not swap spatial rows or double the frame rate. */
    readonly topFieldFirst: boolean;
    /** MPEG 10-bit temporal_reference within the GOP, subject to wrap; not a global index or timestamp. */
    readonly temporalReference: number;
    /** Numerator of the sequence's rational frame rate in frames per second, including rate extensions. */
    readonly frameRateNumerator: number;
    /** Denominator of the sequence frame rate. This rational does not override caller-supplied packet timing. */
    readonly frameRateDenominator: number;
    /** Numerator of the derived pixel width-to-height ratio, not the display aspect ratio. */
    readonly pixelAspectNumerator: number;
    /** Denominator of the pixel aspect ratio. Combine with visible dimensions to obtain display aspect. */
    readonly pixelAspectDenominator: number;
    /** Raw MPEG sequence colour_primaries code; undefined when no colour description was supplied. No default is inferred. */
    readonly colorPrimaries: number | undefined;
    /** Raw MPEG transfer_characteristics code; undefined without a sequence colour description. No transfer conversion is applied. */
    readonly colorTransfer: number | undefined;
    /** Raw MPEG matrix_coefficients code; undefined without a sequence colour description. No YCbCr-to-RGB conversion is applied. */
    readonly colorMatrix: number | undefined;
    private constructor();
    /** Returns the owned Y array and removes it from this frame. Repeated calls, or calls after clear, return an empty array. */
    takeY(): Uint8Array;
    /** Returns the owned Cb array and removes it from this frame. Repeated calls, or calls after clear, return an empty array. */
    takeCb(): Uint8Array;
    /** Returns the owned Cr array and removes it from this frame. Repeated calls, or calls after clear, return an empty array. */
    takeCr(): Uint8Array;
    /** Releases untaken planes. Idempotent; metadata and already-taken planes remain valid. */
    clear(): void;
}

/** Caller timing carried unchanged with its picture through presentation reordering. */
export declare interface PacketTiming {
    /** Finite presentation timestamp in caller-chosen units, not a decode timestamp. */
    timestamp: number;
    /** Finite nonnegative duration in the same units as timestamp. No frame-rate conversion occurs. */
    duration: number;
}

/** Receipt for an intentionally unrequested leading B picture; contains no frame or timing. */
export declare interface PrerollReport {
    /** Only picture/extension/slice headers were validated, not slice entropy or reconstructed pixels. */
    validation: 'headers-only';
    /** Decoder-assigned packet identity, starting at zero after creation/reset and shared with decode calls. */
    packetId: bigint;
    /** Discarded picture's 10-bit MPEG temporal_reference, not a timestamp or global frame index. */
    temporalReference: number;
    /** Temporal reference of the decoded cold open-GOP anchor after which this packet was submitted. */
    anchorTemporalReference: number;
}

/** One decoded output with the timestamp and duration supplied for its originating packet. */
export declare interface TimedFrame extends PacketTiming {
    /** Caller-owned pixels and metadata. Take needed planes, then clear untaken planes when done. */
    frame: Frame;
}

export { }
