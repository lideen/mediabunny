import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import {
	CustomSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	PacketRetrievalOptions,
	WAVE,
} from '../../src/index.js';
import { promiseWithResolvers } from '../../src/misc.js';

const openInput = async () => {
	const bytes = await readFile(new URL('../public/glitch-hop-is-dead.wav', import.meta.url));
	const gate = promiseWithResolvers();
	let held = false;
	let heldReads = 0;
	let reads = 0;
	const input = new Input({
		formats: [WAVE],
		source: new CustomSource({
			getSize: () => bytes.length,
			maxCacheSize: 0,
			read: async (start, end) => {
				reads++;
				if (held) {
					heldReads++;
					await gate.promise;
				}
				return bytes.subarray(start, end);
			},
		}),
	});
	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		input.dispose();
		throw new Error('Expected a WAV audio track.');
	}
	return {
		input,
		sink: new EncodedPacketSink(track),
		hold: () => { held = true; },
		release: () => gate.resolve(),
		fail: (error: unknown) => gate.reject(error),
		get heldReads() { return heldReads; },
		get reads() { return reads; },
		[Symbol.dispose]() {
			gate.resolve();
			input.dispose();
		},
	};
};

const observe = <T>(promise: Promise<T>) => {
	let result: { value: T } | { error: unknown } | undefined;
	void promise.then(
		(value) => { result = { value }; },
		(error: unknown) => { result = { error }; },
	);
	return () => result;
};

const queries = [
	{ name: 'first packet', run: (sink: EncodedPacketSink, _: EncodedPacket, options: PacketRetrievalOptions) =>
		sink.getFirstPacket(options) },
	{ name: 'first key packet', run: (sink: EncodedPacketSink, _: EncodedPacket, options: PacketRetrievalOptions) =>
		sink.getFirstKeyPacket(options) },
	{ name: 'packet at a timestamp',
		run: (sink: EncodedPacketSink, _: EncodedPacket, options: PacketRetrievalOptions) =>
			sink.getPacket(1, options) },
	{ name: 'next packet', run: (sink: EncodedPacketSink, packet: EncodedPacket, options: PacketRetrievalOptions) =>
		sink.getNextPacket(packet, options) },
	{ name: 'key packet at a timestamp',
		run: (sink: EncodedPacketSink, _: EncodedPacket, options: PacketRetrievalOptions) =>
			sink.getKeyPacket(1, options) },
	{ name: 'next key packet', run: (sink: EncodedPacketSink, packet: EncodedPacket, options: PacketRetrievalOptions) =>
		sink.getNextKeyPacket(packet, options) },
];

describe('given packet retrieval from a non-cancellable WAV source', () => {
	describe.each(queries)('when retrieving the $name', ({ run }) => {
		it.each([false, true])('should cancel only its own wait with key verification %s', async (verifyKeyPackets) => {
			using file = await openInput();
			const first = (await file.sink.getFirstPacket({ metadataOnly: true }))!;
			const expected = (await run(file.sink, first, { metadataOnly: true }))!;
			const controller = new AbortController();
			file.hold();
			const canceled = observe(run(file.sink, first, { signal: controller.signal, verifyKeyPackets }));
			try {
				await expect.poll(() => file.heldReads).toBeGreaterThan(0);
				const shared = run(new EncodedPacketSink((await file.input.getPrimaryAudioTrack())!), first, {});
				const sharedResult = observe(shared);
				const reason = new Error('Seek retired');
				controller.abort(reason);
				await expect.poll(canceled).toEqual({ error: reason });
				expect(sharedResult()).toBeUndefined();
				file.release();
				const packet = (await shared)!;
				expect(packet.timestamp).toBe(expected.timestamp);
				expect(packet.data.byteLength).toBe(expected.byteLength);
				expect(packet.type).toBe('key');
				await setImmediate();
				expect(canceled()).toEqual({ error: reason });
				expect((await file.sink.getFirstPacket())?.timestamp).toBe(0);
			} finally {
				file.release();
			}
		});

		it('should reject invalid or already-aborted signals before source reads', async () => {
			using file = await openInput();
			const first = (await file.sink.getFirstPacket({ metadataOnly: true }))!;
			const before = file.reads;
			for (const signal of [null, {}, true]) {
				// @ts-expect-error Deliberately invalid public option.
				await expect(run(file.sink, first, { signal })).rejects.toThrow(TypeError);
			}
			const controller = new AbortController();
			controller.abort();
			await expect(run(file.sink, first, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
			expect(file.reads).toBe(before);
			expect(await run(file.sink, first, { signal: new AbortController().signal })).not.toBeNull();
			expect(file.reads).toBeGreaterThan(before);
		});
	});

	describe('when the source fails after cancellation', () => {
		it('should preserve the abort reason while other consumers receive the source error', async () => {
			using file = await openInput();
			file.hold();
			const controller = new AbortController();
			const canceled = observe(file.sink.getFirstPacket({ signal: controller.signal }));
			await expect.poll(() => file.heldReads).toBeGreaterThan(0);
			const shared = observe(file.sink.getFirstPacket());
			const reason = new Error('No longer needed');
			controller.abort(reason);
			await expect.poll(canceled).toEqual({ error: reason });
			const sourceError = new Error('Source failed');
			file.fail(sourceError);
			await expect.poll(shared).toEqual({ error: sourceError });
			expect(canceled()).toEqual({ error: reason });
		});
	});

	describe('when iterating packets', () => {
		it('should reject a pending next on abort without waiting for source completion', async () => {
			using file = await openInput();
			file.hold();
			const controller = new AbortController();
			const iterator = file.sink.packets(undefined, undefined, { signal: controller.signal });
			const pending = observe(iterator.next());
			try {
				await expect.poll(() => file.heldReads).toBeGreaterThan(0);
				const reason = new Error('Consumer stopped');
				controller.abort(reason);
				await expect.poll(pending).toEqual({ error: reason });
				await expect(iterator.return()).resolves.toEqual({ value: undefined, done: true });
				file.release();
				await setImmediate();
				expect(pending()).toEqual({ error: reason });
			} finally {
				file.release();
				await iterator.return();
			}
		});

		it('should not deliver preloaded packets after abort', async () => {
			using file = await openInput();
			const controller = new AbortController();
			const iterator = file.sink.packets(undefined, undefined, { metadataOnly: true, signal: controller.signal });
			try {
				expect((await iterator.next()).value?.timestamp).toBe(0);
				await setImmediate();
				const reason = new Error('Stop preloading');
				controller.abort(reason);
				await expect(iterator.next()).rejects.toBe(reason);
			} finally {
				await iterator.return();
			}
		});

		it('should finish return and a pending next while source I/O is still blocked', async () => {
			using file = await openInput();
			file.hold();
			const controller = new AbortController();
			const iterator = file.sink.packets(undefined, undefined, { signal: controller.signal });
			const pending = observe(iterator.next());
			try {
				await expect.poll(() => file.heldReads).toBeGreaterThan(0);
				const shared = file.sink.getFirstPacket({ signal: controller.signal });
				const sharedResult = observe(shared);
				const returned = iterator.return();
				expect(returned).toBeInstanceOf(Promise);
				await expect.poll(observe(returned)).toEqual({ value: { value: undefined, done: true } });
				await expect.poll(pending).toEqual({ value: { value: undefined, done: true } });
				expect(sharedResult()).toBeUndefined();
				file.release();
				expect((await shared)?.timestamp).toBe(0);
				await setImmediate();
				await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
				expect((await file.sink.getFirstPacket())?.timestamp).toBe(0);
			} finally {
				file.release();
				await iterator.return();
			}
		});

		it('should validate the signal before starting iteration', async () => {
			using file = await openInput();
			const before = file.reads;
			// @ts-expect-error Deliberately invalid public option.
			expect(() => file.sink.packets(undefined, undefined, { signal: {} })).toThrow(TypeError);
			const controller = new AbortController();
			const reason = new Error('Already stopped');
			controller.abort(reason);
			expect(() => file.sink.packets(undefined, undefined, { signal: controller.signal })).toThrow(reason);
			expect(file.reads).toBe(before);
		});
	});
});
