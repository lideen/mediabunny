import { describe, expect, it, vi } from 'vitest';
import { BufferSource, CustomVideoDecoder, Input, LXF, VideoSampleSink, registerDecoder,
	type VideoCodec } from '../../src/index.js';
import { lxfFixture } from './lxf-fixture.js';

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

let operation: 'decode' | 'flush';
let cancellable = true;
let entered = deferred();
let pending = deferred();
let closed = deferred();
let canceled = false;
let closeCount = 0;

class StalledDecoder extends CustomVideoDecoder {
	static override supports(codec: VideoCodec): boolean { return codec === 'mpeg2'; }
	init() {}
	decode() {
		if (operation === 'decode') {
			entered.resolve();
			return pending.promise;
		}
	}

	flush() {
		if (operation === 'flush') {
			entered.resolve();
			return pending.promise;
		}
	}

	close() {
		closeCount++;
		closed.resolve();
	}
}

class CancelableDecoder extends StalledDecoder {
	static override supports(codec: VideoCodec) { return cancellable && super.supports(codec); }
	override cancel() {
		if (canceled) return;
		canceled = true;
		pending.reject(new Error('Decoder canceled'));
	}
}

registerDecoder(CancelableDecoder);
registerDecoder(StalledDecoder);

const setup = async (mode: 'range' | 'timestamps', signal: AbortSignal) => {
	entered = deferred();
	pending = deferred();
	closed = deferred();
	canceled = false;
	closeCount = 0;
	const fixture = lxfFixture(2);
	const input = new Input({ formats: [LXF], source: new BufferSource(fixture.read(0, fixture.size)) });
	const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
	const iterator = mode === 'range'
		? sink.samples(undefined, undefined, { signal })
		: sink.samplesAtTimestamps([fixture.origin / 720000], { signal });
	return { input, iterator };
};

describe('given a custom decoder stalled without emitting samples', () => {
	for (const mode of ['range', 'timestamps'] as const) {
		it(`should observe ${mode} abort between validation and listener attachment`, async () => {
			operation = 'decode';
			cancellable = true;
			const controller = new AbortController();
			const attach = controller.signal.addEventListener.bind(controller.signal);
			vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
				controller.abort();
				attach(type, listener, options);
			});
			const { input, iterator } = await setup(mode, controller.signal);
			try {
				await expect(iterator.next()).rejects.toBe(controller.signal.reason);
			} finally {
				pending.resolve();
				await iterator.return();
				input.dispose();
				vi.restoreAllMocks();
			}
		});

		it.each(['EOF', 'error', 'return'] as const)(`should remove the ${mode} abort listener on %s`, async (end) => {
			operation = 'flush';
			cancellable = true;
			const controller = new AbortController();
			const added = vi.spyOn(controller.signal, 'addEventListener');
			const removed = vi.spyOn(controller.signal, 'removeEventListener');
			const { input, iterator } = await setup(mode, controller.signal);
			try {
				const next = iterator.next();
				const observed = next.catch(error => error as unknown);
				await entered.promise;
				if (end === 'EOF') pending.resolve();
				else if (end === 'error') pending.reject(new Error('Real decode failure'));
				else await iterator.return();
				const result = await observed;
				if (end === 'error') expect(result).toEqual(new Error('Real decode failure'));
				else if (end === 'EOF') {
					// Timestamp selection can first return null for a decoder that emitted no sample.
					await iterator.next();
				}
				await closed.promise;
				expect(closeCount).toBe(1);
				for (const [type, listener] of added.mock.calls) {
					if (type === 'abort') expect(removed.mock.calls.some(call => call[1] === listener)).toBe(true);
				}
			} finally {
				pending.resolve();
				await iterator.return();
				input.dispose();
				vi.restoreAllMocks();
			}
		});

		it.each(['decode', 'flush'] as const)(`should interrupt pending %s on ${mode} abort`, async (op) => {
			operation = op;
			cancellable = true;
			const controller = new AbortController();
			const added = vi.spyOn(controller.signal, 'addEventListener');
			const removed = vi.spyOn(controller.signal, 'removeEventListener');
			const { input, iterator } = await setup(mode, controller.signal);
			try {
				const next = iterator.next();
				const observed = next.catch(error => error as unknown);
				await entered.promise;
				controller.abort(new Error('Requested cancellation'));
				expect(canceled).toBe(true);
				expect(await observed).toBe(controller.signal.reason);
				await closed.promise;
				expect(closeCount).toBe(1);
				for (const [type, listener] of added.mock.calls) {
					if (type === 'abort') expect(removed.mock.calls.some(call => call[1] === listener)).toBe(true);
				}
			} finally {
				pending.resolve();
				await iterator.return();
				input.dispose();
				vi.restoreAllMocks();
			}
		});

		it(`should reject ${mode} abort but preserve legacy close ordering until decode settles`, async () => {
			operation = 'decode';
			cancellable = false;
			const controller = new AbortController();
			const { input, iterator } = await setup(mode, controller.signal);
			try {
				const next = iterator.next();
				const observed = next.catch(error => error as unknown);
				await entered.promise;
				controller.abort();
				expect(await observed).toBe(controller.signal.reason);
				expect(closeCount).toBe(0);
				pending.resolve();
				await closed.promise;
				expect(closeCount).toBe(1);
			} finally {
				pending.resolve();
				await iterator.return();
				input.dispose();
			}
		});
	}
});
