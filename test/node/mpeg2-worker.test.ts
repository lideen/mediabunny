import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { lxfFixture } from './lxf-fixture.js';
import type { WorkerFrame, WorkerRequest, WorkerResponse } from '../../packages/mpeg2/src/worker-protocol.js';
import type { CustomVideoDecoder, VideoSample } from '../../src/index.js';

// Only the browser transport is faked. Input, packet planning, sample construction and sink serialization are real.
class FakeWorker extends EventTarget {
	static instances: FakeWorker[] = [];
	static receive = (worker: FakeWorker, request: WorkerRequest) => worker.reply(request);
	requests: WorkerRequest[] = [];
	terminated = false;
	inFlight = 0;
	width = 0;
	height = 0;
	lastTimestamp = 0;
	constructor() {
		super();
		FakeWorker.instances.push(this);
	}

	postMessage(request: WorkerRequest, transfer: Transferable[]) {
		if (++this.inFlight !== 1) throw new Error('Concurrent worker requests');
		const message = structuredClone(request, { transfer });
		this.requests.push(message);
		if (message.op === 'init') {
			this.width = message.width;
			this.height = message.height;
		}
		if (message.op === 'decode') this.lastTimestamp = message.timestamp;
		FakeWorker.receive(this, message);
	}

	frame(timestamp = this.lastTimestamp): WorkerFrame {
		const y = this.width * this.height;
		const chroma = Math.ceil(this.width / 2) * this.height;
		return {
			data: new Uint8Array(y + 2 * chroma).fill(42).buffer,
			width: this.width, height: this.height, format: 'I422', scan: 'interlaced-top-first',
			timestamp, duration: 0.04,
			layout: [{ offset: 0, stride: this.width }, { offset: y, stride: Math.ceil(this.width / 2) },
				{ offset: y + chroma, stride: Math.ceil(this.width / 2) }],
		};
	}

	reply(request: WorkerRequest, frames: WorkerFrame[] = []) {
		this.respond({ id: request.id, ok: true, frames });
	}

	respond(response: WorkerResponse) {
		this.inFlight--;
		const transfer = response.ok ? response.frames.map(frame => frame.data) : [];
		this.dispatchEvent(new MessageEvent('message', { data: structuredClone(response, { transfer }) }));
	}

	terminate() { this.terminated = true; }
}

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 1000; i++) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error('Public worker operation did not reach the expected transport boundary');
};

const setup = async () => {
	vi.resetModules();
	FakeWorker.instances = [];
	FakeWorker.receive = (worker, request) => worker.reply(request,
		request.op === 'decode' ? [worker.frame()] : []);
	vi.stubGlobal('Worker', FakeWorker);
	const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-mpeg2-test');
	const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	const core = await import('../../src/index.js');
	const registration = vi.spyOn(core, 'registerDecoder');
	const extension = await import('@mediabunny/mpeg2');
	extension.registerMpeg2Decoder({ useWorker: true });
	const Decoder = registration.mock.calls[0]![0] as typeof core.CustomVideoDecoder;
	const fixture = lxfFixture(6);
	const bytes = fixture.read(0, fixture.size);
	const input = new core.Input({ formats: [core.LXF], source: new core.BufferSource(bytes) });
	return { core, extension, fixture, bytes, input, created, revoked, Decoder };
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const registeredVideo = (Decoder: typeof CustomVideoDecoder) => {
	const decoder = Reflect.construct(Decoder, []) as CustomVideoDecoder;
	Object.assign(decoder, { codec: 'mpeg2', config: { codec: 'mpeg2', codedWidth: 64, codedHeight: 48 },
		onError: (error: unknown) => { throw error; } });
	return decoder;
};

describe('given explicit MPEG-2 worker registration and real sink lifecycle', () => {
	it('should reject initialization after close without creating a worker', async () => {
		const { Decoder, input } = await setup();
		input.dispose();
		const decoder = registeredVideo(Decoder);
		await decoder.close();
		await expect(decoder.init()).rejects.toThrow('canceled');
		expect(FakeWorker.instances).toHaveLength(0);
	});

	it.each(['close', 'throw'] as const)('should stop output on callback %s', async (action) => {
		const { core, Decoder, input } = await setup();
		input.dispose();
		const decoder = registeredVideo(Decoder);
		const samples: VideoSample[] = [];
		const failure = new Error('consumer callback failed');
		Object.assign(decoder, { onSample: (sample: VideoSample) => {
			samples.push(sample);
			if (action === 'throw') throw failure;
			void decoder.close();
		} });
		FakeWorker.receive = (worker, request) => worker.reply(request,
			request.op === 'decode' ? [worker.frame(0), worker.frame(0.04)] : []);
		try {
			await decoder.init();
			const backing = Uint8Array.from([99, 1, 2, 3, 88]);
			const packet = new core.EncodedPacket(backing.subarray(1, 4), 'key', 0, 0.04);
			if (action === 'throw') await expect(decoder.decode(packet)).rejects.toBe(failure);
			else await decoder.decode(packet);
			expect(samples).toHaveLength(1);
			expect(backing).toEqual(Uint8Array.from([99, 1, 2, 3, 88]));
			const request = FakeWorker.instances[0]!.requests.at(-1)!;
			if (request.op !== 'decode') throw new Error('Expected a decode request');
			expect(new Uint8Array(request.data)).toEqual(Uint8Array.from([1, 2, 3]));
			expect(FakeWorker.instances[0]!.terminated).toBe(true);
			if (action === 'throw') expect(() => samples[0]!.clone()).toThrow('closed');
			else {
				const pixels = new Uint8Array(samples[0]!.allocationSize());
				await samples[0]!.copyTo(pixels);
				expect(pixels).toEqual(new Uint8Array(pixels.length).fill(42));
			}
			await expect(decoder.flush()).rejects.toThrow();
			expect(FakeWorker.instances).toHaveLength(1);
		} finally {
			await decoder.close();
			for (const sample of samples) sample.close();
		}
	});

	it('should reject conflicting registration instead of silently choosing a backend', async () => {
		const { extension, input } = await setup();
		try {
			expect(() => extension.registerMpeg2Decoder({ useWorker: true })).not.toThrow();
			expect(() => extension.registerMpeg2Decoder()).toThrow('different mode');
		} finally {
			input.dispose();
		}
	});

	it('should fail explicitly when Worker is unavailable', async () => {
		const { core, input, fixture } = await setup();
		vi.stubGlobal('Worker', undefined);
		try {
			const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getSample(fixture.origin / 720000)).rejects.toThrow('requires browser Worker');
		} finally {
			input.dispose();
		}
	});

	it('should revoke its URL and expose a worker-construction failure without direct fallback', async () => {
		const { core, input, fixture, revoked } = await setup();
		vi.stubGlobal('Worker', class {
			constructor() { throw new Error('CSP denied blob worker'); }
		});
		try {
			const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getSample(fixture.origin / 720000)).rejects.toThrow('CSP denied blob worker');
			expect(revoked).toHaveBeenCalledWith('blob:owned-mpeg2-test');
		} finally {
			input.dispose();
		}
	});

	it.each(['init', 'decode', 'flush'] as const)(
		'should terminate and settle cancellation during pending %s', async (op) => {
			const { core, input, fixture } = await setup();
			FakeWorker.receive = (worker, request) => {
				if (request.op !== op) worker.reply(request);
			};
			const controller = new AbortController();
			try {
				const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
				const pending = sink.getSample(fixture.origin / 720000, { signal: controller.signal });
				const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
				await until(() => FakeWorker.instances[0]?.requests.some(request => request.op === op) ?? false);
				const worker = FakeWorker.instances[0]!;
				controller.abort();
				await rejected;
				await until(() => worker.terminated);
				const requests = worker.requests.length;
				worker.reply(worker.requests.at(-1)!, op === 'decode' ? [worker.frame()] : []);
				await Promise.resolve();
				expect(worker.requests.length).toBe(requests);
				expect(FakeWorker.instances).toHaveLength(1);
			} finally {
				input.dispose();
			}
		},
	);

	it('should terminate a pending initialization when its Input is disposed', async () => {
		const { core, input, fixture } = await setup();
		FakeWorker.receive = () => {};
		const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
		const pending = sink.getSample(fixture.origin / 720000);
		const rejected = expect(pending).rejects.toThrow();
		await until(() => FakeWorker.instances.length === 1);
		input.dispose();
		await rejected;
		await until(() => FakeWorker.instances[0]!.terminated);
	});

	it('should preserve owned pixels and caller storage after worker termination', async () => {
		const { core, input, fixture, bytes } = await setup();
		const original = Buffer.from(bytes);
		try {
			const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
			using sample = (await sink.getSample(fixture.origin / 720000))!;
			using clone = sample.clone();
			sample.close();
			input.dispose();
			await until(() => FakeWorker.instances.every(worker => worker.terminated));
			const pixels = new Uint8Array(clone.allocationSize());
			await clone.copyTo(pixels);
			expect(pixels).toEqual(new Uint8Array(pixels.length).fill(42));
			expect(clone.scan).toBe('interlaced-top-first');
			expect(bytes).toEqual(original);
			const request = FakeWorker.instances[0]!.requests.find(request => request.op === 'decode')!;
			if (request.op !== 'decode') throw new Error('Missing packet transport');
			expect(new Uint8Array(request.data)).toEqual(new Uint8Array(fixture.video));
		} finally {
			input.dispose();
		}
	});

	it('should surface initialization errors and terminate rather than hang', async () => {
		const { core, input, fixture } = await setup();
		FakeWorker.receive = (worker, request) => worker.respond({ id: request.id, ok: false,
			message: 'ResourceLimit: rejected initialization' });
		try {
			const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getSample(fixture.origin / 720000)).rejects.toThrow('ResourceLimit');
			expect(FakeWorker.instances[0]!.terminated).toBe(true);
		} finally {
			input.dispose();
		}
	});

	it.each(['error', 'messageerror'])('should settle a pending request on worker %s', async (event) => {
		const { core, input, fixture } = await setup();
		FakeWorker.receive = (worker) => {
			worker.dispatchEvent(new Event(event));
		};
		try {
			const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getSample(fixture.origin / 720000)).rejects.toThrow('MPEG-2 worker');
			expect(FakeWorker.instances[0]!.terminated).toBe(true);
		} finally {
			input.dispose();
		}
	});

	it('should not create a worker for an already-aborted selection', async () => {
		const { core, input, fixture } = await setup();
		const controller = new AbortController();
		controller.abort();
		try {
			const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getSample(fixture.origin / 720000, { signal: controller.signal }))
				.rejects.toMatchObject({ name: 'AbortError' });
			expect(FakeWorker.instances).toHaveLength(0);
		} finally {
			input.dispose();
		}
	});

	it('should terminate pending initialization when a range iterator is returned', async () => {
		const { core, input } = await setup();
		FakeWorker.receive = () => {};
		try {
			const iterator = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!).samples();
			const next = iterator.next();
			await until(() => FakeWorker.instances.length === 1);
			await iterator.return();
			expect((await next).done).toBe(true);
			await until(() => FakeWorker.instances[0]!.terminated);
		} finally {
			input.dispose();
		}
	});

	it.each(['id', 'storage', 'timing', 'dimensions'])(
		'should reject invalid reply %s before exposing a sample', async (kind) => {
			const { core, input, fixture } = await setup();
			FakeWorker.receive = (worker, request) => {
				if (request.op !== 'decode') return worker.reply(request);
				const frame = worker.frame();
				if (kind === 'storage') frame.data = new ArrayBuffer(1);
				if (kind === 'timing') frame.timestamp = NaN;
				if (kind === 'dimensions') frame.width++;
				worker.respond({ id: request.id + (kind === 'id' ? 1 : 0), ok: true, frames: [frame] });
			};
			try {
				const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getSample(fixture.origin / 720000)).rejects.toThrow('worker protocol');
				expect(FakeWorker.instances[0]!.terminated).toBe(true);
			} finally {
				input.dispose();
			}
		},
	);

	it('should make progress through more than a queue of no-output replies and emit the flush anchor', async () => {
		const { core, input: unused } = await setup();
		unused.dispose();
		const fixture = lxfFixture(64);
		using input = new core.Input({ formats: [core.LXF],
			source: new core.BufferSource(fixture.read(0, fixture.size)) });
		FakeWorker.receive = (worker, request) => worker.reply(request,
			request.op === 'flush' ? [worker.frame()] : []);
		const samples = [];
		for await (const sample of new core.VideoSampleSink((await input.getPrimaryVideoTrack())!).samples()) {
			samples.push(sample.timestamp);
			sample.close();
		}
		expect(samples).toEqual([(fixture.origin + 63 * 28800) / 720000]);
		expect(FakeWorker.instances[0]!.requests.filter(request => request.op === 'decode')).toHaveLength(64);
	});

	it('should carry header-only preroll through the same serialized worker without requiring a frame', async () => {
		const { core, input: unused } = await setup();
		unused.dispose();
		using input = new core.Input({ formats: [core.MXF], source: new core.BufferSource(readFileSync(
			new URL('../fixtures/mpeg2/open/open422.mxf', import.meta.url),
		)) });
		using sample = (await new core.VideoSampleSink((await input.getPrimaryVideoTrack())!).getSample(17 / 25))!;
		expect(sample.timestamp).toBe(17 / 25);
		expect(FakeWorker.instances[0]!.requests.some(request => request.op === 'preroll')).toBe(true);
	});
});
