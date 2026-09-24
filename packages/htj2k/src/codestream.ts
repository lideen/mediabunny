/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export const requireHt: (condition: unknown, message: string) => asserts condition = (condition, message) => {
	if (!condition) {
		throw new Error(`Unsupported or invalid HTJ2K: ${message}`);
	}
};

// Bound allocations before handing untrusted headers to the native decoder.
export const validDimensions = (width = 0, height = 0) => Number.isInteger(width) && Number.isInteger(height)
	&& width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_777_216;

export const validateCodestream = (data: Uint8Array, width: number, height: number, bits: number) => {
	requireHt(data.length >= 51 && data.length <= 128 * 1024 * 1024, 'frame byte limit');
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const u16 = (offset: number) => view.getUint16(offset);
	const u32 = (offset: number) => view.getUint32(offset);
	requireHt(u16(0) === 0xff4f && u16(2) === 0xff51 && u16(4) === 47, 'three-component SIZ required');
	requireHt(u16(6) === 0x4000 && u32(8) === width && u32(12) === height
		&& validDimensions(width, height), 'SIZ geometry or capabilities');
	requireHt(u32(16) === 0 && u32(20) === 0 && u32(24) === width && u32(28) === height
		&& u32(32) === 0 && u32(36) === 0 && u16(40) === 3, 'one full-frame tile required');
	for (let c = 0; c < 3; c++) {
		requireHt(data[42 + c * 3] === bits - 1 && data[43 + c * 3] === 1 && data[44 + c * 3] === 1,
			'SIZ must match unsigned full-resolution RGB descriptor');
	}
	let offset = 51;
	let cap = false;
	let cod = false;
	let qcd = false;
	while (offset + 4 <= data.length) {
		const marker = u16(offset);
		const length = u16(offset + 2);
		requireHt(length >= 2 && offset + 2 + length <= data.length, 'truncated marker');
		if (marker === 0xff90) {
			requireHt(cap && cod && qcd && length === 10 && u16(offset + 4) === 0
				&& data[offset + 10] === 0 && data[offset + 11] === 1, 'one complete tile-part required');
			const end = offset + u32(offset + 6);
			requireHt(end === data.length - 2 && u16(end) === 0xffd9, 'tile length or missing EOC');
			requireHt(offset + 14 <= end && u16(offset + 12) === 0xff93, 'tile-header overrides are unsupported');
			return;
		}
		if (marker === 0xff50) {
			requireHt(!cap && length === 8 && u32(offset + 4) === 0x00020000
				&& (u16(offset + 8) & 0xffe0) === 0, 'unsupported CAP');
			cap = true;
		} else if (marker === 0xff52) {
			const levels = data[offset + 9]!;
			const style = data[offset + 4]!;
			requireHt(!cod && length >= 12 && (style === 0 || style === 1)
				&& data[offset + 5]! <= 4 && u16(offset + 6) === 1 && data[offset + 8]! <= 1
				&& levels <= 6 && length === 12 + (style === 1 ? levels + 1 : 0)
				&& data[offset + 10]! <= 4 && data[offset + 11]! <= 4
				&& data[offset + 12] === 0x40 && data[offset + 13] === 1, 'unsupported COD');
			cod = true;
		} else if (marker === 0xff5c) {
			requireHt(!qcd && length >= 4 && (data[offset + 4]! & 31) === 0, 'reversible QCD required');
			qcd = true;
		} else {
			requireHt(marker === 0xff64, 'unsupported main-header marker');
		}
		offset += 2 + length;
	}
	throw new Error('Unsupported or invalid HTJ2K: missing tile data');
};
