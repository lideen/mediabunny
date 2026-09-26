/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input, InputDisposedError } from '../input';

export const LXF_CLOCK = 720000;
export const LXF_STEP = 28800;
export const LXF_WINDOW = 1024 * 1024;
const SIGNATURE = [76, 69, 73, 84, 67, 72, 0, 0];
export class LxfError extends Error {}
export function requireLxf(condition: unknown, message: string): asserts condition {
	if (!condition) throw new LxfError(`Unsupported or invalid LXF: ${message}`);
}
export const isLxfSignature = (bytes: Uint8Array, offset = 0) =>
	SIGNATURE.every((value, index) => bytes[offset + index] === value);

export type LxfPacket = {
	offset: number; end: number; type: number; timestamp: number; duration: number;
	payload: number; size: number; format: number; channels: number;
};

class LxfMultipleSegmentsError extends LxfError {
	constructor(public packet: LxfPacket) {
		super('Unsupported LXF: multiple segments');
	}
}

const parse = (bytes: Uint8Array, offset: number, fileSize: number): LxfPacket => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (at: number) => view.getUint32(at, true);
	const ticks = (at: number) => {
		const value = view.getBigUint64(at, true);
		requireLxf(value <= BigInt(Number.MAX_SAFE_INTEGER), 'timestamp exceeds exact integer range');
		return Number(value);
	};
	requireLxf(bytes.length >= 72 && isLxfSignature(bytes) && u32(8) === 1, 'version-1 envelope required');
	const length = u32(12);
	requireLxf(length >= 72 && length <= 256 && length % 4 === 0 && bytes.length === length, 'header length');
	let sum = 0;
	for (let i = 0; i < length; i += 4) sum = (sum + u32(i)) >>> 0;
	requireLxf(sum === 0, 'header checksum');
	const type = u32(16);
	const timestamp = ticks(24);
	const duration = ticks(32);
	const format = u32(40);
	requireLxf(u32(20) === 0 && [0, 1, 2].includes(type), 'stream ID or packet type');
	requireLxf(duration > 0 && Number.isSafeInteger(timestamp + duration), 'invalid packet interval');
	let payload = offset + length;
	let size = u32(44);
	let channels = 0;
	if (type === 0) {
		requireLxf((format & 15) === 3 && ((format >>> 4) & 127) === 1
			&& ((format >>> 11) & 7) === 1 && ((format >>> 22) & 3) === 0, 'closed all-I N=1/M=1 video required');
		payload += u32(52) + u32(60);
		requireLxf(duration === LXF_STEP, '25 fps video required');
	} else if (type === 1) {
		const mask = u32(44);
		channels = Math.log2(mask + 1);
		requireLxf(format === 0x618 && Number.isInteger(channels) && channels >= 1 && channels <= 8,
			'packed PCM24 with contiguous channel mask required');
		const plane = u32(48);
		requireLxf(plane === 5760 && duration === LXF_STEP, 'PCM sample count or duration');
		size = plane * channels;
	} else {
		requireLxf(format === 1 && size === 120 && u32(48) <= 65536, 'segment metadata layout');
		size += u32(48);
	}
	const end = payload + size;
	requireLxf(size > 0 && Number.isSafeInteger(end) && end <= fileSize && end > offset
		&& end - offset <= 2 * LXF_WINDOW, 'packet extent exceeds file or 2 MiB limit');
	const packet = { offset, end, type, timestamp, duration, payload, size, format, channels };
	if (type === 2 && offset !== 0) throw new LxfMultipleSegmentsError(packet);
	return packet;
};

/** A single navigation transaction. Search accounting includes uncached successor-header reads. */
export class LxfReader {
	private remaining: number;
	private windows = 0;
	private window: { start: number; bytes: Uint8Array } | null = null;
	constructor(private input: Input, public size: number, public signal?: AbortSignal, budget = 12 * LXF_WINDOW) {
		this.remaining = budget;
	}

	check() {
		this.signal?.throwIfAborted();
		if (this.input._disposed) throw new InputDisposedError();
	}

	async bytes(start: number, length: number) {
		this.check();
		requireLxf(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(length) && length >= 0
			&& Number.isSafeInteger(start + length) && start + length <= this.size, 'finite read bounds');
		if (this.window && start >= this.window.start
			&& start + length <= this.window.start + this.window.bytes.length) {
			return this.window.bytes.subarray(start - this.window.start, start - this.window.start + length);
		}
		if (length > this.remaining) throw new Error('Unsupported LXF: navigation byte budget exhausted');
		this.remaining -= length;
		const result = await this.input._reader.source._read(
			start, start + length, start, start + length, true, this.signal,
		);
		this.check();
		requireLxf(result, 'truncated read');
		return result.bytes.subarray(start - result.offset, start - result.offset + length);
	}

	async header(offset: number) {
		const prefix = await this.bytes(offset, 72);
		requireLxf(isLxfSignature(prefix), 'packet signature');
		const size = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(12, true);
		requireLxf(size >= 72 && size <= 256 && size % 4 === 0, 'header length');
		return parse(size === 72 ? prefix : await this.bytes(offset, size), offset, this.size);
	}

	async linked(packet: LxfPacket) {
		if (packet.end === this.size) return;
		const next = await this.header(packet.end);
		if (packet.type !== 2 && next.type !== 2) {
			requireLxf(next.timestamp >= packet.timestamp && next.timestamp <= packet.timestamp + packet.duration,
				'noncontiguous packet timestamps');
		}
	}

	async scan(start: number, known: Iterable<LxfPacket>) {
		const knownPackets = [...known];
		requireLxf(this.windows++ < 12, '12 search windows exhausted');
		const data = await this.bytes(start, Math.min(LXF_WINDOW, this.size - start));
		this.window = { start, bytes: data };
		const found: LxfPacket[] = [];
		for (let i = 0; i + 8 <= data.length; i++) {
			if (!isLxfSignature(data, i)) continue;
			const position = start + i;
			const encloses = (p: LxfPacket) => p.offset < position && position < p.end;
			if (knownPackets.some(encloses) || found.some(encloses)) continue;
			let packet: LxfPacket;
			try {
				packet = await this.header(position);
			} catch (error) {
				if (error instanceof LxfMultipleSegmentsError) {
					// A signature in unvisited payload is not a boundary until its successor is proved.
					try {
						await this.linked(error.packet);
					} catch (successorError) {
						if (successorError instanceof LxfMultipleSegmentsError) throw successorError;
						if (successorError instanceof LxfError) continue;
						throw successorError;
					}
					throw error;
				}
				if (error instanceof LxfError) continue;
				throw error;
			}
			try {
				await this.linked(packet);
			} catch (error) {
				if (error instanceof LxfMultipleSegmentsError) throw error;
				if (error instanceof LxfError) continue;
				throw error;
			}
			requireLxf(found.length < 256, 'scan anchor budget exhausted');
			found.push(packet);
			i = packet.end - start - 1;
		}
		return found;
	}
}
