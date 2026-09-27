/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, EncodedPacket, VideoSample } from 'mediabunny';
import type { TimedFrame } from '../vendor/js/index.mjs';
import { MAX_FRAME_BYTES, MAX_PACKET_BYTES, readFrames, type WorkerFrame } from './worker-protocol.js';

type OwnedFrame = Pick<NonNullable<TimedFrame['frame']>,
	'width' | 'height' | 'chromaFormat' | 'progressive' | 'topFieldFirst'
	| 'yStride' | 'cbStride' | 'crStride' | 'takeY' | 'takeCb' | 'takeCr' | 'free'>;
type Output = { frame: OwnedFrame; timestamp: number; duration: number };

// Consumer contract for the separately deployed private facade; no generated runtime is bundled here.
type ThreadedDecoder = {
	decode: (bytes: Uint8Array, timing: { timestamp: number; duration: number }) => Promise<Output[]>;
	discardLeadingB: (bytes: Uint8Array) => Promise<unknown>;
	finishSegment: () => Promise<Output | undefined>;
	reset: () => Promise<void>;
	cancel: (reason?: unknown) => void;
	close: () => Promise<void>;
};
type Factory = (options: {
	threadCount: 2 | 4;
	threadedRuntimeUrl: string;
	scalarRuntimeUrl: string;
	workerUrl: string;
	maxPacketBytes: number;
	maxFrameBytes: number;
	signal: AbortSignal;
}) => Promise<ThreadedDecoder>;

/** Internal backend; the sink serializer remains the only caller-side scheduler. */
export class Mpeg2ThreadedDecoder extends CustomVideoDecoder {
	private decoder: ThreadedDecoder | null = null;
	private initialization: Promise<void> | null = null;
	private closing: Promise<void> | null = null;
	private abort = new AbortController();
	private failure: Error | null = null;

	constructor(private threadCount: 2 | 4, private runtimeUrl: string | undefined) {
		super();
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
		if (this.initialization) return Promise.reject(this.fail(new Error('MPEG-2 threads already initialized')));
		let onAbort: () => void;
		const canceled = new Promise<never>((_, reject) => {
			onAbort = () => reject(this.failure!);
			this.abort.signal.addEventListener('abort', onAbort, { once: true });
		});
		return this.initialization = Promise.race([this.initialize(), canceled])
			.catch((error: unknown) => { throw this.fail(error); })
			.finally(() => this.abort.signal.removeEventListener('abort', onAbort));
	}

	private async initialize() {
		if (typeof Worker === 'undefined') throw new Error('MPEG-2 slice threads require browser Worker support');
		if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
			throw new Error('MPEG-2 slice threads require crossOriginIsolated and SharedArrayBuffer');
		}
		if (!this.runtimeUrl) throw new Error('MPEG-2 slice threads require threadedRuntimeUrl');
		const facadeUrl = new URL('./threaded.mjs', this.runtimeUrl).href;
		const facade: unknown = await import(/* @vite-ignore */ facadeUrl);
		this.abort.signal.throwIfAborted();
		if (!facade || typeof facade !== 'object' || !('createThreadedPacketDecoder' in facade)
			|| typeof facade.createThreadedPacketDecoder !== 'function') {
			throw new Error('MPEG-2 threadedRuntimeUrl has no adjacent threaded decoder facade');
		}
		const create = facade.createThreadedPacketDecoder as Factory;
		const decoder = await create({
			threadCount: this.threadCount, threadedRuntimeUrl: this.runtimeUrl,
			scalarRuntimeUrl: new URL('./index.mjs', this.runtimeUrl).href,
			workerUrl: new URL('./threaded-worker.mjs', this.runtimeUrl).href,
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
		if (!this.decoder) throw new Error('MPEG-2 slice threads are not initialized');
		return this.decoder;
	}

	private emit(outputs: Output[], op: 'decode' | 'flush') {
		try {
			if (this.failure) return;
			const frames: WorkerFrame[] = outputs.map(({ frame, timestamp, duration }) => {
				if (frame.chromaFormat !== 'yuv420p' && frame.chromaFormat !== 'yuv422p') {
					throw new Error('Unsupported MPEG-2 threaded output format');
				}
				if (typeof frame.progressive !== 'boolean' || typeof frame.topFieldFirst !== 'boolean') {
					throw new Error('Invalid MPEG-2 threaded scan metadata');
				}
				const y = frame.takeY();
				const cb = frame.takeCb();
				const cr = frame.takeCr();
				const size = y.length + cb.length + cr.length;
				if (size > MAX_FRAME_BYTES) throw new Error('ResourceLimit: MPEG-2 threaded frame bytes');
				const data = new Uint8Array(size);
				data.set(y);
				data.set(cb, y.length);
				data.set(cr, y.length + cb.length);
				return {
					data: data.buffer, width: frame.width, height: frame.height, timestamp, duration,
					format: frame.chromaFormat === 'yuv420p' ? 'I420' : 'I422',
					scan: frame.progressive
						? 'progressive'
						: frame.topFieldFirst ? 'interlaced-top-first' : 'interlaced-bottom-first',
					layout: [{ offset: 0, stride: frame.yStride }, { offset: y.length, stride: frame.cbStride },
						{ offset: y.length + cb.length, stride: frame.crStride }],
				};
			});
			// Parallel output uses the same host-side bounds/timing validation as the serial worker.
			readFrames(frames, op === 'decode' ? 2 : 1, this.config.codedWidth!, this.config.codedHeight!);
			for (const frame of frames) {
				if (this.failure) break;
				const init = { format: frame.format, codedWidth: frame.width, codedHeight: frame.height,
					layout: frame.layout, scan: frame.scan,
					timestamp: frame.timestamp, duration: frame.duration,
					colorSpace: this.config.colorSpace ?? {} };
				const sample = typeof globalThis.structuredClone === 'function'
					? VideoSample.fromTransferredBuffer(frame.data, init)
					: new VideoSample(frame.data, init);
				try {
					this.onSample(sample);
				} catch (error) {
					sample.close();
					throw error;
				}
			}
		} finally {
			for (const { frame } of outputs) frame.free();
		}
	}

	async decode(packet: EncodedPacket) {
		try {
			this.emit(
				await this.active().decode(packet.data, { timestamp: packet.timestamp, duration: packet.duration }),
				'decode',
			);
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
		let output: Output | undefined;
		try {
			const decoder = this.active();
			output = await decoder.finishSegment();
			this.abort.signal.throwIfAborted();
			await decoder.reset();
			const outputs = output ? [output] : [];
			output = undefined;
			this.emit(outputs, 'flush');
		} catch (error) {
			throw this.fail(error);
		} finally {
			output?.frame.free();
		}
	}

	override cancel() {
		this.fail(new DOMException('MPEG-2 slice decoding was canceled', 'AbortError'));
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
