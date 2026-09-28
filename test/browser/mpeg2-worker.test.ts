import { describe, expect, it } from 'vitest';
import { Input, BufferSource, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import progressiveUrl from '../fixtures/mpeg2/main420.mxf?url';
import interlacedUrl from '../fixtures/mpeg2/open/interlaced422.mxf?url';
import progressive from '../fixtures/mpeg2/pixels.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-idct-v1.json' with { type: 'json' };
import interlaced from '../fixtures/mpeg2/open/interlaced422.json' with { type: 'json' };

const hash = async (bytes: Uint8Array<ArrayBuffer>) => {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

describe('given the built MPEG-2 extension and a real browser Worker', () => {
	it.each(['init', 'decode', 'flush'] as const)('should abort a real worker stalled on %s', async (operation) => {
		registerMpeg2Decoder({ useWorker: true });
		const data = await (await fetch(progressiveUrl)).arrayBuffer();
		using input = new Input({ formats: [MXF], source: new BufferSource(data) });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		const NativeWorker = globalThis.Worker;
		const urls: string[] = [];
		const workers: Worker[] = [];
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let terminations = 0;
		try {
			globalThis.Worker = class extends NativeWorker {
				constructor(url: string | URL, options?: WorkerOptions) {
					const bootstrap = URL.createObjectURL(new Blob([`
						importScripts(${JSON.stringify(String(url))});
						const receive = self.onmessage;
						self.onmessage = (event) => {
							if (event.data.op !== ${JSON.stringify(operation)}) receive(event);
						};
					`], { type: 'text/javascript' }));
					urls.push(bootstrap);
					super(bootstrap, options);
					workers.push(this);
				}

				override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
					if (Array.isArray(options)) super.postMessage(message, options);
					else super.postMessage(message, options);
					if ((message as { op: string }).op === operation) entered();
				}

				override terminate() {
					terminations++;
					super.terminate();
				}
			};
			const controller = new AbortController();
			const pending = sink.getSample(0, { signal: controller.signal });
			const observed = pending.catch(error => error as unknown);
			await blocked;
			controller.abort();
			expect(terminations).toBe(1);
			expect(await observed).toBe(controller.signal.reason);
		} finally {
			globalThis.Worker = NativeWorker;
			input.dispose();
			for (const worker of workers) NativeWorker.prototype.terminate.call(worker);
			for (const url of urls) URL.revokeObjectURL(url);
		}
	});

	it('should reject a pending selection when both the worker reply and error report cannot be sent', async () => {
		registerMpeg2Decoder({ useWorker: true });
		const data = await (await fetch(progressiveUrl)).arrayBuffer();
		using input = new Input({ formats: [MXF], source: new BufferSource(data) });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		const NativeWorker = globalThis.Worker;
		const workers: Worker[] = [];
		const urls: string[] = [];
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			globalThis.Worker = class extends NativeWorker {
				constructor(url: string | URL, options?: WorkerOptions) {
					const bootstrap = URL.createObjectURL(new Blob([`
						let successSendFailed = false;
						self.postMessage = (reply) => {
							if (reply.ok) {
								successSendFailed = true;
								throw new Error('Injected success send failure');
							}
							throw new Error(successSendFailed
								? 'Injected error report failure after success send failure'
								: 'Unexpected initialization failure');
						};
						importScripts(${JSON.stringify(String(url))});
					`], { type: 'text/javascript' }));
					urls.push(bootstrap);
					super(bootstrap, options);
					workers.push(this);
				}
			};
			const deadline = new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error('Worker selection remained pending')), 5000);
			});
			await expect(Promise.race([sink.getSample(0), deadline]))
				.rejects.toThrow('Injected error report failure after success send failure');
		} finally {
			clearTimeout(timeout);
			globalThis.Worker = NativeWorker;
			input.dispose();
			for (const worker of workers) worker.terminate();
			for (const url of urls) URL.revokeObjectURL(url);
		}
	}, 10000);

	it('should decode all authored progressive pictures with qualified WASM plane hashes', async () => {
		registerMpeg2Decoder({ useWorker: true });
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
	});

	it('should retain woven clone pixels after worker termination and repeated open-GOP selections', async () => {
		registerMpeg2Decoder({ useWorker: true });
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
