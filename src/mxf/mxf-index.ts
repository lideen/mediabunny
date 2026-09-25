/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { batch, equalRationals, hex, position, rational, requireMxf, uint } from './mxf-metadata';

export const PARTITION_PREFIX = '060e2b34020501010d01020101';
export const FILL_KEYS = ['060e2b34010101010301021001000000', '060e2b34010101020301021001000000'];
export const INDEX_KEYS = ['060e2b34025301010d01020101100100', '060e2b34021301010d01020101100100'];
const RIP = '060e2b34020501010d01020101110100';

export type MxfKlv = { key: string; offset: number; size: number; end: number; prefetchEnd?: number };
export type MxfPartition = {
	headerSize: number; indexSize: number; bodySid: number; indexSid: number;
	previous: number; footer: number; bodyOffset: number;
};
type Region = { start: number; end: number };
type Partition = MxfPartition & { offset: number; packEnd: number; end: number; regions?: Promise<{
	index: Region; end: number;
}>; bodyStart?: Promise<number>; segments?: Promise<Segment[]>; };
type IndexedTrack = { bodySid: number; indexSid: number; trackNumber: number;
	rate: ReturnType<typeof rational>; editUnitCount: number; legacyAvc: boolean; opAtom: boolean; };
type Segment = {
	start: number; duration: number; rate: ReturnType<typeof rational>; byteCount: number;
	bodySid: number; indexSid: number; slices: number; positions: number;
	deltas: { position: number; slice: number; delta: number }[];
	entries: number; entrySize: number; entryCount: number;
};
type IndexReader = {
	bytes(offset: number, size: number, prefetchEnd?: number, requireFiniteRange?: boolean,
		signal?: AbortSignal): Promise<Uint8Array>;
	klv(offset: number, signal?: AbortSignal, windowBytes?: number): Promise<MxfKlv>;
	partition(klv: MxfKlv, offset: number, signal?: AbortSignal): Promise<MxfPartition>;
	countedRegion(offset: number, size: number, kind: 'header' | 'index', signal?: AbortSignal): Promise<Region>;
};

/** ST 377-1 partition directory and on-demand index entries. Never stores the IndexEntryArray. */
export class MxfIndex {
	private directory?: Promise<Partition[]>;
	private pendingOwners = new WeakMap<Promise<unknown>, AbortSignal>();
	private entryWindows = new Map<string, Promise<Uint8Array>>();
	constructor(private reader: IndexReader, private size: number, private footer: number) {}

	private readerFor(signal?: AbortSignal): IndexReader {
		if (!signal) return this.reader;
		const read = async <T>(operation: () => Promise<T>) => {
			signal.throwIfAborted();
			const value = await operation();
			signal.throwIfAborted();
			return value;
		};
		return {
			bytes: (offset, size) => read(() => this.reader.bytes(offset, size, undefined, false, signal)),
			klv: (offset, _, windowBytes) => read(() => this.reader.klv(offset, signal, windowBytes)),
			partition: (klv, offset) => read(() => this.reader.partition(klv, offset, signal)),
			countedRegion: (offset, size, kind) => read(() => this.reader.countedRegion(offset, size, kind, signal)),
		};
	}

	// Completed metadata remains shared. A canceled builder must not poison another navigation's cached promise.
	private async cached<T>(get: () => Promise<T> | undefined, set: (value: Promise<T> | undefined) => void,
		create: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		while (true) {
			signal?.throwIfAborted();
			let pending = get();
			if (!pending || this.pendingOwners.get(pending)?.aborted) {
				pending = create();
				set(pending);
				if (signal) this.pendingOwners.set(pending, signal);
				const task = pending;
				void task.then(() => this.pendingOwners.delete(task), () => {});
			}
			try {
				const result = await pending;
				signal?.throwIfAborted();
				return result;
			} catch (error) {
				if (signal?.aborted || !this.pendingOwners.get(pending)?.aborted) throw error;
				if (get() === pending) set(undefined);
			}
		}
	}

	private getDirectory(signal?: AbortSignal) {
		return this.cached(() => this.directory, (value) => {
			this.directory = value;
		},
		() => this.partitions(signal), signal);
	}

	private async entry(s: Segment, index: number) {
		const relative = index - s.start;
		const start = Math.floor(relative / 128) * 128;
		const count = Math.min(128, s.entryCount - start);
		const key = `${s.entries}:${start}`;
		let pending = this.entryWindows.get(key);
		if (!pending) {
			pending = this.reader.bytes(s.entries + start * s.entrySize, count * s.entrySize);
			if (this.entryWindows.size >= 16) this.entryWindows.delete(this.entryWindows.keys().next().value!);
			this.entryWindows.set(key, pending);
		}
		const bytes = await pending;
		return bytes.subarray((relative - start) * s.entrySize, (relative - start + 1) * s.entrySize);
	}

	private async temporalEntries(start: number, end: number, track: IndexedTrack) {
		const entries = new Map<number, Uint8Array>();
		for (const p of await this.getDirectory()) {
			if (!p.indexSize || p.indexSid !== track.indexSid) continue;
			for (const s of await this.segments(p)) {
				if (s.bodySid !== track.bodySid || s.start >= end || s.start + s.duration <= start) continue;
				requireMxf(equalRationals(s.rate, track.rate) && !s.positions && !s.byteCount
					&& s.deltas.some(delta => delta.position === 255)
					&& s.start + s.duration <= track.editUnitCount, 'unsupported AVC temporal index');
				for (let i = Math.max(start, s.start); i < Math.min(end, s.start + s.duration); i++) {
					const entry = await this.entry(s, i);
					requireMxf(!(entry[2]! & 0x08), 'AVC temporal offset overflow is unsupported');
					const previous = entries.get(i);
					requireMxf(!previous || hex(previous) === hex(entry), 'conflicting repeated index entries');
					entries.set(i, entry);
				}
			}
		}
		for (let i = start; i < end; i++) requireMxf(entries.has(i), 'missing AVC temporal index entry');
		return entries;
	}

	async resolvePresentation(presentation: number, track: IndexedTrack) {
		const entry = (await this.temporalEntries(presentation, presentation + 1, track)).get(presentation)!;
		const decode = presentation + (entry[0]! << 24 >> 24);
		requireMxf(decode >= 0 && decode < track.editUnitCount, 'AVC temporal offset outside track');
		return decode;
	}

	async resolveDecode(decode: number, track: IndexedTrack) {
		// ST 377-1: d = p + TemporalOffset[p], not p = d + TemporalOffset[d].
		const entries = await this.temporalEntries(Math.max(0, decode - 127),
			Math.min(track.editUnitCount, decode + 129), track);
		const matches = [...entries].filter(([p, entry]) => p + (entry[0]! << 24 >> 24) === decode);
		requireMxf(matches.length === 1, 'AVC temporal index must have a unique inverse');
		const entry = entries.get(decode)!;
		if (track.legacyAvc) {
			// These producers store positive GOP distances, contrary to ST 381-3. Validate the
			// observed layout, but never use its recovery pictures as decoder restart keys.
			const distance = entry[1]!;
			const access = decode - distance;
			requireMxf(distance <= 127 && access >= 0, 'legacy AVC GOP distance out of range');
			const accessEntry = entries.get(access)!;
			requireMxf(accessEntry[2] === 0xc0 && accessEntry[1] === 0
				&& ![...entries].some(([i, value]) => i > access && i <= decode && value[2] === 0xc0),
			'legacy AVC GOP distance disagrees with access point');
			requireMxf(decode === access || [0x22, 0x33].includes(entry[2]!), 'unsupported legacy AVC picture flags');
			const first = (await this.temporalEntries(0, 1, track)).get(0)!;
			requireMxf(first[0] === 0 && first[1] === 0 && first[2] === 0xc0,
				'legacy AVC must start at an unreordered access point');
			return { presentation: matches[0]![0], key: 0, isKey: decode === 0, requiresParameters: decode === access };
		}
		const key = decode + (entry[1]! << 24 >> 24);
		requireMxf(key >= 0 && key <= decode, 'AVC key frame offset outside supported closed GOP');
		const keyEntry = (await this.temporalEntries(key, key + 1, track)).get(key)!;
		requireMxf((keyEntry[2]! & 0xb7) === 0x84 && keyEntry[1] === 0,
			'AVC requires an IDR random access point, not an open GOP or recovery point');
		requireMxf(keyEntry[2]! & 0x40, 'AVC random access requires an in-band SPS flag');
		requireMxf(![...entries].some(([i, value]) => i > key && i <= decode && (value[2]! & 0x87) === 0x84),
			'AVC key frame offset skips an intervening IDR');
		// ST 381-3 permits all four strict prediction-bit combinations for P/B pictures.
		requireMxf(decode === key || (!(entry[2]! & 0x80) && [2, 3, 6, 7].includes(entry[2]! & 7)),
			'unsupported AVC index picture flags');
		const presentation = matches[0]![0];
		requireMxf(keyEntry[0] === 0 && presentation >= key
			&& ![...entries].some(([i, value]) => i > decode && i <= presentation && (value[2]! & 0x87) === 0x84),
		'AVC temporal reordering crosses an IDR boundary');
		return { presentation, key, isKey: decode === key };
	}

	private async partitions(signal?: AbortSignal) {
		const r = this.readerFor(signal);
		if (this.footer) {
			requireMxf(this.footer < this.size, 'footer partition exceeds file');
			const start = Math.max(this.footer, this.size - 4096);
			await r.bytes(start, this.size - start);
		}
		const length = uint(await r.bytes(this.size - 4, 4), 4);
		const offsets: { offset: number; bodySid?: number }[] = [];
		let end = this.size;
		if (length >= 21 && length <= Math.min(this.size, 1024 * 1024)) {
			const offset = this.size - length;
			if (hex(await r.bytes(offset, 16)) === RIP) {
				const klv = await r.klv(offset);
				requireMxf(klv.end === this.size && klv.size >= 28 && (klv.size - 4) % 12 === 0,
					'invalid Random Index Pack length');
				const data = await r.bytes(klv.offset, klv.size);
				requireMxf(uint(data.subarray(-4), 4) === length, 'Random Index Pack trailing length');
				for (let i = 0; i < data.length - 4; i += 12) {
					const offset = uint(data.subarray(i + 4, i + 12), 8);
					requireMxf(offset < this.size - length
						&& (offsets.length ? offset > offsets.at(-1)!.offset : offset === 0),
					'invalid Random Index Pack partition order');
					offsets.push({ offset, bodySid: uint(data.subarray(i, i + 4), 4) });
					requireMxf(offsets.length <= 10000, 'partition directory limit exceeded');
				}
				end = offset;
			}
		}
		const result: Partition[] = [];
		const read = async (offset: number): Promise<Partition> => {
			// Even an empty partition has 88 value bytes plus a 17-byte minimum KLV header.
			await r.bytes(offset, 105);
			const klv = await r.klv(offset);
			requireMxf(klv.key.startsWith(PARTITION_PREFIX)
				&& ['02', '03', '04'].includes(klv.key.slice(26, 28)) && klv.key.endsWith('0400'),
			'index directory does not point to a closed complete partition');
			requireMxf((result.length === 0) === (klv.key.slice(26, 28) === '04'), 'missing footer partition');
			requireMxf((offset === 0) === (klv.key.slice(26, 28) === '02'), 'misplaced header partition');
			const pack = await r.partition(klv, offset);
			requireMxf(pack.previous < offset || offset === 0, 'invalid previous partition pointer');
			requireMxf(klv.end <= end, 'overlapping partitions');
			const partition = { ...pack, offset, packEnd: klv.end, end };
			end = offset;
			return partition;
		};
		if (offsets.length) {
			for (let i = offsets.length - 1; i >= 0; i--) {
				const entry = offsets[i]!;
				const p = await read(entry.offset);
				requireMxf(p.bodySid === entry.bodySid && p.previous === (offsets[i - 1]?.offset ?? 0),
					'Random Index Pack disagrees with partition');
				result.push(p);
			}
		} else if (this.footer) {
			let offset = this.footer;
			while (true) {
				requireMxf(result.length < 10000, 'partition directory limit exceeded');
				const p = await read(offset);
				result.push(p);
				if (offset === 0) break;
				offset = p.previous;
			}
		}
		for (const p of result) {
			requireMxf(!p.footer || p.footer === result[0]!.offset, 'inconsistent footer partition pointer');
		}
		result.reverse();
		const bodyOffsets = new Map<number, number>();
		for (const p of result) {
			if (!p.bodySid) continue;
			const previous = bodyOffsets.get(p.bodySid);
			requireMxf(previous === undefined ? p.bodyOffset === 0 : p.bodyOffset > previous,
				'nonmonotonic body stream offsets');
			bodyOffsets.set(p.bodySid, p.bodyOffset);
		}
		return result;
	}

	private regions(p: Partition, signal?: AbortSignal) {
		const reader = this.readerFor(signal);
		return this.cached(() => p.regions, (value) => {
			p.regions = value;
		}, async () => {
			const header = await reader.countedRegion(p.packEnd, p.headerSize, 'header');
			const index = await reader.countedRegion(header.end, p.indexSize, 'index');
			requireMxf(index.end <= p.end, 'partition regions overlap next partition');
			return { index, end: index.end };
		}, signal);
	}

	private bodyStart(p: Partition, signal?: AbortSignal) {
		const reader = this.readerFor(signal);
		return this.cached(() => p.bodyStart, (value) => {
			p.bodyStart = value;
		}, async () => {
			let offset = (await this.regions(p, signal)).end;
			while (offset < p.end) {
				const klv = await reader.klv(offset);
				if (!FILL_KEYS.includes(klv.key)) break;
				offset = klv.end;
			}
			requireMxf(offset <= p.end, 'alignment Fill exceeds partition');
			return offset;
		}, signal);
	}

	private async readSegment(klv: MxfKlv, signal?: AbortSignal): Promise<Segment> {
		const reader = this.readerFor(signal);
		await reader.bytes(klv.offset, Math.min(klv.size, 512));
		const fields = new Map<number, { offset: number; size: number }>();
		let offset = klv.offset;
		while (offset < klv.end) {
			requireMxf(offset + 4 <= klv.end, 'truncated index property');
			const head = await reader.bytes(offset, 4);
			const tag = uint(head.subarray(0, 2), 2);
			let size = uint(head.subarray(2), 2);
			let start = offset + 4;
			if (klv.key === INDEX_KEYS[1]) {
				size = head[2]!;
				start = offset + 3;
				if (size & 128) {
					const count = size & 127;
					requireMxf(count > 0 && count <= 8 && start + count <= klv.end, 'invalid index BER length');
					size = uint(await reader.bytes(start, count), count);
					start += count;
				}
			}
			requireMxf(Number.isSafeInteger(start + size) && start + size <= klv.end && !fields.has(tag),
				'invalid index property length or duplicate tag');
			fields.set(tag, { offset: start, size });
			offset = start + size;
		}
		const value = async (tag: number, size: number, optional = false) => {
			const field = fields.get(tag);
			if (!field && optional) return new Uint8Array(size);
			requireMxf(field && field.size === size, 'missing or invalid index property');
			return reader.bytes(field.offset, field.size);
		};
		const slices = uint(await value(0x3f08, 1), 1);
		const positions = uint(await value(0x3f0e, 1, true), 1);
		const deltas = [];
		const delta = fields.get(0x3f09);
		if (delta) {
			requireMxf(delta.size <= 8 + 256 * 6, 'index delta array limit exceeded');
			for (const data of batch(await reader.bytes(delta.offset, delta.size), 6)) {
				requireMxf(data[1]! <= slices, 'index delta slice out of range');
				requireMxf(data[0] === 255 || data[0]! <= positions, 'index position table reference out of range');
				deltas.push({ position: data[0]!, slice: data[1]!, delta: uint(data.subarray(2), 4) });
			}
		}
		if (!deltas.length) deltas.push({ position: 0, slice: 0, delta: 0 });
		const entrySize = 11 + 4 * slices + 8 * positions;
		const entries = fields.get(0x3f0a);
		let entryCount = 0;
		if (entries) {
			requireMxf(entries.size >= 8, 'truncated index entry array');
			const head = await reader.bytes(entries.offset, 8);
			entryCount = uint(head.subarray(0, 4), 4);
			requireMxf(uint(head.subarray(4), 4) === entrySize && entries.size === 8 + entryCount * entrySize,
				'invalid index entry array length');
		}
		const start = position(await value(0x3f0c, 8));
		const duration = position(await value(0x3f0d, 8));
		const byteCount = uint(await value(0x3f05, 4), 4);
		requireMxf(Number.isSafeInteger(start + duration), 'index duration overflow');
		requireMxf(byteCount || (duration > 0 && entryCount >= duration && entryCount <= duration + 1),
			'index duration and entry count disagree');
		return { start, duration, byteCount, slices, positions, deltas, entrySize, entryCount,
			entries: entries ? entries.offset + 8 : 0,
			rate: rational(await value(0x3f0b, 8)),
			bodySid: uint(await value(0x3f07, 4), 4), indexSid: uint(await value(0x3f06, 4), 4) };
	}

	private segments(p: Partition, signal?: AbortSignal) {
		const reader = this.readerFor(signal);
		return this.cached(() => p.segments, (value) => {
			p.segments = value;
		}, async () => {
			const { index } = await this.regions(p, signal);
			const result: Segment[] = [];
			const ends = new Map<number, number>();
			let offset = index.start;
			while (offset < index.end) {
				const klv = await reader.klv(offset);
				requireMxf(klv.end <= index.end, 'index KLV exceeds region');
				if (INDEX_KEYS.includes(klv.key)) {
					const segment = await this.readSegment(klv, signal);
					requireMxf(segment.indexSid === p.indexSid, 'index SID disagrees with partition');
					requireMxf(segment.start >= (ends.get(segment.bodySid) ?? 0),
						'overlapping or unordered index segments');
					ends.set(segment.bodySid, segment.duration ? segment.start + segment.duration : Infinity);
					result.push(segment);
				} else requireMxf(FILL_KEYS.includes(klv.key), 'unexpected KLV in index region');
				offset = klv.end;
			}
			return result;
		}, signal);
	}

	async locate(index: number, track: IndexedTrack, temporal = false, signal?: AbortSignal,
		prefetchBytes = 0): Promise<MxfKlv | null> {
		const partitions = await this.getDirectory(signal);
		let result: MxfKlv | null = null;
		for (let i = partitions.length - 1; i >= 0; i--) {
			const p = partitions[i]!;
			if (!p.indexSize || p.indexSid !== track.indexSid) continue;
			for (const s of await this.segments(p, signal)) {
				if (s.bodySid !== track.bodySid || index < s.start
					|| (s.duration && index >= s.start + s.duration)) continue;
				requireMxf(!s.duration || s.start + s.duration <= track.editUnitCount,
					'index duration exceeds track metadata');
				const location = await this.locateSegment(s, index, track, partitions, temporal, signal, prefetchBytes);
				if (!location) return null;
				requireMxf(!result || (result.offset === location.offset && result.size === location.size),
					'conflicting repeated index entries');
				result = location;
			}
		}
		return result;
	}

	private async locateSegment(
		s: Segment, index: number, track: IndexedTrack, partitions: Partition[], temporal: boolean,
		signal?: AbortSignal, prefetchBytes = 0,
	) {
		const reader = this.readerFor(signal);
		if (!equalRationals(s.rate, track.rate) || s.positions) return null;
		requireMxf(!track.opAtom || (!s.slices && s.deltas.length === 1
			&& s.deltas[0]!.position === 255 && s.deltas[0]!.delta === 0),
		'OPAtom requires a single frame-wrapped index element');
		// ST 377-1's different-sized first CBE edit unit needs a two-segment calculation.
		// Only ordinary whole-container CBE tables use the multiplication below.
		if (s.byteCount && (s.start !== 0 || (s.duration !== 0 && s.duration !== track.editUnitCount)
			|| s.slices || s.entryCount)) return null;
		let streamOffset = index * s.byteCount;
		let streamEnd: number | null = s.byteCount ? streamOffset + s.byteCount : null;
		let entry: Uint8Array | null = null;
		if (!s.byteCount) {
			const relative = index - s.start;
			const count = Math.min(2, s.entryCount - relative);
			entry = await reader.bytes(s.entries + relative * s.entrySize, count * s.entrySize);
			if (!temporal && track.trackNumber >>> 24 === 0x15
				&& (entry[0] || entry[1] || (entry[2]! & 0x30))) return null;
			streamOffset = uint(entry.subarray(3, 11), 8);
			if (count === 2) streamEnd = uint(entry.subarray(s.entrySize + 3, s.entrySize + 11), 8);
			else if (track.opAtom && index + 1 < track.editUnitCount) {
				// An index segment can end inside a body partition without a terminal entry.
				const next = (await this.temporalEntries(index + 1, index + 2, track)).get(index + 1)!;
				streamEnd = uint(next.subarray(3, 11), 8);
			}
		}
		requireMxf(Number.isSafeInteger(streamOffset), 'index stream offset overflow');
		requireMxf(streamEnd === null || (Number.isSafeInteger(streamEnd) && streamEnd > streamOffset),
			'nonmonotonic index stream offsets');
		for (const delta of s.deltas) {
			if (delta.position !== (temporal ? 255 : 0)) continue;
			const slice = delta.slice
				? uint(entry!.subarray(11 + (delta.slice - 1) * 4, 15 + (delta.slice - 1) * 4), 4)
				: 0;
			const stream = streamOffset + slice + delta.delta;
			requireMxf(Number.isSafeInteger(stream), 'index element offset overflow');
			requireMxf(streamEnd === null || stream < streamEnd, 'index delta exceeds edit unit');
			let body: Partition | undefined;
			for (const candidate of partitions) {
				if (candidate.bodySid === track.bodySid && candidate.bodyOffset <= stream) body = candidate;
			}
			requireMxf(body, 'index offset outside body stream');
			const bodyStart = await this.bodyStart(body, signal);
			const physical = bodyStart + stream - body.bodyOffset;
			requireMxf(Number.isSafeInteger(physical) && physical >= bodyStart && physical + 17 <= body.end,
				'index offset outside body partition');
			// Only a single, unsliced element at the edit-unit start is an unambiguous prefix candidate.
			// Missing next-entry bounds are safe only for the track's last edit unit.
			const prefix = prefetchBytes > 25 && !temporal && !s.slices && s.deltas.length === 1
				&& delta.delta === 0 && (streamEnd !== null || index + 1 === track.editUnitCount);
			const windowBytes = prefix
				? Math.min(prefetchBytes, this.size - physical, body.end - physical,
						streamEnd === null ? Infinity : streamEnd - stream)
				: undefined;
			const klv = await reader.klv(physical, undefined, windowBytes);
			requireMxf(klv.end <= body.end, 'indexed element exceeds partition');
			requireMxf(!track.opAtom || klv.end === (streamEnd === null
				? body.end
				: Math.min(body.end, physical + streamEnd - stream)),
			'OPAtom requires one essence element per edit unit');
			requireMxf(streamEnd === null || stream + klv.end - physical <= streamEnd,
				'indexed element exceeds edit unit');
			requireMxf(klv.key.startsWith('060e2b34'), 'index does not point to a KLV key');
			const expectedKey = `060e2b34010201010d010301${track.trackNumber.toString(16).padStart(8, '0')}`;
			requireMxf(!prefix || klv.key === expectedKey, 'indexed prefix does not point to the expected essence key');
			if (klv.key === expectedKey) {
				return { ...klv, prefetchEnd: body.end };
			}
		}
		return null;
	}
}
