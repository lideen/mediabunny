import { afterEach, describe, expect, it, vi } from 'vitest';
import { lxfFixture } from './lxf-fixture.js';
import { waitForWorkerRequest, withDeadline } from '../mpeg2-lifecycle.js';

// Only worker startup is blocked. Registration, the factory, Input and sinks remain real.
class PendingWorker extends EventTarget {
	static instances: PendingWorker[] = [];
	static entered: () => void = () => {};
	terminated = false;
	constructor() {
		super();
		PendingWorker.instances.push(this);
		PendingWorker.entered();
	}

	postMessage() {}
	terminate() { this.terminated = true; }
}

const setup = async () => {
	vi.resetModules();
	PendingWorker.instances = [];
	const started = new Promise<void>((resolve) => {
		PendingWorker.entered = resolve;
	});
	vi.stubGlobal('Worker', PendingWorker);
	vi.stubGlobal('crossOriginIsolated', false);
	const core = await import('../../src/index.js');
	const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
	registerMpeg2Decoder();
	const fixture = lxfFixture();
	const input = new core.Input({ formats: [core.LXF],
		source: new core.BufferSource(fixture.read(0, fixture.size)) });
	const sink = new core.VideoSampleSink((await input.getPrimaryVideoTrack())!);
	return { core, fixture, input, sink, started };
};

afterEach(() => vi.unstubAllGlobals());

describe('given factory-backed MPEG-2 decoding through real sinks', () => {
	it.each(['abort', 'dispose', 'return'] as const)(
		'should cancel pending factory initialization on selection %s', async (action) => {
			const { input, sink, fixture, started } = await setup();
			const controller = new AbortController();
			const iterator = action === 'return' ? sink.samples() : null;
			const pending = iterator
				? iterator.next().then((result) => {
						if (!result.done) result.value.close();
						return result;
					})
				: sink.getSample(fixture.origin / 720000, { signal: controller.signal })
						.then(sample => sample?.close());
			const observed = pending.catch(error => error as unknown);
			try {
				await waitForWorkerRequest(started, pending);
				if (action === 'abort') controller.abort();
				else if (action === 'dispose') input.dispose();
				else await withDeadline(iterator!.return(), 'Canceled iterator did not return');
				const result = await withDeadline(observed, 'Canceled selection did not settle');
				if (action === 'return') expect(result).toMatchObject({ done: true });
				else if (action === 'abort') expect(result).toBe(controller.signal.reason);
				else expect(result).toBeInstanceOf(Error);
				await expect.poll(() => PendingWorker.instances.every(worker => worker.terminated)).toBe(true);
				expect(PendingWorker.instances).toHaveLength(1);
			} finally {
				input.dispose();
				for (const worker of PendingWorker.instances) worker.terminate();
				if (iterator) await withDeadline(iterator.return(), 'Iterator cleanup did not settle');
			}
		},
		10000,
	);

	it('should propagate factory startup failure and choose execution anew for another input', async () => {
		const { core, input, sink, fixture } = await setup();
		vi.stubGlobal('Worker', class {
			constructor() { throw new Error('CSP denied worker startup'); }
		});
		try {
			await expect(sink.getSample(fixture.origin / 720000)).rejects.toThrow('CSP denied worker startup');
		} finally {
			input.dispose();
		}
		vi.stubGlobal('Worker', undefined);
		using next = new core.Input({ formats: [core.LXF],
			source: new core.BufferSource(fixture.read(0, fixture.size)) });
		using sample = await new core.VideoSampleSink((await next.getPrimaryVideoTrack())!)
			.getSample(fixture.origin / 720000);
		expect(sample).toMatchObject({ format: 'I422', timestamp: fixture.origin / 720000, duration: 0.04 });
	});
});
