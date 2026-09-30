/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { batch, MetadataSet, P, requireMxf, uint } from './mxf-metadata';

export type St331Header = { samples: number; valid: number };
export type St331Samples = { data: Uint8Array; valid: number };
const BURST_SYNC = [[12, 0xf872, 0x4e1f], [8, 0x6f872, 0x54e1f], [4, 0x96f872, 0xa54e1f]] as const;

export const checkAes3ChannelStatus = (descriptor: MetadataSet, channels: number) => {
	const offset = descriptor.properties.get(P.blockStartOffset);
	requireMxf(!offset || uint(offset, 2) < 192, 'AES3 block start offset');
	const modesProperty = descriptor.properties.get(P.channelStatusMode);
	const fixedProperty = descriptor.properties.get(P.fixedChannelStatusData);
	const modes = modesProperty ? batch(modesProperty, 1) : [];
	const fixed = fixedProperty ? batch(fixedProperty, 24) : [];
	requireMxf(!modesProperty || modes.length === channels, 'AES3 channel status mode count');
	requireMxf(!fixedProperty || fixed.length === channels, 'AES3 fixed channel status count');
	for (const [channel, mode] of modes.entries()) {
		requireMxf(mode[0]! <= 3, 'unsupported AES3 external or reserved channel status mode');
		if (mode[0] === 3) {
			requireMxf(fixed[channel], 'missing AES3 fixed channel status');
			requireMxf(!(fixed[channel][0]! & 2), 'AES3 fixed channel status declares non-audio');
		}
	}
	// NONE supplies no status evidence; MINIMUM/STANDARD derive audio/non-audio from SoundEssenceCoding.
};

export const parseSt331Header = (data: Uint8Array, size: number, channels: number, pal: boolean): St331Header => {
	requireMxf(data.length === 4, 'truncated ST 331 header');
	requireMxf(!(data[0]! & 0x80), 'ST 331 usable F/V/U/C/P requires unsupported AES block classification');
	requireMxf(!(data[0]! & 0x78), 'ST 331 reserved header bits');
	// FFmpeg numbers the fractional sequence 1..5; BMX uses 0..4. Counts, not phase guesses, drive timing.
	requireMxf((data[0]! & 7) <= 5, 'ST 331 reserved sequence count');
	const samples = data[1]! | data[2]! << 8;
	requireMxf(pal ? samples === 1920 : samples === 1601 || samples === 1602,
		'ST 331 sample count outside the supported D-10 subset');
	requireMxf(size === 4 + 32 * samples, 'ST 331 payload length disagrees with sample count');
	const valid = data[3]!;
	requireMxf((valid >>> channels) === 0, 'ST 331 valid slots exceed declared channels');
	return { samples, valid };
};

export const unpackSt331 = (
	current: St331Samples, channels: number, bytesPerSample: number,
	before?: St331Samples, after?: St331Samples,
) => {
	const preceding = before ? before.data.length / 32 : 0;
	const samples = current.data.length / 32;
	const count = preceding + samples + (after ? after.data.length / 32 : 0);
	const words = new Uint32Array(count * channels);
	const masks = new Uint8Array(count);
	let row = 0;
	for (const chunk of [before, current, after]) {
		if (!chunk) {
			continue;
		}
		const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
		for (let offset = 0; offset < chunk.data.length; offset += 32, row++) {
			masks[row] = chunk.valid;
			for (let channel = 0; channel < channels; channel++) {
				if (chunk.valid & (1 << channel)) {
					const word = view.getUint32(offset + channel * 4, true);
					requireMxf((word & 7) === channel, 'ST 331 valid slot channel ID mismatch');
					words[row * channels + channel] = word;
				}
			}
		}
	}

	// Conservative ST 337 framed-burst recognition, not certification of the PCM declaration.
	// Three adjacent samples on each side also cover a four-word subframe preamble crossing a KLV boundary.
	const checkBurst = (a: number, b: number, c: number, d: number) => {
		for (const [shift, pa, pb] of BURST_SYNC) {
			const mask = 0x0fffffff >>> shift;
			if (((words[a]! >>> shift) & mask) === pa && ((words[b]! >>> shift) & mask) === pb
				&& [a, b, c, d].every(i => masks[Math.floor(i / channels)]! & (1 << (i % channels)))) {
				const type = (words[c]! >>> 12) & 31;
				requireMxf(false, `ST 337 non-PCM burst (data type ${type}${type === 28 ? ', Dolby E' : ''})`);
			}
		}
	};
	for (let sample = 0; sample < count; sample++) {
		for (let channel = 0; channel < channels; channel++) {
			const i = sample * channels + channel;
			if (sample + 3 < count) {
				checkBurst(i, i + channels, i + 2 * channels, i + 3 * channels);
			}
			if (channel % 2 === 0 && sample + 1 < count) {
				checkBurst(i, i + 1, i + channels, i + channels + 1);
			}
		}
	}

	const output = new Uint8Array(samples * channels * bytesPerSample);
	for (let i = 0; i < samples * channels; i++) {
		const word = words[preceding * channels + i]!;
		const value = word >>> (bytesPerSample === 2 ? 12 : 4);
		for (let byte = 0; byte < bytesPerSample; byte++) {
			output[i * bytesPerSample + byte] = value >>> (byte * 8);
		}
	}
	// Invalid slots remain zero without changing the declared channel ordinals.
	return output;
};
