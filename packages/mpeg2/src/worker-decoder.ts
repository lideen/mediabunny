/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, EncodedPacket, VideoSample } from 'mediabunny';
import source from '#mpeg2-worker-source';
import { MAX_PACKET_BYTES, readResponse,
	type WorkerCommand, type WorkerFrame, type WorkerRequest } from './worker-protocol.js';

/** Internal transport. The sink's existing custom-decoder serializer owns scheduling. */
export class Mpeg2WorkerDecoder extends CustomVideoDecoder {
	private worker: Worker | null = null;
	private url: string | null = null;
	private failure: Error | null = null;
	private initialized = false;
	private nextId = 0;
	private pending: {
		request: WorkerRequest;
		resolve: (frames: WorkerFrame[]) => void;
		reject: (error: Error) => void;
	} | null = null;

	private releaseUrl() {
		if (this.url !== null) {
			URL.revokeObjectURL(this.url);
			this.url = null;
		}
	}

	private fail(reason: unknown) {
		if (this.failure) return this.failure;
		const error = reason instanceof Error ? reason : new Error(String(reason));
		this.failure = error;
		const pending = this.pending;
		this.pending = null;
		const worker = this.worker;
		this.worker = null;
		if (worker) {
			worker.removeEventListener('message', this.onMessage);
			worker.removeEventListener('error', this.onWorkerError);
			worker.removeEventListener('messageerror', this.onMessageError);
			worker.terminate();
		}
		this.releaseUrl();
		pending?.reject(error);
		return error;
	}

	private onMessage = (event: MessageEvent<unknown>) => {
		if (this.failure) return;
		const pending = this.pending;
		try {
			if (!pending) throw new Error('MPEG-2 worker sent an unsolicited reply');
			const frames = readResponse(event.data, pending.request, this.config.codedWidth!, this.config.codedHeight!);
			this.pending = null;
			pending.resolve(frames);
		} catch (error) {
			const failure = this.fail(error);
			if (!pending) this.onError(failure);
		}
	};

	private workerFailed(error: Error) {
		if (this.failure) return;
		const hadPending = this.pending !== null;
		this.fail(error);
		if (!hadPending) this.onError(error);
	}

	private onWorkerError = (event: ErrorEvent) => {
		event.preventDefault();
		this.workerFailed(new Error(`MPEG-2 worker failed: ${event.message || 'Worker startup or execution failed'}`));
	};

	private onMessageError = () => {
		this.workerFailed(new Error('MPEG-2 worker response could not be deserialized'));
	};

	private request(command: WorkerCommand): Promise<WorkerFrame[]> {
		if (this.failure) return Promise.reject(this.failure);
		if (!this.worker || this.pending || this.nextId === Number.MAX_SAFE_INTEGER) {
			return Promise.reject(this.fail(new Error('MPEG-2 worker calls must be initialized and serialized')));
		}
		const request: WorkerRequest = { ...command, id: ++this.nextId };
		return new Promise((resolve, reject) => {
			this.pending = { request, resolve, reject };
			try {
				this.worker!.postMessage(request, 'data' in request ? [request.data] : []);
			} catch (error) {
				this.fail(error);
			}
		});
	}

	async init() {
		if (this.failure) throw this.failure;
		if (this.worker || this.initialized) throw this.fail(new Error('MPEG-2 worker is already initialized'));
		try {
			if (typeof Worker === 'undefined') {
				throw new Error('MPEG-2 worker decoding requires browser Worker support');
			}
			this.url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
			this.worker = new Worker(this.url);
			this.worker.addEventListener('message', this.onMessage);
			this.worker.addEventListener('error', this.onWorkerError);
			this.worker.addEventListener('messageerror', this.onMessageError);
			await this.request({ op: 'init', width: this.config.codedWidth!, height: this.config.codedHeight! });
			if (this.failure) throw this.fail(this.failure);
			this.initialized = true;
			this.releaseUrl();
		} catch (error) {
			throw this.fail(error);
		}
	}

	private packetBytes(packet: EncodedPacket) {
		if (this.failure) throw this.failure;
		if (!this.initialized) throw this.fail(new Error('MPEG-2 worker is uninitialized'));
		if (packet.data.byteLength > MAX_PACKET_BYTES) {
			throw this.fail(new Error('ResourceLimit: MPEG-2 packet exceeds 8388608 bytes'));
		}
		// EncodedPacket remains caller-owned, including when its data is only a view of a larger buffer.
		return new Uint8Array(packet.data).buffer;
	}

	private emit(frames: WorkerFrame[]) {
		for (const frame of frames) {
			if (this.failure) return;
			const init = {
				format: frame.format, codedWidth: frame.width, codedHeight: frame.height, layout: frame.layout,
				scan: frame.scan, timestamp: frame.timestamp, duration: frame.duration,
				colorSpace: this.config.colorSpace ?? {},
			};
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
	}

	async decode(packet: EncodedPacket) {
		try {
			this.emit(await this.request({ op: 'decode', data: this.packetBytes(packet),
				timestamp: packet.timestamp, duration: packet.duration }));
		} catch (error) {
			throw this.fail(error);
		}
	}

	override async decodePreroll(packet: EncodedPacket) {
		try {
			await this.request({ op: 'preroll', data: this.packetBytes(packet) });
		} catch (error) {
			throw this.fail(error);
		}
	}

	async flush() {
		try {
			this.emit(await this.request({ op: 'flush' }));
		} catch (error) {
			throw this.fail(error);
		}
	}

	override cancel() {
		const error = new Error('MPEG-2 worker decoding was canceled');
		error.name = 'AbortError';
		this.fail(error);
	}

	close() {
		this.cancel();
	}
}
