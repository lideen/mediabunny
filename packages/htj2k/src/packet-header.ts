/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { requireHt } from './codestream.js';

/** One-layer HT packet headers, with fresh inclusion and zero-plane trees for each subband precinct. */
export const readPacketBodyLength = async (
	take: (length: number) => Promise<Uint8Array>,
	shapes: [number, number][],
) => {
	let left = 0;
	let value = 0;
	let stuffed = false;
	const byte = async () => {
		value = (await take(1))[0]!;
		requireHt(!stuffed || value < 128, 'packet bit stuffing');
		left = stuffed ? 7 : 8;
		stuffed = value === 255;
	};
	const bits = async (n = 1) => {
		requireHt(n <= 40, 'packet length bit limit');
		let result = 0;
		for (let i = 0; i < n; i++) {
			if (!left) await byte();
			result = result * 2 + ((value >> --left) & 1);
		}
		return result;
	};
	const passCount = async () => {
		if (!(await bits())) return 1;
		if (!(await bits())) return 2;
		const short = await bits(2);
		if (short < 3) return 3 + short;
		const medium = await bits(5);
		return medium < 31 ? 6 + medium : 37 + await bits(7);
	};
	let body = 0;
	if (await bits()) {
		for (const [width, height] of shapes) {
			const depth = Math.ceil(Math.log2(Math.max(width, height)));
			const inclusion = new Map<string, number>();
			const zeroPlanes = new Map<string, number>();
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					let included = true;
					for (let level = depth; level >= 0; level--) {
						const key = `${level}:${x >> level}:${y >> level}`;
						if (!inclusion.has(key)) inclusion.set(key, await bits());
						if (!inclusion.get(key)) {
							included = false;
							break;
						}
					}
					if (!included) continue;
					let totalZeroPlanes = 0;
					for (let level = depth; level >= 0; level--) {
						const key = `${level}:${x >> level}:${y >> level}`;
						if (!zeroPlanes.has(key)) {
							let zeros = 0;
							while (!(await bits())) requireHt(++zeros < 64, 'zero-plane tag-tree limit');
							zeroPlanes.set(key, zeros);
						}
						totalZeroPlanes += zeroPlanes.get(key)!;
						requireHt(totalZeroPlanes < 64, 'zero-plane tag-tree limit');
					}
					const passes = await passCount();
					// HT placeholder passes contribute to the cleanup length's bit count, not body segments.
					const placeholders = Math.floor((passes - 1) / 3) * 3;
					let lblock = 3;
					while (await bits()) requireHt(++lblock <= 32, 'Lblock limit');
					const cleanup = await bits(lblock + Math.floor(Math.log2(placeholders + 1)));
					requireHt(cleanup >= 2 && cleanup < 65535, 'HT cleanup length');
					body += cleanup;
					const actual = passes - placeholders;
					if (actual > 1) {
						const refinement = await bits(lblock + (actual > 2 ? 1 : 0));
						requireHt(refinement < 2047, 'HT refinement length');
						body += refinement;
					}
				}
			}
		}
	}
	if (stuffed) await byte();
	return body;
};
