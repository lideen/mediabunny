import { decode as decodeWasm, VideoDecoder, PacketVideoDecoder } from '../pkg/mpeg2_wasm.js';

export { default as init, initSync } from '../pkg/mpeg2_wasm.js';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_FRAMES = 64;

function validateInput(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('input must be a Uint8Array');
  }
  if (input.byteLength > MAX_INPUT_BYTES) {
    throw new RangeError('ResourceLimit: input exceeds 8388608 bytes');
  }
}

function takeTimedFrame(output) {
  try {
    return { timestamp: output.timestamp, duration: output.duration, frame: output.takeFrame() };
  } finally { output.free(); }
}

class PacketDecoder {
  #decoder;
  constructor(maxPacketBytes, maxFrameBytes) {
    this.#decoder = new PacketVideoDecoder(maxPacketBytes, maxFrameBytes);
  }
  get maxPacketBytes() { return this.#decoder.maxPacketBytes; }
  get maxFrameBytes() { return this.#decoder.maxFrameBytes; }
  get maxReferenceBytes() { return this.#decoder.maxReferenceBytes; }

  decode(input, { timestamp, duration }) {
    validateInput(input);
    if (input.byteLength > this.maxPacketBytes) {
      throw new RangeError('ResourceLimit: packet bytes');
    }
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) {
      throw new TypeError('timestamp must be finite and duration finite and nonnegative');
    }
    return this.#decoder.decode(input, timestamp, duration).map(takeTimedFrame);
  }

  discardLeadingB(input) {
    validateInput(input);
    if (input.byteLength > this.maxPacketBytes) {
      throw new RangeError('ResourceLimit: packet bytes');
    }
    const report = this.#decoder.discardLeadingB(input);
    try {
      return { validation: 'headers-only', packetId: report.packetId,
        temporalReference: report.temporalReference, anchorTemporalReference: report.anchorTemporalReference };
    } finally { report.free(); }
  }

  drain() {
    const output = this.#decoder.drain();
    return output === undefined ? undefined : takeTimedFrame(output);
  }

  finishSegment() {
    const output = this.#decoder.finishSegment();
    return output === undefined ? undefined : takeTimedFrame(output);
  }

  reset() { this.#decoder.reset(); }
  free() { this.#decoder.free(); }
}

/**
 * One complete frame-picture packet per decode call, in coded order; not network chunks.
 * Returns at most two {frame, timestamp, duration} outputs in display order.
 * drain() is terminal until reset(). Free every returned frame and the decoder.
 * @param {{ maxPacketBytes?: number, maxFrameBytes?: number }} [options]
 */
export function createPacketDecoder({ maxPacketBytes = MAX_INPUT_BYTES, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  for (const [name, value, max] of [['packet', maxPacketBytes, MAX_INPUT_BYTES], ['frame', maxFrameBytes, MAX_FRAME_BYTES]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new RangeError(`ResourceLimit: ${name} budget must be an integer in 1..=${max} bytes`);
    }
  }
  return new PacketDecoder(maxPacketBytes, maxFrameBytes);
}

/**
 * Copy one complete ES into an owned persistent decoder. This does not accept chunks.
 * nextFrame() transfers one frame in display order, or returns undefined at final EOF.
 * Free each returned frame and the decoder. Earlier frames survive later sticky errors.
 * @param {Uint8Array} input
 * @param {{ maxFrameBytes?: number, maxFrames?: number }} [options]
 * @returns {import('../pkg/mpeg2_wasm.js').VideoDecoder}
 */
export function createDecoder(input, { maxFrameBytes = MAX_FRAME_BYTES, maxFrames = MAX_FRAMES } = {}) {
  validateInput(input);
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > MAX_FRAME_BYTES) {
    throw new RangeError('ResourceLimit: frame budget must be an integer in 1..=8388608 bytes');
  }
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_FRAMES) {
    throw new RangeError('ResourceLimit: frame count must be an integer in 1..=64');
  }
  return new VideoDecoder(input, maxFrameBytes, maxFrames);
}

/**
 * Atomically decode a complete ES into an owned batch or throw an Error.
 * The output budget counts format-specific macroblock-padded planes, not visible bytes.
 * Call free() on each taken frame and on the batch, preferably in finally blocks.
 * @param {Uint8Array} input
 * @param {{ maxOutputBytes?: number }} [options]
 * @returns {import('../pkg/mpeg2_wasm.js').DecodedBatch}
 */
export function decode(input, { maxOutputBytes = DEFAULT_OUTPUT_BYTES } = {}) {
  validateInput(input);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new RangeError('ResourceLimit: output budget must be an integer in 1..=8388608 bytes');
  }
  return decodeWasm(input, maxOutputBytes);
}
