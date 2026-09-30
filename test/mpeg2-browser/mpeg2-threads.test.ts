import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Input, BufferSource, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import progressiveUrl from '../fixtures/mpeg2/main420.mxf?url';
import progressive from '../fixtures/mpeg2/pixels.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-bridct-v1.json' with { type: 'json' };
import { waitForWorkerRequest, withDeadline } from '../mpeg2-lifecycle.js';

const concurrencyDescriptor = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');
beforeEach(() => Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 4 }));
afterEach(() => {
	if (concurrencyDescriptor) {
		Object.defineProperty(navigator, 'hardwareConcurrency', concurrencyDescriptor);
	} else {
		Reflect.deleteProperty(navigator, 'hardwareConcurrency');
	}
});

const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(
	new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0'),
).join('');

describe('given MPEG-2 registration in an isolated browser reporting four logical CPUs', () => {
	it('should retain regression pixels after terminating the coordinator and four pool workers', async () => {
		expect(crossOriginIsolated).toBe(true);
		registerMpeg2Decoder();
		const NativeWorker = Worker;
		const workers: Worker[] = [];
		const terminated = new Set<Worker>();
		globalThis.Worker = class extends NativeWorker {
			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				workers.push(this);
			}

			override terminate() {
				terminated.add(this);
				super.terminate();
			}
		};
		try {
			using input = new Input({ formats: [MXF],
				source: new BufferSource(await (await fetch(progressiveUrl)).arrayBuffer()) });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			const sample = await sink.getSample(0);
			expect(sample).not.toBeNull();
			using clone = sample!.clone();
			sample!.close();
			input.dispose();
			await expect.poll(() => terminated.size).toBe(5);
			expect(workers).toHaveLength(5);
			const pixels = new Uint8Array(clone.allocationSize());
			await clone.copyTo(pixels);
			const ySize = progressive.width * progressive.height;
			const chromaSize = ySize / 4;
			expect(await Promise.all([
				hash(pixels.slice(0, ySize)),
				hash(pixels.slice(ySize, ySize + chromaSize)),
				hash(pixels.slice(ySize + chromaSize)),
			])).toEqual(regression.cases.main420.frames[0]!.planes);
		} finally {
			globalThis.Worker = NativeWorker;
			for (const worker of workers) {
				NativeWorker.prototype.terminate.call(worker);
			}
		}
	});

	it('should terminate owned workers when a selection is aborted during blocked pool initialization', async () => {
		registerMpeg2Decoder();
		const NativeWorker = Worker;
		const workers: Worker[] = [];
		const terminated = new Set<Worker>();
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		globalThis.Worker = class extends NativeWorker {
			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				workers.push(this);
			}

			override postMessage() {
				entered();
			}

			override terminate() {
				terminated.add(this);
				super.terminate();
			}
		};
		try {
			using input = new Input({ formats: [MXF],
				source: new BufferSource(await (await fetch(progressiveUrl)).arrayBuffer()) });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			const controller = new AbortController();
			const pending = sink.getSample(0, { signal: controller.signal }).then(sample => sample?.close());
			const observed = pending.catch(error => error as unknown);
			await waitForWorkerRequest(blocked, pending);
			controller.abort();
			expect(await withDeadline(observed, 'Canceled selection did not settle')).toBe(controller.signal.reason);
			expect(workers.length).toBeGreaterThan(0);
			expect(terminated.size).toBe(workers.length);
		} finally {
			globalThis.Worker = NativeWorker;
			for (const worker of workers) {
				NativeWorker.prototype.terminate.call(worker);
			}
		}
	});
});
