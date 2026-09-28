/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, EncodedPacket, registerDecoder, VideoCodec, VideoSample,
	type VideoSampleInit } from 'mediabunny';
import { Decoder } from '../vendor/decoder/mpeg2-decoder.mjs';

type TimedFrame = Awaited<ReturnType<Decoder['decode']>>[number];

const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

class Mpeg2Decoder extends CustomVideoDecoder {
	private decoder: Decoder | null = null;
	private initialization: Promise<void> | null = null;
	private closing: Promise<void> | null = null;
	private abort = new AbortController();
	private failure: Error | null = null;

	/** Native parsing enforces the chroma-specific budget; configuration alone cannot prove I422 will fit. */
	static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
		const width = config.codedWidth;
		const height = config.codedHeight;
		return codec === 'mpeg2' && config.codec === 'mpeg2' && config.description === undefined
			&& width !== undefined && height !== undefined
			&& Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
			&& width <= 4096 && height <= 2304
			&& Math.ceil(width / 16) * Math.ceil(height / 16) * 384 <= MAX_FRAME_BYTES;
	}

	private fail(reason: unknown) {
		if (this.failure) return this.failure;
		this.failure = reason instanceof Error ? reason : new Error(String(reason));
		this.abort.abort(this.failure);
		this.decoder?.cancel(this.failure);
		return this.failure;
	}

	init() {
		if (this.failure) return Promise.reject(this.failure);
		if (this.initialization) return Promise.reject(this.fail(new Error('MPEG-2 decoder already initialized')));
		if (!Mpeg2Decoder.supports(this.codec, this.config)) {
			return Promise.reject(this.fail(new Error('Unsupported MPEG-2 decoder configuration')));
		}
		return this.initialization = this.initialize()
			.catch((error: unknown) => { throw this.fail(error); });
	}

	private async initialize() {
		const decoder = await Decoder.create({
			maxPacketBytes: MAX_PACKET_BYTES, maxFrameBytes: MAX_FRAME_BYTES, signal: this.abort.signal,
		});
		if (this.abort.signal.aborted) {
			decoder.cancel(this.abort.signal.reason);
			await decoder.close();
			this.abort.signal.throwIfAborted();
		}
		this.decoder = decoder;
	}

	private active() {
		if (this.failure) throw this.failure;
		if (!this.decoder) throw new Error('MPEG-2 decoder is uninitialized');
		return this.decoder;
	}

	private emit(outputs: TimedFrame[]) {
		try {
			for (const { frame, timestamp, duration } of outputs) {
				if (this.failure) break;
				if (frame.width !== this.config.codedWidth || frame.height !== this.config.codedHeight
					|| (frame.chromaFormat !== 'yuv420p' && frame.chromaFormat !== 'yuv422p')) {
					throw new Error('Unsupported MPEG-2 output format or dimensions');
				}
				const y = frame.takeY();
				const cb = frame.takeCb();
				const cr = frame.takeCr();
				const size = y.length + cb.length + cr.length;
				if (size > MAX_FRAME_BYTES) throw new Error('ResourceLimit: MPEG-2 frame bytes');
				const data = new Uint8Array(size);
				data.set(y);
				data.set(cb, y.length);
				data.set(cr, y.length + cb.length);
				const sampleInit = {
					format: frame.chromaFormat === 'yuv422p' ? 'I422' : 'I420',
					codedWidth: frame.width, codedHeight: frame.height,
					scan: frame.progressive
						? 'progressive'
						: frame.topFieldFirst ? 'interlaced-top-first' : 'interlaced-bottom-first',
					layout: [
						{ offset: 0, stride: frame.yStride },
						{ offset: y.length, stride: frame.cbStride },
						{ offset: y.length + cb.length, stride: frame.crStride },
					],
					timestamp, duration, colorSpace: this.config.colorSpace ?? {},
				} satisfies VideoSampleInit;
				const sample = typeof globalThis.structuredClone === 'function'
					? VideoSample.fromTransferredBuffer(data.buffer, sampleInit)
					: new VideoSample(data, sampleInit);
				try {
					this.onSample(sample);
				} catch (error) {
					sample.close();
					throw error;
				}
			}
		} finally {
			for (const { frame } of outputs) frame.clear();
		}
	}

	async decode(packet: EncodedPacket) {
		try {
			this.emit(await this.active().decode(packet.data, {
				timestamp: packet.timestamp, duration: packet.duration,
			}));
		} catch (error) {
			throw this.fail(error);
		}
	}

	override async decodePreroll(packet: EncodedPacket) {
		try {
			await this.active().discardLeadingB(packet.data);
		} catch (error) {
			throw this.fail(error);
		}
	}

	async flush() {
		let output: TimedFrame | undefined;
		try {
			const decoder = this.active();
			// A selection can omit trailing B pictures. Finish its pending anchor without a strict stream drain.
			output = await decoder.finishSegment();
			this.abort.signal.throwIfAborted();
			await decoder.reset();
			const outputs = output ? [output] : [];
			output = undefined;
			this.emit(outputs);
		} catch (error) {
			throw this.fail(error);
		} finally {
			output?.frame.clear();
		}
	}

	override cancel() {
		this.fail(new DOMException('MPEG-2 decoding was canceled', 'AbortError'));
	}

	close() {
		this.cancel();
		return this.closing ??= (async () => {
			await this.initialization?.catch(() => {});
			const decoder = this.decoder;
			this.decoder = null;
			await decoder?.close();
		})();
	}
}

let registered = false;

/**
 * Registers an MPEG-2 WASM decoder which Mediabunny will use automatically when applicable. Call this before
 * starting any decoding task, then use Mediabunny's sample sinks. Repeated registration is idempotent.
 *
 * The standalone Decoder chooses execution at initialization and owns its embedded WASM and workers.
 * Registration accepts no options and does not enable implicit MXF input, encoding, or muxing.
 * This private extension is not licensed for public distribution.
 * @group \@mediabunny/mpeg2
 * @public
 */
export const registerMpeg2Decoder = () => {
	if (registered) return;
	registerDecoder(Mpeg2Decoder);
	registered = true;
};
