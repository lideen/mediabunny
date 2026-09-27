/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createPacketDecoder, init, type PacketDecoder, type TimedFrame } from '../vendor/js/index.mjs';
import wasmBinary from '../vendor/pkg/mpeg2_wasm_bg.wasm';
import { MAX_FRAME_BYTES, MAX_PACKET_BYTES, requireProtocol,
	type WorkerFrame, type WorkerRequest, type WorkerResponse } from './worker-protocol.js';

let decoder: PacketDecoder | null = null;
let busy = false;
let failed = false;
let lastId = 0;
let width = 0;
let height = 0;

const send = (reply: WorkerResponse, transfer: ArrayBuffer[] = []) => {
	globalThis.postMessage(reply, { transfer });
};

const pack = (outputs: TimedFrame[]): WorkerFrame[] => {
	try {
		return outputs.map(({ frame, timestamp, duration }) => {
			requireProtocol(frame && frame.width === width && frame.height === height
				&& (frame.chromaFormat === 'yuv420p' || frame.chromaFormat === 'yuv422p'), 'native output changed');
			const y = frame.takeY();
			const cb = frame.takeCb();
			const cr = frame.takeCr();
			const length = y.length + cb.length + cr.length;
			requireProtocol(length <= MAX_FRAME_BYTES, 'native frame exceeds output limit');
			const data = new Uint8Array(length);
			data.set(y);
			data.set(cb, y.length);
			data.set(cr, y.length + cb.length);
			return {
				data: data.buffer, width, height, timestamp, duration,
				format: frame.chromaFormat === 'yuv422p' ? 'I422' : 'I420',
				scan: frame.progressive
					? 'progressive'
					: frame.topFieldFirst ? 'interlaced-top-first' : 'interlaced-bottom-first',
				layout: [{ offset: 0, stride: frame.yStride }, { offset: y.length, stride: frame.cbStride },
					{ offset: y.length + cb.length, stride: frame.crStride }],
			};
		});
	} finally {
		for (const { frame } of outputs) frame?.free();
	}
};

const run = async (request: WorkerRequest): Promise<WorkerFrame[]> => {
	if (request.op === 'init') {
		requireProtocol(!decoder && lastId === 1, 'duplicate initialization');
		requireProtocol(Number.isInteger(request.width) && request.width > 0 && request.width <= 4096
			&& Number.isInteger(request.height) && request.height > 0 && request.height <= 2304
			&& Math.ceil(request.width / 16) * Math.ceil(request.height / 16) * 384 <= MAX_FRAME_BYTES,
		'unsupported configuration');
		await init({ module_or_path: await WebAssembly.compile(wasmBinary) });
		if (failed) throw new Error('MPEG-2 worker initialization canceled');
		width = request.width;
		height = request.height;
		decoder = createPacketDecoder();
		return [];
	}
	const active = decoder;
	requireProtocol(active, 'decoder is not initialized');
	if (request.op === 'flush') {
		const output = active.finishSegment();
		const frames = pack(output ? [output] : []);
		active.reset();
		return frames;
	}
	requireProtocol((request.op === 'decode' || request.op === 'preroll')
		&& request.data instanceof ArrayBuffer && request.data.byteLength <= MAX_PACKET_BYTES, 'invalid packet');
	const bytes = new Uint8Array(request.data);
	if (request.op === 'preroll') {
		active.discardLeadingB(bytes);
		return [];
	}
	return pack(active.decode(bytes, { timestamp: request.timestamp, duration: request.duration }));
};

globalThis.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	if (failed) return;
	if (!request || !Number.isSafeInteger(request.id) || request.id !== lastId + 1 || busy) {
		failed = true;
		const active = decoder;
		decoder = null;
		active?.free();
		send({ id: request?.id ?? 0, ok: false, message: 'Invalid or concurrent MPEG-2 worker request' });
		return;
	}
	lastId = request.id;
	busy = true;
	void run(request).then((frames) => {
		if (!failed) send({ id: request.id, ok: true, frames }, frames.map(frame => frame.data));
	}).catch((error: unknown) => {
		failed = true;
		const active = decoder;
		decoder = null;
		active?.free();
		send({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) });
	}).finally(() => {
		busy = false;
	}).catch((error: unknown) => {
		// An unhandled rejection need not reach the host's Worker error listener.
		queueMicrotask(() => {
			throw error;
		});
	});
};
