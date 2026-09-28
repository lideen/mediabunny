export type Concurrency = 0 | 1 | 2 | 4;

export interface Mpeg2DecoderOptions {
  /** Omit for capability/hardware selection. 0 performs CPU work in this realm. */
  concurrency?: Concurrency;
  maxPacketBytes?: number;
  maxFrameBytes?: number;
  /** Aborts initialization and the entire returned decoder lifetime. */
  signal?: AbortSignal;
}

export interface OwnedFrame {
  readonly width: number;
  readonly height: number;
  readonly chromaFormat: 'yuv420p' | 'yuv422p';
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly chromaWidth: number;
  readonly chromaHeight: number;
  readonly yStride: number;
  readonly cbStride: number;
  readonly crStride: number;
  readonly progressive: boolean;
  readonly progressiveSequence: boolean;
  readonly topFieldFirst: boolean;
  readonly temporalReference: number;
  readonly frameRateNumerator: number;
  readonly frameRateDenominator: number;
  readonly pixelAspectNumerator: number;
  readonly pixelAspectDenominator: number;
  readonly colorPrimaries: number | undefined;
  readonly colorTransfer: number | undefined;
  readonly colorMatrix: number | undefined;
  /** Transfers the owned JS plane. Repeated calls return an empty array. */
  takeY(): Uint8Array;
  takeCb(): Uint8Array;
  takeCr(): Uint8Array;
  /** Releases untaken planes. Idempotent; already-taken planes remain valid. */
  free(): void;
}

export interface PacketTiming { timestamp: number; duration: number; }
export interface TimedFrame extends PacketTiming { frame: OwnedFrame; }
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
export interface Mpeg2Decoder {
  readonly concurrency: Concurrency;
  readonly maxPacketBytes: number;
  readonly maxFrameBytes: number;
  readonly maxReferenceBytes: number;
  readonly stats: DecoderStats;
  decode(bytes: Uint8Array, timing: PacketTiming): Promise<TimedFrame[]>;
  discardLeadingB(bytes: Uint8Array): Promise<PrerollReport>;
  finishSegment(): Promise<TimedFrame | undefined>;
  drain(): Promise<TimedFrame | undefined>;
  reset(): Promise<void>;
  cancel(reason?: unknown): void;
  close(): Promise<void>;
}

/** One stateful decoder. Submit complete picture packets serially in coded order. */
export function createMpeg2Decoder(options?: Mpeg2DecoderOptions): Promise<Mpeg2Decoder>;
