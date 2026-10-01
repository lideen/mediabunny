import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import makeHTCodec from '../../packages/htj2k/vendor/HT_internal.js';
import {
	BufferSource, CanvasSink, CustomPathedSource, CustomSource, EncodedPacketSink, Input, MXF,
	UrlSource, VideoSampleSink,
} from '../../src/index.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import { makeMxf } from './mxf-fixture.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

// Original CC0-1.0 patterns, encoded with OpenJPH 0.32.0, commit 23c422895ce6c3a156935222e4715ee0b7be952c.
// RGB component c at (x,y): (x*1009 + y*313 + c*7919 + x*y*17) modulo 2^bits.
// ojph_compress: -reversible true -colour_trans true -prog_order RPCL, with these varying geometries:
// width,height,bits,decompositions,precincts,blocks:
// 1,65,8,2 and 65,1,16,2 and 65,49,8,2: {16,16},{32,32}, {8,8}
// 193,131,16,3: {32,16},{64,32}, {16,8}; 257,129,8,4: {32,32},{64,64}, {16,16}.
// The one-pixel axes exercise empty high-pass bands; larger patterns contain stuffed packet-header bytes.
// MXF containers below are synthetic wrappers, not evidence of producer-container interoperability.
const fixture = (width = 193, height = 131, bits = 16) => ({ width, height, bits,
	data: new Uint8Array(readFileSync(new URL(`../public/htj2k-rpcl-${width}x${height}-${bits}.j2c`, import.meta.url))),
});
const makeInput = (htj2k = fixture()) => new Input({ formats: [MXF], source: new BufferSource(makeMxf({
	htj2k, videoOnly: true, editRate: [25, 1],
}).data) });
const reducedResolution = { width: 25, height: 17 };
const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
const native = WebAssembly.compile(readFileSync(new URL('../../packages/htj2k/vendor/HT_internal.wasm',
	import.meta.url))).then(wasm => makeHTCodec({ instantiateWasm(imports, receive) {
	const instance = new WebAssembly.Instance(wasm, imports);
	receive(instance);
	return instance.exports;
} }));

// Independent oracle: native decoding receives the complete original codestream at the same skip.
const decodeComplete = async (data: Uint8Array, skip: number, width: number, height: number, bits: number) => {
	const module = await native;
	const decoder = new module.HTDecoder(data.length);
	const rgba = new Uint8Array(width * height * 4).fill(255);
	try {
		decoder.getCodestreamBuffer().set(data);
		expect(decoder.readHeader()).not.toBeInstanceOf(Error);
		expect(decoder.startDecoding(skip, false)).not.toBeInstanceOf(Error);
		for (let y = 0; y < height; y++) {
			for (let c = 0; c < 3; c++) {
				const row = decoder.decodeLineAsUnsignedSamples();
				if (row instanceof Error) {
					throw row;
				}
				expect(row.length).toBe(width);
				for (let x = 0; x < width; x++) {
					rgba[(y * width + x) * 4 + c] = Math.max(0, Math.min(2 ** bits - 1, row[x]! | 0)) >>> (bits - 8);
				}
			}
		}
	} finally {
		decoder.delete();
	}
	return rgba;
};

describe('given lossless RPCL RGB fixtures', () => {
	describe('when requesting every supported reduction', () => {
		it.each([[1, 65, 8, 2], [65, 1, 16, 2], [65, 49, 8, 2], [193, 131, 16, 3], [257, 129, 8, 4]])(
			'should match complete-codestream native pixels for %ix%i RGB%i with %i levels',
			async (width, height, bits, levels) => {
				registerHtj2kDecoder();
				const htj2k = fixture(width, height, bits);
				using input = makeInput(htj2k);
				const track = (await input.getPrimaryVideoTrack())!;
				const config = await track.getDecoderConfig();
				for (let skip = 0; skip <= levels; skip++) {
					const dimensions = { width: Math.ceil(width / 2 ** skip), height: Math.ceil(height / 2 ** skip) };
					const sink = new VideoSampleSink(track, skip ? { reducedResolution: dimensions } : {});
					using sample = (await sink.getSample(0))!;
					expect([sample.codedWidth, sample.codedHeight, sample.timestamp, sample.duration])
						.toEqual([dimensions.width, dimensions.height, 0, 0.04]);
					const rgba = new Uint8Array(sample.allocationSize());
					await sample.copyTo(rgba);
					const expectedPixels = await decodeComplete(
						htj2k.data, skip, dimensions.width, dimensions.height, bits,
					);
					expect(rgba).toEqual(expectedPixels);
					if (!skip) {
						const expected = new Uint8Array(width * height * 4).fill(255);
						for (let y = 0; y < height; y++) {
							for (let x = 0; x < width; x++) {
								for (let c = 0; c < 3; c++) {
									expected[(y * width + x) * 4 + c]
										= ((x * 1009 + y * 313 + c * 7919 + x * y * 17) % 2 ** bits) >>> (bits - 8);
								}
							}
						}
						expect(rgba).toEqual(expected);
					}
				}
				expect(await track.getDecoderConfig()).toEqual(config);
				expect((await new EncodedPacketSink(track).getFirstPacket())!.data).toEqual(htj2k.data);
				await expect(new VideoSampleSink(track, { reducedResolution: { width, height } }).getSample(0))
					.rejects.toThrow('complete resolution');
			});
	});

	describe('when navigating a reduced track', () => {
		it('should preserve ordered ranges, repeated and backward timestamps, and missing samples', async () => {
			registerHtj2kDecoder();
			using input = makeInput();
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new VideoSampleSink(track, { reducedResolution });
			const times = [];
			for await (const sample of sink.samples(0.04, 0.16)) {
				expect([sample.codedWidth, sample.codedHeight]).toEqual([25, 17]);
				times.push(sample.timestamp);
				sample.close();
			}
			expect(times).toEqual([0.04, 0.08, 0.12]);
			const random = [];
			for await (const sample of sink.samplesAtTimestamps([0, 0, 0.16, 0, -1])) {
				random.push(sample?.timestamp ?? null);
				sample?.close();
			}
			expect(random).toEqual([0, 0, 0.16, 0, null]);
			expect(() => new CanvasSink(track, { crop: { left: 0, top: 0, width: 10, height: 10 },
				decoderOptions: { reducedResolution } })).toThrow('Cropping');
		});

		it('should reject unsupported codecs without a complete-packet fallback', async () => {
			using input = new Input({ formats: [MXF], source: new BufferSource(makeMxf({ videoOnly: true }).data) });
			await expect(new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution }).getSample(0))
				.rejects.toThrow('requires an HTJ2K track');
		});
	});
});

describe('given bounded HTTP packet reads', () => {
	describe.each(['direct', 'slice', 'pathed'] as const)('when using a %s source', (wrapper) => {
		it.each([true, false])('should require finite range policy, enabled=%s', async (finite) => {
			registerHtj2kDecoder();
			const htj2k = fixture();
			const file = makeMxf({ htj2k, videoOnly: true, editRate: [25, 1] });
			const ranges: [number, number][] = [];
			const source = new UrlSource('https://offline.invalid/immutable.mxf', {
				rangePolicy: finite ? { minimumRequestSize: 32768 } : undefined,
				fetchFn: async (_url, init) => {
					if (init?.method === 'HEAD') {
						return new Response(null, { headers: { 'Content-Length': `${file.data.length}` } });
					}
					const match = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('Range')!)!;
					if (finite) {
						expect(match[2]).not.toBe('');
					}
					const start = Number(match[1]);
					const end = Math.min(match[2] ? Number(match[2]) + 1 : file.data.length, file.data.length);
					ranges.push([start, end]);
					return new Response(file.data.slice(start, end), { status: 206, headers: {
						'Content-Range': `bytes ${start}-${end - 1}/${file.data.length}`,
						'Content-Length': `${end - start}`,
					} });
				},
			});
			const wrapped = wrapper === 'slice'
				? source.slice(0)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const track = (await input.getPrimaryVideoTrack())!;
			const pending = new VideoSampleSink(track, { reducedResolution }).getSample(0);
			if (!finite) {
				await expect(pending).rejects.toThrow(/finite.*UrlSource/);
				return;
			}
			using sample = (await pending)!;
			expect([sample.codedWidth, sample.codedHeight]).toEqual([25, 17]);
			const payloadEnd = file.firstPayloadOffset + htj2k.data.length;
			const payloadReads = ranges.filter(([start, end]) => start < payloadEnd && end > file.firstPayloadOffset);
			expect(payloadReads.length).toBeGreaterThan(0);
			for (const [, end] of payloadReads) {
				expect(end).toBeLessThanOrEqual(Math.max(32768, payloadEnd));
			}
		});
	});

	describe('when the source omits the final requested byte', () => {
		it('should reject physical undercoverage rather than decode or fall back', async () => {
			registerHtj2kDecoder();
			const file = makeMxf({ htj2k: fixture(), videoOnly: true }).data;
			let shortened = false;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.length,
				maxCacheSize: 0, prefetchProfile: 'none', read: (start, end) => {
					if (end - start > 65536) {
						shortened = true;
						return file.slice(start, end - 1);
					}
					return file.slice(start, end);
				} }) });
			await expect(new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution }).getSample(0))
				.rejects.toThrow();
			expect(shortened).toBe(true);
		});
	});
});

describe('given cancellable reduced sample and canvas iterators', () => {
	describe('when the public retrieval signal aborts a pending reduced read', () => {
		it('should reject the sample request and allow the same input to be reused', async () => {
			registerHtj2kDecoder();
			const file = makeMxf({ htj2k: fixture(), videoOnly: true }).data;
			const entered = gate();
			const release = gate();
			let hold = false;
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.length, maxCacheSize: 0, prefetchProfile: 'none',
				read: async (start, end) => {
					if (hold && end - start > 65536) {
						entered.resolve();
						await release.promise;
					}
					return file.slice(start, end);
				},
			}) });
			const controller = new AbortController();
			const track = (await input.getPrimaryVideoTrack())!;
			await track.getDecoderConfig();
			await new EncodedPacketSink(track).getPacket(0, { metadataOnly: true });
			hold = true;
			const sink = new VideoSampleSink(track, { reducedResolution });
			const pending = sink.getSample(0, { signal: controller.signal });
			try {
				await entered.promise;
				controller.abort(new Error('Canceled reduced read'));
				hold = false;
				release.resolve();
				await expect(pending).rejects.toThrow('Canceled reduced read');
				using recovered = (await sink.getSample(0))!;
				expect(recovered.codedWidth).toBe(25);
			} finally {
				release.resolve();
			}
		});
	});

	describe('when another navigation shares a canceled directory lookup', () => {
		it('should retry the canceled builder without failing the other caller', async () => {
			registerHtj2kDecoder();
			const file = makeIndexedMxf({ htj2k: fixture(), videoOnly: true });
			const entered = gate();
			const release = gate();
			let hold = false;
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.size, maxCacheSize: 0, prefetchProfile: 'none',
				read: async (start, end) => {
					if (hold) {
						entered.resolve();
						await release.promise;
					}
					return file.read(start, end);
				},
			}) });
			const track = (await input.getPrimaryVideoTrack())!;
			hold = true;
			const iterator = new VideoSampleSink(track, { reducedResolution }).samplesAtTimestamps([9.6]);
			const pending = iterator.next();
			try {
				await entered.promise;
				const other = new EncodedPacketSink(track).getPacket(9.64, { metadataOnly: true });
				await setImmediate();
				await iterator.return();
				expect((await pending).done).toBe(true);
				hold = false;
				release.resolve();
				expect((await other)?.timestamp).toBe(9.64);
			} finally {
				release.resolve();
				await iterator.return();
			}
		});
	});

	describe('when the next timestamp lookup is blocked', () => {
		it('should deliver the current decoded sample before that lookup settles', async () => {
			registerHtj2kDecoder();
			const file = makeIndexedMxf({ htj2k: fixture(), videoOnly: true });
			const entered = gate();
			const release = gate();
			let reads = 0;
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.size, maxCacheSize: 0, prefetchProfile: 'none',
				read: async (start, end) => {
					reads++;
					if (end - start <= 25 && start > file.offsets[0]! + 200 * file.stride
						&& start < file.offsets[1]!) {
						entered.resolve();
						await release.promise;
					}
					return file.read(start, end);
				},
			}) });
			const track = (await input.getPrimaryVideoTrack())!;
			const iterator = new VideoSampleSink(track, { reducedResolution }).samplesAtTimestamps([0, 9.6]);
			const pending = iterator.next();
			try {
				await entered.promise;
				using current = (await pending).value!;
				expect(current.timestamp).toBe(0);
				await iterator.return();
				const before = reads;
				release.resolve();
				await setImmediate();
				expect(reads).toBe(before);
			} finally {
				release.resolve();
				await iterator.return();
			}
		});
	});

	const modes = ['range', 'timestamps', 'canvas-range', 'canvas-timestamps'] as const;
	describe.each(modes)('when returning a %s iterator', (mode) => {
		it.each(['direct', 'slice', 'pathed'] as const)('should cancel payload reads through %s', async (wrapper) => {
			registerHtj2kDecoder();
			const file = makeMxf({ htj2k: fixture(), videoOnly: true, editRate: [25, 1] }).data;
			const entered = gate();
			const release = gate();
			let hold = false;
			let reads = 0;
			const source = new CustomSource({ getSize: () => file.length, maxCacheSize: 0,
				prefetchProfile: 'none', read: async (start, end) => {
					reads++;
					if (hold && end - start > 65536) {
						entered.resolve();
						await release.promise;
					}
					return file.slice(start, end);
				} });
			const wrapped = wrapper === 'slice'
				? source.slice(0)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const track = (await input.getPrimaryVideoTrack())!;
			const packets = new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true });
			for await (const packet of packets) {
				expect(packet.data.length).toBe(0);
			}
			const sink = new VideoSampleSink(track, { reducedResolution });
			const canvas = new CanvasSink(track, { decoderOptions: { reducedResolution } });
			hold = true;
			const iterator = mode === 'range'
				? sink.samples()
				: mode === 'timestamps'
					? sink.samplesAtTimestamps([0])
					: mode === 'canvas-range' ? canvas.canvases() : canvas.canvasesAtTimestamps([0]);
			const pending = iterator.next();
			try {
				await entered.promise;
				await iterator.return();
				expect(await pending).toEqual({ done: true, value: undefined });
				const before = reads;
				release.resolve();
				await setImmediate();
				expect(reads).toBe(before);
				hold = false;
				using recovered = (await sink.getSample(0))!;
				expect(recovered.codedWidth).toBe(25);
			} finally {
				release.resolve();
				await iterator.return();
			}
		});

		it.each([true, false])('should cancel indexed navigation and keep reusable metadata, cold=%s', async (cold) => {
			registerHtj2kDecoder();
			const file = makeIndexedMxf({ htj2k: fixture(), videoOnly: true });
			const entered = gate();
			const release = gate();
			let hold = false;
			let reads = 0;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				maxCacheSize: 0, prefetchProfile: 'none', read: async (start, end) => {
					reads++;
					if (hold && (cold || end - start <= 25)) {
						entered.resolve();
						await release.promise;
					}
					return file.read(start, end);
				} }) });
			const track = (await input.getPrimaryVideoTrack())!;
			if (!cold) {
				await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true });
			}
			hold = true;
			const sink = new VideoSampleSink(track, { reducedResolution });
			const canvas = new CanvasSink(track, { decoderOptions: { reducedResolution } });
			const iterator = mode === 'range'
				? sink.samples(9.6)
				: mode === 'timestamps'
					? sink.samplesAtTimestamps([9.6])
					: mode === 'canvas-range' ? canvas.canvases(9.6) : canvas.canvasesAtTimestamps([9.6]);
			const pending = iterator.next();
			try {
				await entered.promise;
				await iterator.return();
				expect((await pending).done).toBe(true);
				const before = reads;
				release.resolve();
				await setImmediate();
				expect(reads).toBe(before);
				hold = false;
				const packet = (await new EncodedPacketSink(track).getPacket(9.6, { metadataOnly: true }))!;
				expect([packet.timestamp, packet.byteLength]).toEqual([9.6, fixture().data.length]);
			} finally {
				release.resolve();
				await iterator.return();
			}
		});
	});
});

describe('given malformed or unsupported reduced codestreams', () => {
	const original = fixture();
	const markerOffset = (marker: number): number => {
		for (let i = 2; i < original.data.length - 1;) {
			if (original.data[i] === 255 && original.data[i + 1] === marker) {
				return i;
			}
			i += 2 + original.data[i + 2]! * 256 + original.data[i + 3]!;
		}
		throw new Error('Fixture marker not found');
	};
	describe('when decoding through the sample sink', () => {
		it.each([
			['progression', markerOffset(0x52) + 5, 0], ['layers', markerOffset(0x52) + 7, 2],
			['MCT', markerOffset(0x52) + 8, 0], ['decompositions', markerOffset(0x52) + 9, 32],
			['codeblock', markerOffset(0x52) + 10, 255], ['precinct', markerOffset(0x52) + 14, 0],
			['wavelet', markerOffset(0x52) + 13, 0], ['quantization', markerOffset(0x5c) + 4, 1],
			['guard bits', markerOffset(0x5c) + 4, 0xe0], ['exponent', markerOffset(0x5c) + 5, 0xf8],
			['marker override', markerOffset(0x5c) + 1, 0x5d], ['signed component', 42, 143],
			['sampling', 43, 2], ['origin', 19, 1], ['tile parts', markerOffset(0x90) + 11, 2],
		] as const)('should reject unsupported %s without full-resolution fallback', async (_name, offset, value) => {
			registerHtj2kDecoder();
			const data = original.data.slice();
			data[offset] = value;
			using input = makeInput({ ...original, data });
			await expect(new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution }).getSample(0))
				.rejects.toThrow('Unsupported or invalid HTJ2K');
		});

		it.each([
			['111' + '0'.repeat(64), 'tag-tree'], ['111110' + '1'.repeat(30), 'Lblock'], ['1111100000', 'cleanup'],
		])('should reject invalid packet-header bits %s', async (bitString, reason) => {
			registerHtj2kDecoder();
			const data = original.data.slice();
			let offset = markerOffset(0x90) + 14;
			let capacity = 8;
			while (bitString.length) {
				const byte = Number.parseInt(bitString.slice(0, capacity).padEnd(capacity, '0'), 2);
				data[offset++] = byte;
				bitString = bitString.slice(capacity);
				capacity = byte === 255 ? 7 : 8;
			}
			using input = makeInput({ ...original, data });
			await expect(new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution }).getSample(0))
				.rejects.toThrow(reason);
		});
	});
});
