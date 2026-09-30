import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, FilePathSource } from '../../src/source.js';

// Authored testsrc2/sine, FFmpeg 7.1.1/libx264. Synthetic index corrections only;
// Annex B and PCM bytes are unchanged. These are not producer-conformance samples.
const readFixture = (depth: number, bframes: number) =>
	readFile(new URL(`../public/mxf-avc422-${depth}bit-b${bframes}.mxf`, import.meta.url));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

// These byte edits target the single header descriptor in the retained FFmpeg fixtures, not essence.
const replaceField = (data: Buffer, tag: number, before: Buffer, after: Buffer) => {
	const header = Buffer.alloc(4);
	header.writeUInt16BE(tag);
	header.writeUInt16BE(before.length, 2);
	const needle = Buffer.concat([header, before]);
	const offset = data.indexOf(needle);
	expect(offset).toBeGreaterThan(0);
	expect(offset).toBeLessThan(8192);
	expect(data.indexOf(needle, offset + 1)).toBe(-1);
	expect(after.length).toBe(before.length);
	data.set(after, offset + 4);
};
const integer = (value: number) => {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32BE(value);
	return bytes;
};
const coding = Buffer.from('060e2b340401010a0401020201316001', 'hex');

describe.each([8, 10])('given real progressive %i-bit High 4:2:2 AVC in MXF', (depth) => {
	describe.each([0, 2])('when reading a closed GOP with %i B-frames', (bframes) => {
		it('should preserve Annex B payloads, decoded presentation order, PCM timing and IDR seeks', async () => {
			using input = new Input({
				source: new FilePathSource(fileURLToPath(new URL(
					`../public/mxf-avc422-${depth}bit-b${bframes}.mxf`, import.meta.url,
				))), formats: ALL_FORMATS,
			});
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getCodec()).toBe('avc');
			expect(await track.getCodecParameterString()).toBe('avc1.7a001f');
			const config = (await track.getDecoderConfig())!;
			expect(config).toMatchObject({ codec: 'avc1.7a001f', codedWidth: 320, codedHeight: 192 });
			expect(config.description).toBeUndefined();
			const sink = new EncodedPacketSink(track);
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			// FFmpeg decoded-frame order. Hashes are SHA-256 of the concatenated lowercase
			// packet SHA-256 strings recorded by ffprobe, separately for video and PCM.
			const order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 12, 10, 11, 15, 13, 14, 18, 16, 17, 21, 19, 20,
				24, 22, 23, 25, 28, 26, 27, 29];
			const videoHashes: Record<string, string> = {
				'8-0': '68bae9c09a0c18342b3e50552de42090e844ed76007178085a8d240b3f4d2dc1',
				'8-2': '05ebe10aae19ab57c682566c4566137ee72b113c8e0cdcb09d2f32c298c52b13',
				'10-0': '39eff8900b1d4d2bbdac05d3cfc4daabba4322c2dc25bc7e1650e7b52854cef8',
				'10-2': '20e3d4dceeff2ddb23f680c6a1308ddf564ae8ff0565d53195c4c2009718eec9',
			};
			for (const [kind, packets] of [['video', sink], ['audio', audio]] as const) {
				const hashes = createHash('sha256');
				let packet = await packets.getFirstPacket();
				for (let d = 0; d < 30; d++) {
					expect(packet).not.toBeNull();
					const presentation = kind === 'video' && bframes ? order[d]! : d;
					expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration])
						.toEqual([d, presentation / 25, 0.04]);
					hashes.update(hash(packet!.data));
					if (kind === 'video') {
						expect(packet!.type).toBe(d % 25 === 0 ? 'key' : 'delta');
						const found = (await sink.getPacket(packet!.timestamp, { metadataOnly: true }))!;
						expect(found.sequenceNumber).toBe(d);
					}
					packet = await packets.getNextPacket(packet!);
				}
				expect(packet).toBeNull();
				expect(hashes.digest('hex')).toBe(kind === 'video'
					? videoHashes[`${depth}-${bframes}`]
					: '1d70e545c22d5a5131854e1f6b2216d59049a28f036e041d4321095542f3398f');
			}
			for (const time of [0.04, 0.12, 0.99, 1, 1.04, Infinity]) {
				expect((await sink.getKeyPacket(time, { verifyKeyPackets: true }))!.timestamp).toBe(time < 1 ? 0 : 1);
			}
			const first = (await sink.getFirstPacket())!;
			expect((await sink.getNextKeyPacket(first, { verifyKeyPackets: true }))!.timestamp).toBe(1);
		});
	});

	describe('when descriptor metadata contradicts the encoded SPS', () => {
		it.each([
			['component depth', 0x3301, depth, depth === 8 ? 10 : 8],
			['horizontal subsampling', 0x3302, 2, 1],
			['vertical subsampling', 0x3308, 1, 2],
		] as const)('should reject mismatched %s', async (_, tag, before, after) => {
			const data = await readFixture(depth, 2);
			replaceField(data, tag, integer(before), integer(after));
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			await expect(track.getDecoderConfig()).rejects.toThrow(/AVC SPS.*CDCI/);
		});

		it.each(['20', '40'])('should reject a 4:2:2 SPS under AVC coding profile %s', async (profile) => {
			const data = await readFixture(depth, 2);
			replaceField(data, 0x3201, coding, Buffer.from(`060e2b340401010a040102020131${profile}01`, 'hex'));
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			await expect(track.getDecoderConfig()).rejects.toThrow(/SPS profile disagrees/);
		});
	});

	describe('when reading the untouched FFmpeg B-frame index', () => {
		it('should reject its temporal mapping instead of returning invented timestamps', async () => {
			const data = await readFixture(depth, 2);
			// Restore the original video PosTableIndex, temporal offsets and B-reference flags.
			const delta = depth === 8 ? 433275 : 431739;
			data[delta] = 0;
			for (let d = 0; d < 30; d++) {
				data[delta + 24 + 15 * d] = 0;
			}
			for (const d of [2, 5, 8, 11, 14, 17, 20, 23, 27]) {
				data[delta + 26 + 15 * d] = 0x33;
			}
			expect(hash(data)).toBe(depth === 8
				? '1ee8a3d5ec0c28b71750da6dfc55e3cd6b696bc106cf339224fbb5d8891caaee'
				: 'c7547f6b85fd325c121532588d771a4d9eed52aeaf024a109a8b94ee057c1f44');
			using input = new Input({
				source: new BufferSource(data), formats: ALL_FORMATS,
			});
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(0.04, { metadataOnly: true })).rejects.toThrow(/temporal index/);
		});
	});
});

describe('given High 4:2:2 coding labels', () => {
	describe('when the label uses the published registry version', () => {
		it('should accept version 0d without relaxing the coding suffix', async () => {
			const data = await readFixture(10, 2);
			replaceField(data, 0x3201, coding, Buffer.from('060e2b340401010d0401020201316001', 'hex'));
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			expect(await (await input.getPrimaryVideoTrack())!.getCodecParameterString()).toBe('avc1.7a001f');
		});
	});
	describe('when a label names a separate constrained AVC-Intra mapping', () => {
		it.each(['01323001', '01323101', '01323201', '01316002'])(
			'should reject coding suffix %s', async (suffix) => {
				const data = await readFixture(10, 2);
				replaceField(data, 0x3201, coding, Buffer.from(`060e2b340401010a04010202${suffix}`, 'hex'));
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				await expect(input.getPrimaryVideoTrack()).rejects.toThrow(/unsupported AVC picture coding/);
			},
		);
	});
});
