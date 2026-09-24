/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SMPTE ST 377-1 property ULs. Local tags are resolved through the partition's primer.
export const P = {
	instance: '060e2b34010101010101150200000000',
	content: '060e2b34010101020601010402010000',
	packages: '060e2b34010101020601010405010000',
	essenceData: '060e2b34010101020601010405020000',
	packageId: '060e2b34010101010101151000000000',
	tracks: '060e2b34010101020601010406050000',
	descriptor: '060e2b34010101020601010402030000',
	trackId: '060e2b34010101020107010100000000',
	trackNumber: '060e2b34010101020104010300000000',
	sequence: '060e2b34010101020601010402040000',
	editRate: '060e2b34010101020530040500000000',
	origin: '060e2b34010101020702010301030000',
	definition: '060e2b34010101020407010000000000',
	duration: '060e2b34010101020702020101030000',
	components: '060e2b34010101020601010406090000',
	start: '060e2b34010101020702010301040000',
	sourcePackage: '060e2b34010101020601010301000000',
	sourceTrack: '060e2b34010101020601010302000000',
	channelIds: '060e2b34010101070601010307000000',
	monoSourceTrackIds: '060e2b34010101080601010308000000',
	linkedPackage: '060e2b34010101020601010601000000',
	bodySid: '060e2b34010101040103040400000000',
	indexSid: '060e2b34010101040103040500000000',
	linkedTrack: '060e2b34010101050601010305000000',
	subDescriptors: '060e2b340101010406010104060b0000',
	sampleRate: '060e2b34010101010406010100000000',
	container: '060e2b34010101020601010401020000',
	codec: '060e2b34010101020601010401030000',
	pictureCoding: '060e2b34010101020401060100000000',
	layout: '060e2b34010101010401030104000000',
	width: '060e2b34010101010401050202000000',
	height: '060e2b34010101010401050201000000',
	displayWidth: '060e2b3401010101040105010c000000',
	displayHeight: '060e2b3401010101040105010b000000',
	displayX: '060e2b3401010101040105010d000000',
	displayY: '060e2b3401010101040105010e000000',
	aspect: '060e2b34010101010401010101000000',
	audioRate: '060e2b34010101050402030101010000',
	locked: '060e2b34010101040402030104000000',
	channels: '060e2b34010101050402010104000000',
	bits: '060e2b34010101040402030304000000',
	blockAlign: '060e2b34010101050402030201000000',
	soundCoding: '060e2b34010101020402040200000000',
	timecodeStart: '060e2b34010101020702010301050000',
	timecodeBase: '060e2b34010101020404010102060000',
	timecodeDrop: '060e2b34010101010404010105000000',
} as const;

export const hex = (bytes: Uint8Array) => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');

export const requireMxf: (condition: unknown, message: string) => asserts condition = (condition, message) => {
	if (!condition) throw new Error(`Unsupported or invalid MXF: ${message}`);
};

export const uint = (bytes: Uint8Array, size: number) => {
	requireMxf(bytes.length === size, 'incorrect integer length');
	let value = 0;
	for (const byte of bytes) value = value * 256 + byte;
	requireMxf(Number.isSafeInteger(value), 'integer exceeds safe range');
	return value;
};

export const position = (bytes: Uint8Array) => {
	requireMxf(bytes.length === 8 && bytes[0]! < 128, 'negative or unknown position/duration');
	return uint(bytes, 8);
};

export const rational = (bytes: Uint8Array) => {
	requireMxf(bytes.length === 8, 'invalid rational');
	const numerator = uint(bytes.subarray(0, 4), 4);
	const denominator = uint(bytes.subarray(4), 4);
	requireMxf(numerator > 0 && numerator < 0x80000000 && denominator > 0 && denominator < 0x80000000,
		'nonpositive rational');
	return { numerator, denominator };
};

export const batch = (bytes: Uint8Array, itemSize: number) => {
	requireMxf(bytes.length >= 8, 'truncated batch');
	const count = uint(bytes.subarray(0, 4), 4);
	requireMxf(uint(bytes.subarray(4, 8), 4) === itemSize && bytes.length === 8 + count * itemSize,
		'invalid batch length');
	return Array.from({ length: count }, (_, i) => bytes.subarray(8 + i * itemSize, 8 + (i + 1) * itemSize));
};

export const equalRationals = (a: ReturnType<typeof rational>, b: ReturnType<typeof rational>) => {
	return BigInt(a.numerator) * BigInt(b.denominator) === BigInt(b.numerator) * BigInt(a.denominator);
};

export type MetadataSet = { kind: number; properties: Map<string, Uint8Array> };

export const property = (set: MetadataSet, key: string, size?: number) => {
	const bytes = set.properties.get(key);
	requireMxf(bytes && (size === undefined || bytes.length === size), `missing or invalid property ${key}`);
	return bytes;
};

export const parseSet = (kind: number, bytes: Uint8Array, primer: Map<number, string>): MetadataSet => {
	const properties = new Map<string, Uint8Array>();
	let offset = 0;
	while (offset < bytes.length) {
		requireMxf(offset + 4 <= bytes.length, 'truncated local item');
		const tag = uint(bytes.subarray(offset, offset + 2), 2);
		const length = uint(bytes.subarray(offset + 2, offset + 4), 2);
		offset += 4;
		requireMxf(offset + length <= bytes.length, 'local item exceeds set');
		const ul = primer.get(tag);
		requireMxf(ul, 'local tag missing from primer');
		requireMxf(!properties.has(ul), 'duplicate property');
		properties.set(ul, bytes.slice(offset, offset + length));
		offset += length;
	}
	return { kind, properties };
};
