import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input, BufferSource, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import progressiveUrl from '../fixtures/mpeg2/main420.mxf?url';
import interlacedUrl from '../fixtures/mpeg2/open/interlaced422.mxf?url';
import progressive from '../fixtures/mpeg2/pixels.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-idct-v1.json' with { type: 'json' };
import interlaced from '../fixtures/mpeg2/open/interlaced422.json' with { type: 'json' };
import { waitForWorkerRequest, withDeadline } from '../mpeg2-lifecycle.js';

beforeEach(() => vi.stubGlobal('crossOriginIsolated', false));
afterEach(() => vi.unstubAllGlobals());

const hash = async (bytes: Uint8Array<ArrayBuffer>) => {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

describe('given the built MPEG-2 extension without cross-origin isolation', () => {
	it('should abort a real factory worker whose initialization cannot make progress', async () => {
		registerMpeg2Decoder();
		const data = await (await fetch(progressiveUrl)).arrayBuffer();
		using input = new Input({ formats: [MXF], source: new BufferSource(data) });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		const NativeWorker = Worker;
		const workers: Worker[] = [];
		const terminated = new Set<Worker>();
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		try {
			globalThis.Worker = class extends NativeWorker {
				constructor(url: string | URL, options?: WorkerOptions) {
					super(url, options);
					workers.push(this);
				}

				override postMessage() { entered(); }
				override terminate() {
					terminated.add(this);
					super.terminate();
				}
			};
			const controller = new AbortController();
			const pending = sink.getSample(0, { signal: controller.signal }).then(sample => sample?.close());
			const observed = pending.catch(error => error as unknown);
			await waitForWorkerRequest(blocked, pending);
			controller.abort();
			expect(await withDeadline(observed, 'Canceled selection did not settle')).toBe(controller.signal.reason);
			expect(workers).toHaveLength(1);
			expect(terminated.size).toBe(1);
		} finally {
			globalThis.Worker = NativeWorker;
			input.dispose();
			for (const worker of workers) NativeWorker.prototype.terminate.call(worker);
		}
	});

	it.each(['decode', 'finishSegment'] as const)(
		'should cancel an initialized factory decoder stalled at %s', async (operation) => {
			registerMpeg2Decoder();
			const data = await (await fetch(progressiveUrl)).arrayBuffer();
			using input = new Input({ formats: [MXF], source: new BufferSource(data) });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			const NativeWorker = Worker;
			const workers: Worker[] = [];
			const terminated = new Set<Worker>();
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				entered = resolve;
			});
			try {
				globalThis.Worker = class extends NativeWorker {
					constructor(url: string | URL, options?: WorkerOptions) {
						super(url, options);
						workers.push(this);
					}

					override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
						if (message !== null && typeof message === 'object'
							&& 'operation' in message && message.operation === operation) {
							entered();
							return;
						}
						if (Array.isArray(options)) super.postMessage(message, options);
						else super.postMessage(message, options);
					}

					override terminate() {
						terminated.add(this);
						super.terminate();
					}
				};
				const controller = new AbortController();
				const pending = sink.getSample(0, { signal: controller.signal }).then(sample => sample?.close());
				const observed = pending.catch(error => error as unknown);
				await waitForWorkerRequest(blocked, pending);
				controller.abort();
				expect(await withDeadline(observed, 'Canceled selection did not settle'))
					.toBe(controller.signal.reason);
				expect(workers).toHaveLength(1);
				expect(terminated.size).toBe(1);
			} finally {
				globalThis.Worker = NativeWorker;
				input.dispose();
				for (const worker of workers) NativeWorker.prototype.terminate.call(worker);
			}
		},
	);

	it('should default to one worker and decode all authored pictures with qualified WASM plane hashes', async () => {
		registerMpeg2Decoder();
		const NativeWorker = Worker;
		const workers: Worker[] = [];
		globalThis.Worker = class extends NativeWorker {
			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				workers.push(this);
			}
		};
		try {
			const data = await (await fetch(progressiveUrl)).arrayBuffer();
			using input = new Input({ formats: [MXF], source: new BufferSource(data) });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			let ordinal = 0;
			for await (const sample of sink.samples()) {
				try {
					const expected = progressive.frames[ordinal++]!;
					const pixels = new Uint8Array(sample.allocationSize());
					await sample.copyTo(pixels);
					expect([sample.timestamp, sample.duration, sample.scan, sample.format])
						.toEqual([expected.timestamp, expected.duration, 'progressive', 'I420']);
					expect(await Promise.all([hash(pixels.subarray(0, 921600)),
						hash(pixels.subarray(921600, 1152000)), hash(pixels.subarray(1152000))]))
						.toEqual(regression.cases.main420.frames[ordinal - 1]!.planes);
				} finally {
					sample.close();
				}
			}
			expect(ordinal).toBe(18);
			expect(workers).toHaveLength(1);
		} finally {
			globalThis.Worker = NativeWorker;
			for (const worker of workers) NativeWorker.prototype.terminate.call(worker);
		}
	});

	it('should retain woven clone pixels after worker termination and repeated open-GOP selections', async () => {
		registerMpeg2Decoder();
		const data = await (await fetch(interlacedUrl)).arrayBuffer();
		using input = new Input({ formats: [MXF], source: new BufferSource(data) });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		using first = (await sink.getSample(17 / 25))!;
		using clone = first.clone();
		first.close();
		const targets = [0, 17, 11, 10, 1];
		let selected = 0;
		for await (const sample of sink.samplesAtTimestamps(targets.map(ordinal => ordinal / 25))) {
			try {
				expect(sample).not.toBeNull();
				const pixels = new Uint8Array(sample!.allocationSize());
				await sample!.copyTo(pixels);
				expect(await hash(pixels)).toBe(interlaced.faani[targets[selected++]!]);
				expect(sample!.scan).toBe('interlaced-top-first');
			} finally {
				sample?.close();
			}
		}
		expect(selected).toBe(targets.length);
		input.dispose();
		const pixels = new Uint8Array(clone.allocationSize());
		await clone.copyTo(pixels);
		expect(await hash(pixels)).toBe(interlaced.faani[17]);
		expect([clone.timestamp, clone.duration, clone.scan]).toEqual([17 / 25, 1 / 25, 'interlaced-top-first']);
	});
});
