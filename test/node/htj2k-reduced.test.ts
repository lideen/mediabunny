import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractReduced } from '../../packages/htj2k/src/reduced.js';
import makeHTCodec from '../../packages/htj2k/vendor/HT_internal.js';
import { BufferSource, Input, MXF, VideoSampleSink, EncodedPacketSink, CanvasSink, CustomSource, UrlSource,
	CustomPathedSource }
	from '../../src/index.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import { makeMxf } from './mxf-fixture.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

const native = WebAssembly.compile(readFileSync(new URL('../../packages/htj2k/vendor/HT_internal.wasm',
	import.meta.url))).then(wasm => makeHTCodec({ instantiateWasm(imports, receive) {
	const instance = new WebAssembly.Instance(wasm, imports);
	receive(instance);
	return instance.exports;
} }));

const decode = async (data: Uint8Array, skip: number, width: number, height: number) => {
	const module = await native;
	const decoder = new module.HTDecoder(data.length);
	const result = new Uint32Array(width * height * 3);
	try {
		decoder.getCodestreamBuffer().set(data);
		expect(decoder.readHeader()).not.toBeInstanceOf(Error);
		expect(decoder.startDecoding(skip, false)).not.toBeInstanceOf(Error);
		for (let i = 0; i < height * 3; i++) {
			const row = decoder.decodeLineAsUnsignedSamples();
			if (row instanceof Error) throw row;
			expect(row.length).toBe(width);
			result.set(row, i * width);
		}
	} finally {
		decoder.delete();
	}
	return result;
};

describe('given original lossless RGB fixtures with varied RPCL geometry', () => {
	it.each([[1, 65, 8, 2], [65, 1, 16, 2], [65, 49, 8, 2], [193, 131, 16, 3], [257, 129, 8, 4]])(
		'should preserve all raw32 samples at every supported skip for %ix%i RGB%i with %i decompositions',
		async (width, height, bits, levels) => {
			const source = new Uint8Array(readFileSync(new URL(
				`../fixtures/htj2k/rpcl-${width}x${height}-${bits}.j2c`, import.meta.url)));
			const reader = { byteLength: source.length, read: async (start: number, end: number) =>
				source.subarray(start, end) };
			const full = await decode(source, 0, width, height);
			for (let y = 0; y < height; y++) {
				for (let c = 0; c < 3; c++) {
					for (let x = 0; x < width; x++) {
						expect(full[(y * 3 + c) * width + x])
							.toBe((x * 1009 + y * 313 + c * 7919 + x * y * 17) % 2 ** bits);
					}
				}
			}
			for (let skip = 1; skip <= levels; skip++) {
				const request = { width: Math.ceil(width / 2 ** skip), height: Math.ceil(height / 2 ** skip) };
				const result = await extractReduced(reader, request, { width, height, bits });
				expect(result.skip).toBe(skip);
				expect(await decode(result.data, skip, request.width, request.height))
					.toEqual(await decode(source, skip, request.width, request.height));
				await expect(extractReduced({ byteLength: source.length,
					read: async (start, end) => source.subarray(start, Math.min(end, result.coverage.requiredEnd - 1)),
				},
				request, { width, height, bits })).rejects.toThrow('coverage');
			}
			await expect(extractReduced(reader, { width, height }, { width, height, bits }))
				.rejects.toThrow('complete resolution');
		});
});

describe('given retained RPCL source bytes', () => {
	const smoothOracles = process.env['HTJ2K_SMOOTH_ORACLES'];
	it.skipIf(!smoothOracles)('should match complete-input low-tier raw32 and public RGBA references', async () => {
		const { frames } = JSON.parse(readFileSync(smoothOracles!, 'utf8')) as { frames: {
			source: string; inputSha256: string; width: number; height: number; skip: number;
			outputs: { rgb32le: { sha256: string }; rgba8: { sha256: string } };
		}[]; };
		registerHtj2kDecoder();
		const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
		for (const frame of frames) {
			const data = new Uint8Array(readFileSync(frame.source));
			expect(hash(data)).toBe(frame.inputSha256);
			const request = { width: frame.width, height: frame.height };
			const result = await extractReduced({ byteLength: data.length,
				read: async (start, end) => data.slice(start, end),
			}, request, { width: 3840, height: 2160, bits: 16 });
			await expect(extractReduced({ byteLength: data.length,
				read: async (start, end) => data.subarray(start, Math.min(end, result.coverage.requiredEnd - 1)),
			}, request, { width: 3840, height: 2160, bits: 16 })).rejects.toThrow('coverage');
			const rows = await decode(result.data, frame.skip, frame.width, frame.height);
			const interleaved = new Uint8Array(rows.length * 4);
			const view = new DataView(interleaved.buffer);
			for (let y = 0; y < frame.height; y++) {
				for (let x = 0; x < frame.width; x++) {
					for (let c = 0; c < 3; c++) {
						view.setUint32(((y * frame.width + x) * 3 + c) * 4,
							rows[(y * 3 + c) * frame.width + x]!, true);
					}
				}
			}
			expect(hash(interleaved)).toBe(frame.outputs.rgb32le.sha256);
			using input = new Input({ formats: [MXF], source: new BufferSource(makeMxf({
				htj2k: { data: result.data, bits: 16, width: 3840, height: 2160 }, videoOnly: true,
			}).data) });
			const track = (await input.getPrimaryVideoTrack())!;
			using sample = (await new VideoSampleSink(track, { reducedResolution: request }).getSample(0))!;
			const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
			await sample.copyTo(rgba, { format: 'RGBA' });
			expect(hash(rgba)).toBe(frame.outputs.rgba8.sha256);
		}
	}, 30000);
	const evidence = process.env['HTJ2K_EVIDENCE'];
	it.skipIf(!evidence)('should derive a covered reduced input without fetching high-resolution bodies', async () => {
		const source = new Uint8Array(readFileSync(`${evidence}/firstframe.jph`));
		let received = 0;
		const result = await extractReduced({ byteLength: source.length, read: async (start, end) => {
			expect(start).toBeLessThanOrEqual(received);
			received = end;
			return source.subarray(start, end);
		} }, { width: 480, height: 270 }, { width: 3840, height: 2160, bits: 16 });
		expect(result.skip).toBe(3);
		expect(result.coverage.requiredEnd).toBe(573937);
		expect(result.data.length).toBe(574500);
		expect(received).toBeLessThanOrEqual(result.coverage.requiredEnd + 640 * 1024);
		await expect(extractReduced({ byteLength: source.length, read: async (start, end) =>
			source.subarray(start, Math.min(end, result.coverage.requiredEnd - 1)) },
		{ width: 480, height: 270 }, { width: 3840, height: 2160, bits: 16 }))
			.rejects.toThrow('physical coverage');
	});
	const oracles = process.env['HTJ2K_REDUCED_ORACLES'];
	it.skipIf(!oracles)('should match complete-input raw32 oracles for first, following and late frames', async () => {
		const manifest = JSON.parse(readFileSync(oracles!, 'utf8')) as {
			frames: { source: string; width: number; height: number; reduction: number;
				outputs: { rgb32le: { sha256: string } }; }[];
		};
		for (const frame of manifest.frames) {
			const source = new Uint8Array(readFileSync(frame.source));
			const result = await extractReduced({ byteLength: source.length,
				read: async (start, end) => source.subarray(start, end) },
			{ width: frame.width, height: frame.height }, { width: 3840, height: 2160, bits: 16 });
			const raw = await decode(result.data, frame.reduction, frame.width, frame.height);
			const interleaved = Buffer.alloc(raw.byteLength);
			for (let y = 0; y < frame.height; y++) {
				for (let x = 0; x < frame.width; x++) {
					for (let c = 0; c < 3; c++) {
						interleaved.writeUInt32LE(raw[(y * 3 + c) * frame.width + x]!,
							((y * frame.width + x) * 3 + c) * 4);
					}
				}
			}
			expect(createHash('sha256').update(interleaved).digest('hex')).toBe(frame.outputs.rgb32le.sha256);
		}
	});
});

describe('given an explicit reduced-resolution sink request', () => {
	const data = new Uint8Array(readFileSync(new URL('../fixtures/htj2k/rpcl-193x131-16.j2c', import.meta.url)));
	const makeInput = () => new Input({ formats: [MXF], source: new BufferSource(makeMxf({
		htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true,
	}).data) });
	it('should avoid fetching the whole codestream for a small exact preview', async () => {
		registerHtj2kDecoder();
		const file = makeIndexedMxf({ htj2k: { data, bits: 16, width: 193, height: 131 } });
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read, maxCacheSize: 0,
		}) });
		const track = (await input.getPrimaryVideoTrack())!;
		await track.getDecoderConfig();
		await new EncodedPacketSink(track).getPacket(0, { metadataOnly: true });
		const before = file.reads.length;
		using sample = (await new VideoSampleSink(track, {
			reducedResolution: { width: 25, height: 17 },
		}).getSample(0))!;
		expect([sample.codedWidth, sample.codedHeight]).toEqual([25, 17]);
		const transferred = file.reads.slice(before).reduce((sum, [start, end]) => sum + end - start, 0);
		expect(transferred).toBeLessThanOrEqual(32 * 1024);
		const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
		await sample.copyTo(rgba, { format: 'RGBA' });
		expect(createHash('sha256').update(rgba).digest('hex'))
			.toBe('ffa7e1b5ccdafdf12b7852587144c776e8b1adc7b0f071492856458e89e90cb6');
	});
	it.each(['finish', 'return', 'error'] as const)(
		'should bound overlapping range preparations, preserve order, and clean up on %s', async (mode) => {
			registerHtj2kDecoder();
			const file = makeIndexedMxf({ htj2k: { data, bits: 16, width: 193, height: 131 } });
			let payloads = 0;
			let reads = 0;
			let hold = true;
			let release!: () => void;
			let second!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const secondStarted = new Promise<void>((resolve) => {
				second = resolve;
			});
			const firstPayload = file.offsets[0]! + file.regions[1]!.data.length + 32 + 20;
			const payloadFrames = new Set<number>();
			using input = new Input({ formats: [MXF], source: new UrlSource('https://offline.invalid/fixture.mxf', {
				rangePolicy: { minimumRequestSize: 32768 }, maxCacheSize: 0, getRetryDelay: () => null,
				fetchFn: async (_url, init) => {
					const range = new Headers(init?.headers).get('range')!;
					const match = /bytes=(\d+)-(\d+)/.exec(range)!;
					const start = Number(match[1]);
					const end = Number(match[2]) + 1;
					reads++;
					const frame = Math.floor((start - firstPayload) / file.stride);
					if (hold && frame >= 0 && frame < 10 && end - start > 25
						&& start < firstPayload + frame * file.stride + data.length) {
						payloadFrames.add(frame);
						payloads = payloadFrames.size;
						if (frame === 0) {
							await gate;
							if (mode === 'error') throw new Error('Preparation read failed');
						} else if (frame === 1) second();
					}
					return new Response(file.read(start, end), { status: 206, headers: {
						'Content-Range': `bytes ${start}-${end - 1}/${file.size}`,
						'Content-Length': String(end - start),
					} });
				} }) });
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } });
			const iterator = sink.samples();
			let emitted = false;
			const first = iterator.next().then((result) => {
				emitted = true;
				return result;
			});
			void first.catch(() => {});
			try {
				await Promise.race([secondStarted, new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error('Second preparation blocked')), 1000);
				})]);
				await new Promise(resolve => setTimeout(resolve, 20));
				expect(payloads).toBe(2);
				expect(emitted).toBe(false);
				if (mode === 'return') {
					await iterator.return();
					const before = reads;
					release();
					expect((await first).done).toBe(true);
					await new Promise(resolve => setTimeout(resolve, 20));
					expect(reads).toBe(before);
				} else if (mode === 'error') {
					const before = reads;
					release();
					await expect(first).rejects.toThrow('Preparation read failed');
					await new Promise(resolve => setTimeout(resolve, 20));
					expect(reads).toBe(before);
				} else {
					release();
					const a = (await first).value!;
					const b = (await iterator.next()).value!;
					expect([a.timestamp, b.timestamp]).toEqual([0, 0.04]);
					const held = new Uint8Array(a.allocationSize());
					await a.copyTo(held);
					expect(held.some(value => value !== 0)).toBe(true);
					a.close();
					b.close();
				}
			} finally {
				await iterator.return();
				release();
				const result = await first.catch(() => null);
				result?.value?.close();
			}
			hold = false;
			const reused = await sink.getSample(0);
			expect(reused!.timestamp).toBe(0);
			reused!.close();
		});
	it('should deliver a reduced sample before next-target metadata resolves and cancel that lookup', async () => {
		registerHtj2kDecoder();
		const file = makeIndexedMxf({ htj2k: { data, bits: 16, width: 193, height: 131 } });
		let reads = 0;
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
			maxCacheSize: 0, read: async (start, end) => {
				reads++;
				if (end - start <= 25 && start > file.offsets[0]! + 200 * file.stride
					&& start < file.offsets[1]!) {
					entered();
					await gate;
				}
				return file.read(start, end);
			} }) });
		const track = (await input.getPrimaryVideoTrack())!;
		const iterator = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } })
			.samplesAtTimestamps([0, 9.6]);
		const first = iterator.next();
		try {
			await started;
			const deadline = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('Current sample blocked')), 1000);
			});
			const result = await Promise.race([first, deadline]);
			expect(result.value!.timestamp).toBe(0);
			result.value!.close();
			await iterator.return();
			const before = reads;
			release();
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(reads).toBe(before);
			expect((await iterator.next()).done).toBe(true);
		} finally {
			await iterator.return();
			release();
			const result = await first;
			result.value?.close();
		}
	});
	it('should preserve repeated and backward reduced timestamp requests and missing samples', async () => {
		registerHtj2kDecoder();
		const file = makeIndexedMxf({ htj2k: { data, bits: 16, width: 193, height: 131 } });
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read,
		}) });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } });
		const timestamps = [];
		for await (const sample of sink.samplesAtTimestamps([0, 0, 9.6, 0, -1])) {
			timestamps.push(sample?.timestamp ?? null);
			sample?.close();
		}
		expect(timestamps).toEqual([0, 0, 9.6, 0, null]);
	});
	it.each([
		{ method: 'canvases', cold: true }, { method: 'canvasesAtTimestamps', cold: true },
		{ method: 'canvases', cold: false }, { method: 'canvasesAtTimestamps', cold: false },
	])('should cancel $method indexed metadata (cold=$cold) and allow later reads', async ({ method, cold }) => {
		registerHtj2kDecoder();
		const file = makeIndexedMxf({ htj2k: { data, bits: 16, width: 193, height: 131 } });
		let hold = false;
		let reads = 0;
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
			maxCacheSize: 0, read: async (start, end) => {
				reads++;
				if (hold && (cold || end - start <= 25)) {
					entered();
					await gate;
				}
				return file.read(start, end);
			} }) });
		const track = (await input.getPrimaryVideoTrack())!;
		if (!cold) await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true });
		hold = true;
		const sink = new CanvasSink(track, { decoderOptions: { reducedResolution: { width: 25, height: 17 } } });
		const iterator = method === 'canvases' ? sink.canvases(9.6) : sink.canvasesAtTimestamps([9.6]);
		const pending = iterator.next();
		await started;
		await iterator.return();
		const before = reads;
		release();
		expect((await pending).done).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(reads).toBe(before);
		hold = false;
		const packet = (await new EncodedPacketSink(track).getPacket(9.6, { metadataOnly: true }))!;
		expect([packet.timestamp, packet.byteLength]).toEqual([9.6, data.length]);
	});
	it.each(['canvases', 'canvasesAtTimestamps'] as const)(
		'should stop KLV navigation reads after %s return without disposing the input', async (method) => {
			registerHtj2kDecoder();
			const file = makeMxf({ htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true }).data;
			let hold = false;
			let reads = 0;
			let release!: () => void;
			let entered!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.length,
				maxCacheSize: 0, read: async (start, end) => {
					reads++;
					if (hold && end - start <= 25) {
						entered();
						await gate;
					}
					return file.subarray(start, end);
				} }) });
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new CanvasSink(track, { decoderOptions: { reducedResolution: { width: 25, height: 17 } } });
			hold = true;
			const iterator = method === 'canvases' ? sink.canvases() : sink.canvasesAtTimestamps([0, 0.04]);
			const pending = iterator.next();
			await started;
			await iterator.return();
			const before = reads;
			release();
			expect((await pending).done).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(reads).toBe(before);
			hold = false;
			const packet = (await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true }))!;
			expect(packet.byteLength).toBe(data.length);
		});
	it('should reduce both sample pumps while retaining original encoded packets', async () => {
		registerHtj2kDecoder();
		using input = makeInput();
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new VideoSampleSink(track, { reducedResolution: { width: 49, height: 33 } });
		using single = (await sink.getSample(0))!;
		expect([single.codedWidth, single.codedHeight, single.timestamp]).toEqual([49, 33, 0]);
		const expected = await decode(data, 2, 49, 33);
		const rgba = new Uint8Array(single.allocationSize());
		await single.copyTo(rgba);
		for (let y = 0; y < 33; y++) {
			for (let x = 0; x < 49; x++) {
				for (let c = 0; c < 3; c++) {
					expect(rgba[(y * 49 + x) * 4 + c])
						.toBe(Math.max(0, Math.min(65535, expected[(y * 3 + c) * 49 + x]! | 0)) >>> 8);
				}
			}
		}
		let frames = 0;
		for await (const sample of sink.samples()) {
			expect([sample.codedWidth, sample.codedHeight]).toEqual([49, 33]);
			sample.close();
			frames++;
		}
		expect(frames).toBe(5);
		expect((await new EncodedPacketSink(track).getFirstPacket())!.data).toEqual(data);
		await expect(new VideoSampleSink(track, { reducedResolution: { width: 193, height: 131 } }).getSample(0))
			.rejects.toThrow('complete resolution');
		expect(() => new CanvasSink(track, { crop: { left: 0, top: 0, width: 10, height: 10 },
			decoderOptions: { reducedResolution: { width: 49, height: 33 } } })).toThrow('Cropping');
	});
	it('should reject unsupported codecs without a full-packet decode fallback', async () => {
		using input = new Input({ formats: [MXF], source: new BufferSource(makeMxf({ videoOnly: true }).data) });
		const track = (await input.getPrimaryVideoTrack())!;
		await expect(new VideoSampleSink(track, { reducedResolution: { width: 32, height: 32 } }).getSample(0))
			.rejects.toThrow('requires an HTJ2K track');
	});
	it('should enforce owned metadata packets, relative bounds and disposal on readers', async () => {
		using input = makeInput();
		const track = (await input.getPrimaryVideoTrack())!;
		const packets = new EncodedPacketSink(track);
		const metadata = (await packets.getFirstPacket({ metadataOnly: true }))!;
		const reader = await track._backing.getVideoDecodePacketReader!(metadata);
		expect(reader.byteLength).toBe(data.length);
		expect(await reader.read(0, 2)).toEqual(data.subarray(0, 2));
		for (const [start, end] of [[-1, 1], [0, data.length + 1], [2, 1], [0.5, 2]]) {
			await expect(reader.read(start!, end!)).rejects.toThrow('bounds');
		}
		using other = makeInput();
		const otherTrack = (await other.getPrimaryVideoTrack())!;
		await expect(otherTrack._backing.getVideoDecodePacketReader!(metadata)).rejects.toThrow('owned');
		input.dispose();
		await expect(reader.read(0, 2)).rejects.toThrow();
	});
	it('should stop reading after input disposal during an in-flight reduced request', async () => {
		const file = makeMxf({ htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true }).data;
		let hold = false;
		let reads = 0;
		let release!: () => void;
		let started!: () => void;
		const waiting = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.length,
			maxCacheSize: 0, read: async (start, end) => {
				reads++;
				if (hold) {
					started();
					await gate;
				}
				return file.subarray(start, end);
			} }) });
		const track = (await input.getPrimaryVideoTrack())!;
		hold = true;
		const pending = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } }).getSample(0);
		const rejected = expect(pending).rejects.toThrow();
		await waiting;
		const beforeDispose = reads;
		input.dispose();
		release();
		await rejected;
		expect(reads).toBe(beforeDispose);
	});
	it.each([
		{ finite: true, wrapper: 'direct' }, { finite: false, wrapper: 'direct' },
		{ finite: true, wrapper: 'slice' }, { finite: false, wrapper: 'slice' },
		{ finite: true, wrapper: 'pathed' }, { finite: false, wrapper: 'pathed' },
	])('should require finite HTTP policy ($finite) through $wrapper sources', async ({ finite, wrapper }) => {
		const file = makeMxf({ htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true }).data;
		const ranges: [number, number][] = [];
		const source = new UrlSource('https://example.invalid/immutable.mxf', {
			rangePolicy: finite ? { minimumRequestSize: 32768 } : undefined,
			fetchFn: async (_url, init) => {
				if (init?.method === 'HEAD') {
					return new Response(null, { headers: { 'Content-Length': `${file.length}` } });
				}
				const range = new Headers(init?.headers).get('Range')!;
				const match = /^bytes=(\d+)-(\d*)$/.exec(range)!;
				if (finite) expect(match[2]).not.toBe('');
				const start = Number(match[1]);
				const end = Math.min(match[2] ? Number(match[2]) + 1 : file.length, file.length);
				ranges.push([start, end]);
				return new Response(new Uint8Array(file.subarray(start, end)), { status: 206, headers: {
					'Content-Range': `bytes ${start}-${end - 1}/${file.length}`, 'Content-Length': `${end - start}`,
				} });
			},
		});
		const wrapped = wrapper === 'slice'
			? source.slice(0)
			: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', () => source) : source;
		using input = new Input({ formats: [MXF], source: wrapped });
		const track = (await input.getPrimaryVideoTrack())!;
		const pending = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } }).getSample(0);
		if (!finite) {
			await expect(pending).rejects.toThrow('finite UrlSource');
			return;
		}
		using sample = (await pending)!;
		expect(sample.codedWidth).toBe(25);
		const payloadStart = Buffer.from(file).indexOf(data);
		expect(payloadStart).toBeGreaterThan(0);
		const payloadReads = ranges.filter(([start, end]) => start < payloadStart + data.length && end > payloadStart);
		expect(payloadReads.length).toBeGreaterThan(0);
		// Format detection can already have supplied the first 32 KiB before the MXF backing is selected.
		for (const [, end] of payloadReads) {
			expect(end).toBeLessThanOrEqual(Math.max(32768, payloadStart + Math.min(data.length, 640 * 1024)));
		}
	});
	it('should retain the physical 206 requirement after return with pending response headers', async () => {
		registerHtj2kDecoder();
		const file = makeMxf({ htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true }).data;
		let late = false;
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
		const source = new UrlSource('https://offline.invalid/late-headers.mxf', {
			rangePolicy: { minimumRequestSize: 32768 }, maxCacheSize: 0, getRetryDelay: () => null,
			fetchFn: async (_url, init) => {
				if (late) {
					entered();
					await gate;
					return new Response(new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls++;
							controller.enqueue(file);
						},
						cancel() { canceled = true; },
					}, { highWaterMark: 0 }), { status: 200 });
				}
				const match = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range')!)!;
				const start = Number(match[1]);
				const end = Math.min(Number(match[2]) + 1, file.length);
				return new Response(new Uint8Array(file.subarray(start, end)), { status: 206, headers: {
					'Content-Range': `bytes ${start}-${end - 1}/${file.length}`,
				} });
			},
		});
		using input = new Input({ formats: [MXF], source });
		const track = (await input.getPrimaryVideoTrack())!;
		await track.getDecoderConfig();
		await new EncodedPacketSink(track).getPacket(0, { metadataOnly: true });
		late = true;
		const iterator = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } })
			.samplesAtTimestamps([0]);
		const pending = iterator.next();
		try {
			await started;
			await iterator.return();
			expect((await pending).done).toBe(true);
			release();
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(canceled).toBe(true);
			expect(pulls).toBe(0);
			late = false;
			const packet = (await new EncodedPacketSink(track).getFirstPacket())!;
			expect(packet.data).toEqual(new Uint8Array(data));
		} finally {
			release();
			await iterator.return();
		}
	});
	it('should cancel a late HTTP 200 body after successful 206 discovery', async () => {
		const file = makeMxf({ htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true }).data;
		let late = false;
		let canceled = false;
		let pulls = 0;
		const source = new UrlSource('https://example.invalid/late.mxf', {
			rangePolicy: { minimumRequestSize: 32768 }, maxCacheSize: 0,
			fetchFn: async (_url, init) => {
				if (late) {
					return new Response(new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls++;
							controller.enqueue(new Uint8Array(file));
						},
						cancel() { canceled = true; },
					}, { highWaterMark: 0 }), { status: 200 });
				}
				const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
				const start = Number(match[1]);
				const end = Math.min(Number(match[2]) + 1, file.length);
				return new Response(new Uint8Array(file.subarray(start, end)), { status: 206, headers: {
					'Content-Range': `bytes ${start}-${end - 1}/${file.length}`,
				} });
			},
		});
		using input = new Input({ formats: [MXF], source: source.slice(0) });
		const track = (await input.getPrimaryVideoTrack())!;
		const packet = (await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true }))!;
		const reader = await track._backing.getVideoDecodePacketReader!(packet);
		late = true;
		await expect(extractReduced(reader, { width: 25, height: 17 }, { width: 193, height: 131, bits: 16 }))
			.rejects.toThrow(/206/);
		expect(canceled).toBe(true);
		expect(pulls).toBe(0);
	});
	it.each(['range', 'timestamps', 'canvas-range', 'canvas-timestamps'] as const)(
		'should cancel reads on %s iterator return', async (mode) => {
			registerHtj2kDecoder();
			const file = makeMxf({ htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true }).data;
			let hold = false;
			let reads = 0;
			let release!: () => void;
			let started!: () => void;
			const waiting = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.length,
				maxCacheSize: 0, read: async (start, end) => {
					reads++;
					if (hold && end - start >= 16384) {
						started();
						await gate;
					}
					return file.subarray(start, end);
				} }) });
			const track = (await input.getPrimaryVideoTrack())!;
			// Warm metadata navigation so the gate catches extraction, not packet discovery.
			const packets = new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true });
			for await (const _packet of packets) {
				void _packet;
			}
			const sink = new VideoSampleSink(track, { reducedResolution: { width: 97, height: 66 } });
			hold = true;
			const canvases = new CanvasSink(track, {
				decoderOptions: { reducedResolution: { width: 97, height: 66 } },
			});
			const iterator = mode === 'range'
				? sink.samples()
				: mode === 'timestamps'
					? sink.samplesAtTimestamps([0, 0.04, 0.08])
					: mode === 'canvas-range' ? canvases.canvases() : canvases.canvasesAtTimestamps([0, 0.04, 0.08]);
			const pending = iterator.next();
			await waiting;
			await new Promise(resolve => setTimeout(resolve, 20));
			await iterator.return();
			const count = reads;
			release();
			expect((await pending).done).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(reads).toBe(count);
		});
});

describe('given malformed or unsupported partial codestreams', () => {
	const original = new Uint8Array(readFileSync(new URL('../fixtures/htj2k/rpcl-193x131-16.j2c', import.meta.url)));
	const markerOffset = (marker: number): number => {
		for (let i = 2; i < original.length - 1;) {
			if (original[i] === 255 && original[i + 1] === marker) return i;
			i += 2 + original[i + 2]! * 256 + original[i + 3]!;
		}
		throw new Error('Fixture marker not found');
	};
	const extract = (data: Uint8Array, byteLength = data.length) => extractReduced({ byteLength,
		read: async (start, end) => data.subarray(start, end) },
	{ width: 25, height: 17 }, { width: 193, height: 131, bits: 16 });
	it.each([
		['progression', markerOffset(0x52) + 5, 0],
		['layers', markerOffset(0x52) + 7, 2],
		['MCT', markerOffset(0x52) + 8, 0],
		['decompositions', markerOffset(0x52) + 9, 32],
		['codeblock', markerOffset(0x52) + 10, 255],
		['precinct', markerOffset(0x52) + 14, 0],
		['wavelet', markerOffset(0x52) + 13, 0],
		['quantization', markerOffset(0x5c) + 4, 1],
		['guard bits', markerOffset(0x5c) + 4, 0xe0],
		['exponent', markerOffset(0x5c) + 5, 0xf8],
		['marker override', markerOffset(0x5c) + 1, 0x5d],
		['signed component', 42, 143],
		['component sampling', 43, 2],
		['origin', 19, 1],
		['tile parts', markerOffset(0x90) + 11, 2],
	] as const)('should reject unsupported %s before deriving decode input',
		async (_name: string, offset: number, value: number) => {
			const changed = original.slice();
			changed[offset] = value;
			await expect(extract(changed)).rejects.toThrow('Unsupported or invalid HTJ2K');
		});
	it('should reject missing header and packet-body bytes, including the last required byte', async () => {
		const result = await extract(original);
		for (const end of [1, 50, markerOffset(0x90) + 14, result.coverage.requiredEnd - 1]) {
			await expect(extract(original.subarray(0, end), original.length)).rejects.toThrow('coverage');
		}
	});
	it('should bound source and derived allocations before reading attacker-controlled byte lengths', async () => {
		let reads = 0;
		await expect(extractReduced({ byteLength: 2 ** 40, read: async () => {
			reads++;
			return new Uint8Array();
		} }, { width: 1, height: 1 }, { width: 193, height: 131, bits: 16 })).rejects.toThrow('byte limit');
		expect(reads).toBe(0);
	});
	it('should reject malicious packet header stuffing rather than scanning entropy bytes for markers', async () => {
		const changed = original.slice();
		changed.fill(255, markerOffset(0x90) + 14);
		await expect(extract(changed)).rejects.toThrow(/stuffing|tag-tree|Lblock/);
	});
	it.each([
		['111' + '0'.repeat(64), 'tag-tree'],
		['111110' + '1'.repeat(30), 'Lblock'],
		['1111100000', 'cleanup'],
	])('should reject an overlong or invalid packet field %s', async (bitString, reason) => {
		const changed = original.slice();
		let offset = markerOffset(0x90) + 14;
		let capacity = 8;
		while (bitString.length) {
			const byte = Number.parseInt(bitString.slice(0, capacity).padEnd(capacity, '0'), 2);
			changed[offset++] = byte;
			bitString = bitString.slice(capacity);
			capacity = byte === 255 ? 7 : 8;
		}
		await expect(extract(changed)).rejects.toThrow(reason);
	});
	it('should reject excessive packet geometry without allocating packet or codeblock arrays', async () => {
		const changed = original.slice();
		const view = new DataView(changed.buffer);
		for (const offset of [8, 12, 24, 28]) view.setUint32(offset, 4096);
		changed[markerOffset(0x52) + 17] = 0x45;
		await expect(extractReduced({ byteLength: changed.length,
			read: async (start, end) => changed.subarray(start, end) },
		{ width: 512, height: 512 }, { width: 4096, height: 4096, bits: 16 })).rejects.toThrow('packet count');
	});
	it('should bound retained codeblock positions before parsing bodies', async () => {
		const changed = original.slice();
		const view = new DataView(changed.buffer);
		for (const offset of [8, 12, 24, 28]) view.setUint32(offset, 4096);
		changed[markerOffset(0x52) + 10] = 0;
		changed[markerOffset(0x52) + 11] = 0;
		await expect(extractReduced({ byteLength: changed.length,
			read: async (start, end) => changed.subarray(start, end) },
		{ width: 2048, height: 2048 }, { width: 4096, height: 4096, bits: 16 })).rejects.toThrow('codeblock count');
	});
});
