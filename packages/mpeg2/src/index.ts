/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, EncodedPacket, registerDecoder, VideoCodec, VideoSample,
	type VideoSampleInit } from 'mediabunny';
import { createPacketDecoder, init, type PacketDecoder, type TimedFrame } from '../vendor/js/index.mjs';
import wasmBinary from '../vendor/pkg/mpeg2_wasm_bg.wasm';
import { Mpeg2WorkerDecoder } from './worker-decoder.js';

let modulePromise: Promise<unknown> | null = null;
const loadModule = () => modulePromise ??= WebAssembly.compile(wasmBinary)
	.then(module => init({ module_or_path: module }))
	.catch((error: unknown) => {
		modulePromise = null;
		throw new Error(`MPEG-2 WASM initialization failed: ${String(error)}`);
	});

/**
 * 8-bit 4:2:0/4:2:2 frame-picture decoder. Complete pictures arrive in decode order with in-band restart headers.
 * Normally installed through {@link registerMpeg2Decoder}; direct users supply the inherited config and callbacks.
 * Calls must be serialized. Flush finishes an intentional selection, not a stream-integrity check.
 * @group \@mediabunny/mpeg2
 * @public
 */
export class Mpeg2Decoder extends CustomVideoDecoder {
	/** @internal */
	private decoder: PacketDecoder | null = null;
	/** @internal */
	private closed = false;

	/**
	 * Rejects dimensions that cannot fit even I420. Native parsing enforces the actual chroma-specific padded-frame
	 * budget before allocation; a configuration without in-band chroma information cannot prove I422 will fit.
	 */
	static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
		const width = config.codedWidth;
		const height = config.codedHeight;
		return codec === 'mpeg2' && config.codec === 'mpeg2' && config.description === undefined
			&& width !== undefined && height !== undefined
			&& Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
			&& width <= 4096 && height <= 2304
			&& Math.ceil(width / 16) * Math.ceil(height / 16) * 384 <= 8 * 1024 * 1024;
	}

	/** Lazily initializes the embedded WASM module and creates one packet decoder. */
	async init() {
		if (this.closed || this.decoder) {
			throw new Error('MPEG-2 decoder is closed or already initialized');
		}
		if (!Mpeg2Decoder.supports(this.codec, this.config)) {
			throw new Error('Unsupported MPEG-2 decoder configuration');
		}
		await loadModule();
		if (!this.closed) {
			this.decoder = createPacketDecoder();
		}
	}

	/** @internal */
	private activeDecoder() {
		if (!this.decoder) {
			throw new Error('MPEG-2 decoder is closed or uninitialized');
		}
		return this.decoder;
	}

	/** Decodes a complete encoded picture, preserving the native output's packet timing. */
	decode(packet: EncodedPacket) {
		const outputs = this.activeDecoder().decode(packet.data, {
			timestamp: packet.timestamp, duration: packet.duration,
		});
		this.emit(outputs);
	}

	/** Applies persistent headers of an unrequested initial leading B picture without reconstructing its pixels. */
	override decodePreroll(packet: EncodedPacket) {
		this.activeDecoder().discardLeadingB(packet.data);
	}

	/** @internal */
	private emit(outputs: TimedFrame[]) {
		try {
			for (const { frame, timestamp, duration } of outputs) {
				if (this.closed) {
					break;
				}
				if (!frame || !['yuv420p', 'yuv422p'].includes(frame.chromaFormat)
					|| frame.width !== this.config.codedWidth || frame.height !== this.config.codedHeight) {
					throw new Error('Unsupported MPEG-2 output format or dimensions');
				}
				const y = frame.takeY();
				const cb = frame.takeCb();
				const cr = frame.takeCr();
				const data = new Uint8Array(y.length + cb.length + cr.length);
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
			for (const { frame } of outputs) {
				frame?.free();
			}
		}
	}

	/** Emits the pending complete anchor, then resets before another independent key group. */
	flush() {
		const decoder = this.activeDecoder();
		const output = decoder.finishSegment();
		// Selection flushes can omit trailing B pictures. Strict drain is not appropriate here.
		decoder.reset();
		this.emit(output ? [output] : []);
	}

	/** Frees native references without emitting frames; also invalidates pending initialization. */
	close() {
		this.closed = true;
		this.decoder?.free();
		this.decoder = null;
	}
}

class RegisteredMpeg2WorkerDecoder extends Mpeg2WorkerDecoder {
	static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
		return Mpeg2Decoder.supports(codec, config);
	}
}

let registeredMode: boolean | null = null;

/**
 * Options for private MPEG-2 decoder registration.
 * @group \@mediabunny/mpeg2
 * @public
 */
export type Mpeg2DecoderOptions = {
	/** Decode in an embedded browser worker. Requires Worker and CSP permission for blob workers. Default: false. */
	useWorker?: boolean;
};

/**
 * Registers the private MPEG-2 WASM decoder. Repeating the same mode is idempotent; a conflicting mode throws.
 * Worker mode never silently falls back to direct decoding. Does not enable implicit MXF input, encoding, or muxing.
 * @group \@mediabunny/mpeg2
 * @public
 */
export const registerMpeg2Decoder = (options: Mpeg2DecoderOptions = {}) => {
	if (!options || typeof options !== 'object'
		|| (options.useWorker !== undefined && typeof options.useWorker !== 'boolean')) {
		throw new TypeError('MPEG-2 useWorker must be a boolean.');
	}
	const useWorker = options.useWorker ?? false;
	if (registeredMode !== null) {
		if (registeredMode !== useWorker) {
			throw new Error('MPEG-2 decoder was already registered with a different mode');
		}
		return;
	}
	registerDecoder(useWorker ? RegisteredMpeg2WorkerDecoder : Mpeg2Decoder);
	registeredMode = useWorker;
};
