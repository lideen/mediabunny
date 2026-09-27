import type { DecodedFrame } from '../pkg/mpeg2_wasm.js';

export interface ThreadedPacketOptions {
  /** Cancels initialization and the returned decoder's entire lifetime. */
  signal?: AbortSignal;
  /** Defaults to 1, which uses nonshared WASM without isolation headers. */
  threadCount?: 1 | 2 | 4;
  /** Required for 2/4 threads. URL of the shared build's threaded-runtime.mjs. */
  threadedRuntimeUrl?: string | URL;
  scalarRuntimeUrl?: string | URL;
  workerUrl?: string | URL;
  maxPacketBytes?: number;
  maxFrameBytes?: number;
}

export interface ThreadedPacketFrame {
  timestamp: number;
  duration: number;
  /** Owned JS planes, not a reference into shared WASM memory. */
  frame: Omit<DecodedFrame, typeof Symbol.dispose>;
}

export interface ThreadedPacketDecoder {
  readonly threadCount: 1 | 2 | 4;
  readonly maxPacketBytes: number;
  readonly maxFrameBytes: number;
  readonly maxReferenceBytes: number;
  readonly stats: {
    threadCount: number;
    poolWorkers: number;
    createdWorkers: number;
    allocatedBytes: number;
    peakBytes: number;
    moduleInitMs: number;
    poolStartupMs: number;
    decoderSetupMs: number;
    maxMemoryBytes: number | undefined;
  };
  /** Rejects overlapping operations. Caller input is copied, never detached. */
  decode(input: Uint8Array, timing: { timestamp: number; duration: number }): Promise<ThreadedPacketFrame[]>;
  discardLeadingB(input: Uint8Array): Promise<{
    validation: 'headers-only'; packetId: bigint; temporalReference: number; anchorTemporalReference: number;
  }>;
  drain(): Promise<ThreadedPacketFrame | undefined>;
  finishSegment(): Promise<ThreadedPacketFrame | undefined>;
  reset(): Promise<void>;
  /** Synchronously abandons the pool and rejects pending work with the supplied reason. */
  cancel(reason?: unknown): void;
  /** Idempotent. Pending output is invalidated; workers and their memory are not reused. */
  close(): Promise<void>;
}

export function createThreadedPacketDecoder(options?: ThreadedPacketOptions): Promise<ThreadedPacketDecoder>;
