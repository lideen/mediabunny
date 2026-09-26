/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Bitstream } from '../shared/bitstream';
import { COLOR_PRIMARIES_MAP_INVERSE, MATRIX_COEFFICIENTS_MAP_INVERSE,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE } from './misc';

export class Mpeg2HeaderError extends Error {}

const requireMpeg2: (condition: unknown, message: string) => asserts condition = (condition, message) => {
	if (!condition) {
		throw new Mpeg2HeaderError(message);
	}
};

// This bounded subset excludes user data and scalable extensions before the first slice.
// Two sequence quantization matrices fit alongside the sequence/GOP/picture headers.
export const MPEG2_HEADER_LIMIT = 512;

export const parseMpeg2Headers = (data: Uint8Array) => {
	data = data.subarray(0, MPEG2_HEADER_LIMIT);
	let width = 0;
	let height = 0;
	let frameRate = 0;
	let aspect = 0;
	let sequence = false;
	let sequenceExtension = false;
	let displayExtension = false;
	let gop = false;
	let pictureType = 0;
	let temporalReference = 0;
	let pictureExtension = false;
	let colorSpace: VideoColorSpaceInit = { fullRange: false };
	let offset = 0;
	while (offset + 4 <= data.length) {
		requireMpeg2(data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1,
			'MPEG-2 requires aligned start codes');
		const code = data[offset + 3]!;
		if (code >= 1 && code <= 0xaf) {
			requireMpeg2(pictureType && pictureExtension, 'MPEG-2 requires complete picture headers');
			requireMpeg2(!sequence || (sequenceExtension && gop), 'MPEG-2 requires sequence extension and closed GOP');
			return { width, height, frameRate, aspect, sequence, pictureType, temporalReference, colorSpace,
				sliceOffset: offset };
		}
		let end = offset + 4;
		while (end + 3 <= data.length
			&& !(data[end] === 0 && data[end + 1] === 0 && data[end + 2] === 1)) {
			end++;
		}
		requireMpeg2(end + 3 <= data.length, 'MPEG-2 header exceeds bounded prefix or is truncated');
		const bits = new Bitstream(data.subarray(offset + 4, end));
		const read = (count: number) => {
			requireMpeg2(bits.getBitsLeft() >= count, 'truncated MPEG-2 header');
			return bits.readBits(count);
		};
		if (code === 0xb3) {
			requireMpeg2(offset === 0, 'MPEG-2 sequence header must lead a key packet');
			sequence = true;
			width = read(12);
			height = read(12);
			aspect = read(4);
			const rate = read(4);
			frameRate = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60][rate] ?? 0;
			requireMpeg2(width && height && frameRate && aspect >= 1 && aspect <= 4,
				'invalid MPEG-2 sequence geometry');
			read(18);
			requireMpeg2(read(1) === 1, 'invalid MPEG-2 sequence marker');
			read(10);
			requireMpeg2(read(1) === 0, 'unsupported MPEG-2 constrained parameters');
			for (let matrix = 0; matrix < 2; matrix++) {
				if (read(1)) {
					for (let i = 0; i < 64; i++) {
						requireMpeg2(read(8) !== 0, 'invalid MPEG-2 quantization matrix');
					}
				}
			}
		} else if (code === 0xb8) {
			requireMpeg2(sequenceExtension && !gop && !pictureType, 'MPEG-2 GOP requires in-band sequence headers');
			read(12);
			requireMpeg2(read(1) === 1, 'invalid MPEG-2 GOP marker');
			read(12);
			requireMpeg2(read(1) === 1 && read(1) === 0, 'MPEG-2 requires a closed GOP without broken link');
			gop = true;
		} else if (code === 0) {
			requireMpeg2(!pictureType && (!sequence || gop), 'MPEG-2 requires one picture after sequence/GOP headers');
			temporalReference = read(10);
			pictureType = read(3);
			requireMpeg2(pictureType >= 1 && pictureType <= 3, 'unsupported MPEG-2 picture type');
			read(16);
			if (pictureType >= 2) {
				read(1);
				requireMpeg2(read(3) !== 0, 'invalid MPEG-2 forward vector code');
			}
			if (pictureType === 3) {
				read(1);
				requireMpeg2(read(3) !== 0, 'invalid MPEG-2 backward vector code');
			}
			while (read(1)) {
				read(8);
			}
		} else if (code === 0xb5) {
			const extension = read(4);
			if (extension === 1) {
				requireMpeg2(sequence && !sequenceExtension && !gop && !pictureType,
					'misplaced MPEG-2 sequence extension');
				requireMpeg2(read(8) === 0x44 && read(1) === 1 && read(2) === 1,
					'MPEG-2 requires progressive Main Profile / High Level 4:2:0');
				width += read(2) * 4096;
				height += read(2) * 4096;
				read(12);
				requireMpeg2(read(1) === 1, 'invalid MPEG-2 extension marker');
				read(8);
				requireMpeg2(read(1) === 0, 'MPEG-2 low-delay sequences are unsupported');
				frameRate *= (read(2) + 1) / (read(5) + 1);
				sequenceExtension = true;
			} else if (extension === 2) {
				requireMpeg2(sequenceExtension && !displayExtension && !gop && !pictureType,
					'misplaced MPEG-2 display extension');
				read(3);
				if (read(1)) {
					colorSpace = {
						primaries: COLOR_PRIMARIES_MAP_INVERSE[read(8)],
						transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[read(8)],
						matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[read(8)], fullRange: false,
					} as VideoColorSpaceInit;
				}
				requireMpeg2(read(14) === width && read(1) === 1 && read(14) === height,
					'MPEG-2 display extension cropping is unsupported');
				displayExtension = true;
			} else if (extension === 8) {
				requireMpeg2(pictureType && !pictureExtension, 'misplaced MPEG-2 picture extension');
				read(16);
				read(2);
				requireMpeg2(read(2) === 3 && read(1) === 0 && read(1) === 1,
					'MPEG-2 requires progressive frame pictures');
				read(4);
				requireMpeg2(read(1) === 0 && read(1) === 1 && read(1) === 1 && read(1) === 0,
					'MPEG-2 repeated fields or nonprogressive pictures are unsupported');
				pictureExtension = true;
			} else {
				requireMpeg2(false, 'unsupported MPEG-2 extension');
			}
		} else {
			requireMpeg2(false, 'unsupported MPEG-2 header before first slice');
		}
		while (bits.getBitsLeft()) {
			requireMpeg2(read(1) === 0, 'invalid MPEG-2 header padding');
		}
		offset = end;
	}
	throw new Mpeg2HeaderError('MPEG-2 picture headers exceed bounded prefix');
};
