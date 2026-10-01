import { readFileSync } from 'node:fs';
import manifest from '../fixtures/mpeg2/open/open422.json' with { type: 'json' };
import interlacedManifest from '../fixtures/mpeg2/open/interlaced422.json' with { type: 'json' };

export const lxfEnvelope = (
	type: number, timestamp: number, duration: number, size: number, ancillary = 0, channels = 8,
) => {
	const header = Buffer.alloc(72);
	header.set(Buffer.from('LEITCH\0\0'));
	header.writeUInt32LE(1, 8);
	header.writeUInt32LE(72, 12);
	header.writeUInt32LE(type, 16);
	header.writeBigUInt64LE(BigInt(timestamp), 24);
	header.writeBigUInt64LE(BigInt(duration), 32);
	if (type === 0) {
		header.writeUInt32LE(0x104813, 40);
		header.writeUInt32LE(size, 44);
		header.writeUInt32LE(ancillary, 52);
	} else if (type === 1) {
		header.writeUInt32LE(0x618, 40);
		header.writeUInt32LE((1 << channels) - 1, 44);
		header.writeUInt32LE(size / channels, 48);
	} else {
		header.writeUInt32LE(1, 40);
		header.writeUInt32LE(120, 44);
	}
	lxfChecksum(header);
	return header;
};

export const lxfChecksum = (header: Buffer) => {
	header.writeUInt32LE(0, 64);
	let sum = 0;
	for (let i = 0; i < header.length; i += 4) {
		sum = (sum + header.readUInt32LE(i)) >>> 0;
	}
	header.writeUInt32LE(-sum >>> 0, 64);
};

export const pcmValue = (frame: number, channel: number) =>
	frame === 0
		? [-8388608, 8388607, -1, 0, 1, -1234567, 7654321, -7654321][channel]!
		: (channel + 1) * 10000 + frame;

export const lxfFixture = (
	count = 6, origin = 3 * 720000 + 123, sparse = false, lastAncillary = 500000,
	ancillaryForFrame?: (ordinal: number) => number,
	{ channels = 8, interlaced = false, audioFrameCount = count - 1, videoPackets, audioPackets }: {
		channels?: number;
		interlaced?: boolean;
		audioFrameCount?: number;
		videoPackets?: readonly Buffer[];
		audioPackets?: readonly Buffer[];
	} = {},
) => {
	const name = interlaced ? 'interlaced422' : 'open422';
	const oracle = interlaced ? interlacedManifest : manifest;
	const original = readFileSync(new URL(`../fixtures/mpeg2/open/${name}.mxf`, import.meta.url));
	const first = oracle.packets[0]!;
	const video = Buffer.from(original.subarray(Number(first.pos) + 20, Number(first.pos) + 20 + Number(first.size)));
	const picture = video.indexOf(Buffer.from('00000100', 'hex'));
	video[picture + 4] = 0;
	video[picture + 5] = video[picture + 5]! & 0x3f;
	const audio = Buffer.alloc(5760 * channels);
	for (let c = 0; c < channels; c++) {
		for (let s = 0; s < 1920; s++) {
			audio.writeIntLE(pcmValue(s, c), c * 5760 + s * 3, 3);
		}
	}
	const metadata = Buffer.alloc(120);
	metadata.writeUInt32LE(count, 32);
	const pieces: { offset: number; data: Buffer }[] = [];
	const videoOffsets: number[] = [];
	const audioOffsets: number[] = [];
	let size = 0;
	const append = (data: Buffer) => {
		pieces.push({ offset: size, data });
		size += data.length;
	};
	append(lxfEnvelope(2, origin, count * 28800, 120));
	append(metadata);
	for (let i = 0; i < count; i++) {
		const videoPacket = videoPackets?.[i] ?? video;
		const ancillary = sparse
			? ancillaryForFrame?.(i) ?? (i === count - 1 ? lastAncillary : 500000 + (i * 7919 % 700000))
			: 0;
		videoOffsets.push(size);
		append(lxfEnvelope(0, origin + i * 28800, 28800, videoPacket.length, ancillary));
		if (ancillary > 8192 && i === Math.floor(count / 2)) {
			// Checksummed candidate inside VBI, with no valid header at its declared successor.
			pieces.push({ offset: size + 4096, data: lxfEnvelope(0, origin + i * 28800, 28800, 100) });
		}
		size += ancillary;
		append(videoPacket);
		if (i < audioFrameCount) {
			const audioPacket = audioPackets?.[i] ?? audio;
			audioOffsets.push(size);
			append(lxfEnvelope(1, origin + i * 28800, 28800, audioPacket.length, 0, channels));
			append(audioPacket);
		}
	}
	const read = (start: number, end: number) => {
		const output = Buffer.alloc(end - start);
		for (const piece of pieces) {
			const from = Math.max(start, piece.offset);
			const to = Math.min(end, piece.offset + piece.data.length);
			if (to > from) {
				output.set(piece.data.subarray(from - piece.offset, to - piece.offset), from - start);
			}
		}
		return output;
	};
	return { size, read, video, audio, videoOffsets, audioOffsets, origin, golden: oracle.faani[first.pts] };
};
