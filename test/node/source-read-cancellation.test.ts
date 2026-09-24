import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	CustomSource, CustomPathedSource, CustomVideoDecoder, EncodedPacketSink, Input, MXF,
	registerDecoder, VideoSampleSink, type VideoDecodePacketReader,
} from '../../src/index.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';

const data = readFileSync(new URL('../fixtures/htj2k/rpcl-193x131-16.j2c', import.meta.url));

describe('given reduced preparations sharing a source with ordinary packet consumers', () => {
	it.each([
		{ scenario: 'extender', wrapper: 'direct' },
		{ scenario: 'extender', wrapper: 'slice' },
		{ scenario: 'extender', wrapper: 'pathed' },
		{ scenario: 'shared', wrapper: 'direct' },
		{ scenario: 'shared-stream', wrapper: 'direct' },
		{ scenario: 'queued', wrapper: 'direct' },
	] as const)('should cancel only $scenario reads through $wrapper sources', async ({ scenario, wrapper }) => {
		const shared = scenario === 'shared' || scenario === 'shared-stream';
		let streamPulls = 0;
		let enabled = true;
		let release!: () => void;
		let held!: () => void;
		let submitted!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const heldReads = new Promise<void>((resolve) => {
			held = resolve;
		});
		const preparationsSubmitted = new Promise<void>((resolve) => {
			submitted = resolve;
		});
		let preparationCount = 0;
		let closed = 0;
		class Decoder extends CustomVideoDecoder {
			static override supports() { return enabled; }
			init() {}
			decode() { throw new Error('Unexpected full decode'); }
			override decodeReduced() { throw new Error('Unexpected serial decode'); }
			override async prepareReduced(reader: VideoDecodePacketReader) {
				const pending = reader.read(0, reader.byteLength);
				if (++preparationCount === 2) submitted();
				let bytes = await pending;
				return {
					get byteLength() { return bytes.length; },
					dispose() { bytes = new Uint8Array(); },
				};
			}

			override decodePrepared() { throw new Error('Canceled preparation reached native decode'); }
			flush() {}
			close() { closed++; }
		}
		registerDecoder(Decoder);
		const file = makeIndexedMxf({ htj2k: { data, bits: 16, width: 193, height: 131 } });
		const firstPayload = file.offsets[0]! + file.regions[1]!.data.length + 32 + 20;
		const liveFrames = scenario === 'queued' ? [1000, 2000] : [0];
		let waiting = 0;
		let holding = false;
		const source = new CustomSource({ getSize: () => file.size, maxCacheSize: 0,
			read: async (start, end) => {
				if (holding && liveFrames.some(frame => start === firstPayload + frame * file.stride)) {
					if (++waiting === liveFrames.length) held();
					await gate;
				}
				const bytes = file.read(start, end);
				if (holding && scenario === 'shared-stream') {
					let offset = 0;
					return new ReadableStream<Uint8Array>({ pull(controller) {
						streamPulls++;
						const end = Math.min(offset + 4096, bytes.length);
						controller.enqueue(bytes.subarray(offset, end));
						offset = end;
						if (offset === bytes.length) controller.close();
					} }, { highWaterMark: 0 });
				}
				return bytes;
			} });
		const wrapped = wrapper === 'slice'
			? source.slice(0, file.size)
			: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', async () => source) : source;
		using input = new Input({ formats: [MXF], source: wrapped });
		const track = (await input.getPrimaryVideoTrack())!;
		const packets = new EncodedPacketSink(track);
		for (const frame of [0, 1, 2, 3, ...liveFrames]) {
			await packets.getPacket(frame * 0.04, { metadataOnly: true });
		}
		holding = true;
		const live = liveFrames.map(frame => packets.getPacket(frame * 0.04));
		await heldReads;
		let sharedSettled = false;
		if (shared) {
			live.push(packets.getPacket(2 * 0.04).then((packet) => {
				sharedSettled = true;
				return packet;
			}));
		}
		const iterator = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } })
			.samples(scenario === 'queued' ? 0 : 0.04);
		const pending = iterator.next();
		try {
			await preparationsSubmitted;
			if (shared) expect(sharedSettled).toBe(false);
			const before = file.reads.length;
			await iterator.return();
			expect((await pending).done).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(closed).toBe(1);
			release();
			for (const packet of await Promise.all(live)) expect(packet!.data).toEqual(new Uint8Array(data));
			await new Promise(resolve => setTimeout(resolve, 20));
			const completedReads = file.reads.slice(before);
			if (!shared) {
				expect(completedReads).toHaveLength(liveFrames.length);
			}
			if (scenario === 'shared-stream') expect(streamPulls).toBeGreaterThan(1);
		} finally {
			enabled = false;
			release();
			await iterator.return();
			await Promise.all(live);
		}
	});

	it.each(['callback', 'pull'] as const)(
		'should stop canceled stream consumption after a held %s without disposing the Input', async (mode) => {
			registerHtj2kDecoder();
			const file = makeIndexedMxf({ htj2k: { data, bits: 16, width: 193, height: 131 } });
			const firstPayload = file.offsets[0]! + file.regions[1]!.data.length + 32 + 20;
			let armed = false;
			let pulls = 0;
			let canceled = false;
			let release!: () => void;
			let entered!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.size, maxCacheSize: 0,
				read: async (start, end) => {
					if (!armed || start !== firstPayload) return file.read(start, end);
					if (mode === 'callback') {
						entered();
						await gate;
					}
					const bytes = file.read(start, end);
					let offset = 0;
					return new ReadableStream<Uint8Array>({
						async pull(controller) {
							pulls++;
							if (mode === 'pull' && pulls === 1) {
								entered();
								await gate;
							}
							const end = Math.min(offset + 64, bytes.length);
							controller.enqueue(bytes.subarray(offset, end));
							offset = end;
							if (offset === bytes.length) controller.close();
						},
						cancel() { canceled = true; },
					}, { highWaterMark: 0 });
				},
			}) });
			const track = (await input.getPrimaryVideoTrack())!;
			await track.getDecoderConfig();
			await new EncodedPacketSink(track).getPacket(0, { metadataOnly: true });
			armed = true;
			const iterator = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } })
				.samples(0, 0.04);
			const pending = iterator.next();
			try {
				await started;
				await iterator.return();
				expect((await pending).done).toBe(true);
				release();
				await new Promise(resolve => setTimeout(resolve, 20));
				expect(pulls).toBe(mode === 'callback' ? 0 : 1);
				expect(canceled).toBe(true);
				armed = false;
				const packet = (await new EncodedPacketSink(track).getFirstPacket())!;
				expect(packet.data).toEqual(new Uint8Array(data));
			} finally {
				release();
				await iterator.return();
			}
		});
});
