import { describe, expect, it } from 'vitest';
import { Input, BufferSource, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import progressiveUrl from '../fixtures/mpeg2/main420.mxf?url';
import progressive from '../fixtures/mpeg2/pixels.json' with { type: 'json' };

const runtimeUrl = '/threads/js/threaded-runtime.mjs';

const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(
	new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0'),
).join('');

describe('given the opt-in MPEG-2 slice pool in an isolated browser', () => {
	it('should retain independent decoded pixels after terminating the coordinator and four pool workers', async () => {
		registerMpeg2Decoder({ threadCount: 4, threadedRuntimeUrl: new URL(runtimeUrl, location.href) });
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
		const input = new Input({ formats: [MXF],
			source: new BufferSource(await (await fetch(progressiveUrl)).arrayBuffer()) });
		try {
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
			])).toEqual(progressive.frames[0]!.planes);
		} finally {
			input.dispose();
			globalThis.Worker = NativeWorker;
			for (const worker of workers) NativeWorker.prototype.terminate.call(worker);
		}
	});

	it.each(['init', 'decode', 'finishSegment'] as const)(
		'should synchronously terminate owned workers when selection is aborted during %s', async (operation) => {
			registerMpeg2Decoder({ threadCount: 4, threadedRuntimeUrl: new URL(runtimeUrl, location.href) });
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

				override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
					if ((message as { operation?: string }).operation === operation) {
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
			using input = new Input({ formats: [MXF],
				source: new BufferSource(await (await fetch(progressiveUrl)).arrayBuffer()) });
			try {
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				const controller = new AbortController();
				const pending = sink.getSample(0, { signal: controller.signal }).catch(error => error as unknown);
				await blocked;
				controller.abort();
				expect(terminated.size).toBe(operation === 'init' ? 1 : 5);
				expect(await pending).toBe(controller.signal.reason);
			} finally {
				input.dispose();
				globalThis.Worker = NativeWorker;
				for (const worker of workers) NativeWorker.prototype.terminate.call(worker);
			}
		},
	);
});
