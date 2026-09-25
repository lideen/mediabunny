/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { requireHt, validDimensions } from './codestream.js';
import { readPacketBodyLength } from './packet-header.js';
import type { VideoPreparationLimits } from 'mediabunny';

/** Internal extraction boundary. All offsets are relative to the original codestream. */
export type ReducedCodestreamReader = {
	byteLength: number;
	read(start: number, end: number): Promise<Uint8Array>;
};

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PACKETS = 65536;
const MAX_BLOCKS = 262144;
const READ_WINDOW = 640 * 1024;

/** Builds a distinct, complete decode input; it is not an original encoded packet. */
export const extractReduced = async (
	reader: ReducedCodestreamReader,
	request: { width: number; height: number },
	config: { width: number; height: number; bits: number },
	limits?: Readonly<VideoPreparationLimits>,
) => {
	const maxWorkingBytes = limits?.maxWorkingBytes ?? Infinity;
	requireHt(!limits || (Number.isSafeInteger(maxWorkingBytes) && maxWorkingBytes > 0), 'working byte limit');
	const checkWorkingBytes = (bytes: number) => {
		requireHt(bytes <= maxWorkingBytes, 'preparation working byte budget');
	};
	requireHt(Number.isSafeInteger(reader.byteLength) && reader.byteLength >= 65
		&& reader.byteLength <= MAX_BYTES, 'source byte limit');
	requireHt(validDimensions(config.width, config.height) && (config.bits === 8 || config.bits === 16),
		'descriptor geometry');
	requireHt(Number.isInteger(request.width) && request.width > 0
		&& Number.isInteger(request.height) && request.height > 0, 'reduced dimensions');
	// A transport heuristic, not a coverage estimate. Parsing still determines all required bytes.
	const previewScale = Math.min(1, request.width * request.height / (480 * 270));
	const readWindow = Math.max(16 * 1024, Math.ceil(READ_WINDOW * previewScale / (16 * 1024)) * 16 * 1024);
	let position = 0;
	checkWorkingBytes(65536);
	let prefix = new Uint8Array(65536);
	let window = new Uint8Array(0);
	let windowStart = 0;
	const take = async (length: number) => {
		requireHt(Number.isSafeInteger(length) && length >= 0 && position + length <= reader.byteLength,
			'missing required packet bytes');
		if (position < windowStart || position + length > windowStart + window.length) {
			const end = Math.min(reader.byteLength, position + Math.max(length, readWindow));
			// Old window, reader-owned result, and its stable copy coexist during replacement.
			checkWorkingBytes(prefix.length + window.length + 2 * (end - position));
			window = (await reader.read(position, end)).slice();
			requireHt(window instanceof Uint8Array && window.length === end - position,
				'missing required physical coverage');
			windowStart = position;
		}
		const data = window.subarray(position - windowStart, position - windowStart + length);
		if (position + length > prefix.length) {
			const size = Math.min(MAX_BYTES, Math.max(prefix.length * 2, position + length));
			checkWorkingBytes(prefix.length + window.length + size);
			const grown = new Uint8Array(size);
			grown.set(prefix);
			prefix = grown;
		}
		prefix.set(data, position);
		position += length;
		return data;
	};
	const word = (data: Uint8Array, offset = 0) => data[offset]! * 256 + data[offset + 1]!;
	const uint = (data: Uint8Array, offset: number) => new DataView(data.buffer, data.byteOffset).getUint32(offset);
	requireHt(word(await take(2)) === 0xff4f, 'SOC required');
	let width = 0;
	let height = 0;
	let levels = -1;
	let blockWidth = 0;
	let blockHeight = 0;
	let precincts: number[] = [];
	let cap = false;
	let qcdLength: number | undefined;
	let tileStart = 0;
	let psotOffset = 0;
	for (;;) {
		requireHt(position < 65536, 'main header byte limit');
		const start = position;
		const marker = word(await take(2));
		const length = word(await take(2));
		requireHt(length >= 2 && length <= 65535, 'marker length');
		const data = await take(length - 2);
		if (marker === 0xff51) {
			requireHt(start === 2 && length === 47 && word(data) === 0x4000, 'three-component HT SIZ');
			width = uint(data, 2);
			height = uint(data, 6);
			requireHt(width === config.width && height === config.height && uint(data, 10) === 0
				&& uint(data, 14) === 0 && uint(data, 18) === width && uint(data, 22) === height
				&& uint(data, 26) === 0 && uint(data, 30) === 0 && word(data, 34) === 3, 'single zero-origin tile');
			for (let c = 0; c < 3; c++) {
				requireHt(data[36 + 3 * c] === config.bits - 1
					&& data[37 + 3 * c] === 1 && data[38 + 3 * c] === 1, 'unsigned full-sampling RGB');
			}
		} else if (marker === 0xff50) {
			requireHt(!cap && length === 8 && uint(data, 0) === 0x20000 && (word(data, 4) & 0xffe0) === 0,
				'CAP profile');
			cap = true;
		} else if (marker === 0xff52) {
			requireHt(levels === -1 && length >= 12 && data[0] === 1 && data[1] === 2
				&& word(data, 2) === 1 && data[4] === 1 && data[8] === 0x40 && data[9] === 1,
			'RPCL, one layer, MCT, explicit precincts, HT reversible COD required');
			levels = data[5]!;
			requireHt(levels >= 1 && levels <= 6 && length === 13 + levels
				&& data[6]! <= 4 && data[7]! <= 4, 'coding parameter bounds');
			blockWidth = 2 ** (data[6]! + 2);
			blockHeight = 2 ** (data[7]! + 2);
			precincts = Array.from(data.subarray(10));
			for (let r = 0; r <= levels; r++) {
				const px = precincts[r]! & 15;
				const py = precincts[r]! >> 4;
				requireHt(px <= 10 && py <= 10 && px >= (r ? 1 : 0) && py >= (r ? 1 : 0)
					&& 2 ** (px - (r ? 1 : 0)) >= blockWidth
					&& 2 ** (py - (r ? 1 : 0)) >= blockHeight, 'precinct geometry');
			}
		} else if (marker === 0xff5c) {
			requireHt(!qcdLength && length >= 4 && data[0] === 0x20, 'reversible QCD with one guard bit');
			qcdLength = data.length;
			requireHt(Array.from(data.subarray(1)).every(value => (value & 7) === 0
				&& (value >> 3) > 0 && (value >> 3) <= config.bits + 6), 'QCD exponent bounds');
		} else if (marker === 0xff90) {
			requireHt(width && cap && levels >= 1 && qcdLength === 2 + 3 * levels,
				'incomplete main header');
			requireHt(length === 10 && word(data) === 0 && data[6] === 0 && data[7] === 1
				&& start + uint(data, 2) === reader.byteLength - 2, 'one complete tile-part');
			tileStart = start;
			psotOffset = start + 6;
			requireHt(word(await take(2)) === 0xff93, 'tile overrides are unsupported');
			break;
		} else {
			requireHt(marker === 0xff64 && length >= 4, 'unsupported main-header marker');
		}
	}
	let skip = 0;
	while (skip < levels && Math.ceil(width / 2 ** (skip + 1)) >= request.width
		&& Math.ceil(height / 2 ** (skip + 1)) >= request.height) skip++;
	requireHt(skip > 0, 'request requires complete resolution');
	let retainedPackets = 0;
	const counts = precincts.map((precinct, r) => {
		const scale = 2 ** (levels - r);
		return Math.ceil(Math.ceil(width / scale) / 2 ** (precinct & 15))
			* Math.ceil(Math.ceil(height / scale) / 2 ** (precinct >> 4)) * 3;
	});
	const packets = counts.reduce((sum, count) => sum + count, 0);
	requireHt(packets <= MAX_PACKETS, 'packet count limit');
	let blocks = 0;
	for (let r = 0; r <= levels - skip; r++) {
		const scale = 2 ** (levels - r);
		for (const [bx, by] of r === 0 ? [[0, 0]] : [[1, 0], [0, 1], [1, 1]]) {
			const bw = r === 0 ? Math.ceil(width / scale) : Math.ceil((width / scale - bx!) / 2);
			const bh = r === 0 ? Math.ceil(height / scale) : Math.ceil((height / scale - by!) / 2);
			blocks += Math.ceil(bw / blockWidth) * Math.ceil(bh / blockHeight) * 3;
		}
	}
	requireHt(blocks <= MAX_BLOCKS, 'codeblock count limit');
	for (let r = 0; r <= levels; r++) {
		const scale = 2 ** (levels - r);
		const pw = 2 ** (precincts[r]! & 15);
		const ph = 2 ** (precincts[r]! >> 4);
		const nx = Math.ceil(Math.ceil(width / scale) / pw);
		const ny = Math.ceil(Math.ceil(height / scale) / ph);
		if (r > levels - skip) continue;
		for (let y = 0; y < ny; y++) {
			for (let x = 0; x < nx; x++) {
				const shapes: [number, number][] = [];
				for (const [bx, by] of r === 0 ? [[0, 0]] : [[1, 0], [0, 1], [1, 1]]) {
					const sw = r === 0 ? pw : pw / 2;
					const sh = r === 0 ? ph : ph / 2;
					const bw = r === 0 ? Math.ceil(width / scale) : Math.ceil((width / scale - bx!) / 2);
					const bh = r === 0 ? Math.ceil(height / scale) : Math.ceil((height / scale - by!) / 2);
					const w = Math.min(sw, bw - x * sw);
					const h = Math.min(sh, bh - y * sh);
					if (w > 0 && h > 0) shapes.push([Math.ceil(w / blockWidth), Math.ceil(h / blockHeight)]);
				}
				for (let c = 0; c < 3; c++) {
					const body = await readPacketBodyLength(take, shapes);
					requireHt(position + body <= reader.byteLength - 2, 'required body crosses tile boundary');
					if (body) await take(body);
					retainedPackets++;
				}
			}
		}
	}
	const requiredEnd = position;
	const omitted = packets - retainedPackets;
	requireHt(requiredEnd + omitted + 2 <= MAX_BYTES, 'derived buffer limit');
	checkWorkingBytes(prefix.length + window.length + requiredEnd + omitted + 2);
	const data = new Uint8Array(requiredEnd + omitted + 2);
	data.set(prefix.subarray(0, requiredEnd));
	new DataView(data.buffer).setUint32(psotOffset, data.length - 2 - tileStart);
	data.set([255, 217], data.length - 2);
	return {
		data, skip, width: Math.ceil(width / 2 ** skip), height: Math.ceil(height / 2 ** skip),
		source: { width, height, byteLength: reader.byteLength },
		coverage: { kind: 'RPCL-prefix' as const, requiredEnd, retainedPackets, packetsByResolution: counts },
	};
};
