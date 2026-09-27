/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export const MAX_PACKET_BYTES = 8 * 1024 * 1024;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type WorkerCommand =
	| { op: 'init'; width: number; height: number }
	| { op: 'decode'; data: ArrayBuffer; timestamp: number; duration: number }
	| { op: 'preroll'; data: ArrayBuffer }
	| { op: 'flush' };

export type WorkerRequest = WorkerCommand & { id: number };

export type WorkerFrame = {
	data: ArrayBuffer;
	width: number;
	height: number;
	format: 'I420' | 'I422';
	scan: 'progressive' | 'interlaced-top-first' | 'interlaced-bottom-first';
	timestamp: number;
	duration: number;
	layout: { offset: number; stride: number }[];
};

export type WorkerResponse =
	| { id: number; ok: true; frames: WorkerFrame[] }
	| { id: number; ok: false; message: string };

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

export function requireProtocol(condition: unknown, detail: string): asserts condition {
	if (!condition) throw new Error(`MPEG-2 worker protocol: ${detail}`);
}

/** Validates transport-owned storage before the host can adopt or expose any frame in a reply. */
export function readResponse(value: unknown, request: WorkerRequest, width: number, height: number): WorkerFrame[] {
	requireProtocol(record(value) && value['id'] === request.id && typeof value['ok'] === 'boolean',
		'invalid reply ID or status');
	if (!value['ok']) {
		requireProtocol(typeof value['message'] === 'string', 'invalid error reply');
		throw new Error(`MPEG-2 worker: ${value['message']}`);
	}
	const frames = value['frames'];
	const maxFrames = request.op === 'decode' ? 2 : request.op === 'flush' ? 1 : 0;
	return readFrames(frames, maxFrames, width, height);
}

/** Shared output boundary for embedded-worker replies and the slice-pool facade. */
export function readFrames(frames: unknown, maxFrames: number, width: number, height: number): WorkerFrame[] {
	requireProtocol(Array.isArray(frames) && frames.length <= maxFrames, 'invalid output count');
	const buffers = new Set<ArrayBuffer>();
	for (const frame of frames as unknown[]) {
		requireProtocol(record(frame), 'invalid frame');
		requireProtocol(frame['width'] === width && frame['height'] === height, 'output dimensions changed');
		requireProtocol(frame['format'] === 'I420' || frame['format'] === 'I422', 'invalid output format');
		requireProtocol(frame['scan'] === 'progressive' || frame['scan'] === 'interlaced-top-first'
			|| frame['scan'] === 'interlaced-bottom-first', 'invalid scan structure');
		requireProtocol(finite(frame['timestamp']) && finite(frame['duration']) && frame['duration'] >= 0,
			'invalid output timing');
		requireProtocol(frame['data'] instanceof ArrayBuffer && frame['data'].byteLength > 0
			&& frame['data'].byteLength <= MAX_FRAME_BYTES, 'invalid output storage');
		requireProtocol(!buffers.has(frame['data']), 'output frames share transferred storage');
		buffers.add(frame['data']);
		requireProtocol(Array.isArray(frame['layout']) && frame['layout'].length === 3, 'invalid plane count');
		let previousEnd = 0;
		for (let i = 0; i < 3; i++) {
			const plane: unknown = frame['layout'][i];
			const rows = i > 0 && frame['format'] === 'I420' ? Math.ceil(height / 2) : height;
			const rowBytes = i > 0 ? Math.ceil(width / 2) : width;
			requireProtocol(record(plane) && integer(plane['offset']) && integer(plane['stride'])
				&& plane['offset'] === previousEnd && plane['stride'] >= rowBytes, 'invalid packed plane layout');
			const size = plane['stride'] * rows;
			const end = plane['offset'] + size;
			requireProtocol(Number.isSafeInteger(size) && Number.isSafeInteger(end)
				&& end <= frame['data'].byteLength, 'plane exceeds output buffer');
			previousEnd = end;
		}
		requireProtocol(previousEnd === frame['data'].byteLength, 'unexpected output padding');
	}
	// Every property consumed by the host was validated above; no worker objects escape this boundary unchecked.
	return frames as WorkerFrame[];
}
