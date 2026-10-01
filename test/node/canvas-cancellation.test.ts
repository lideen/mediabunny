import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import {
	BufferSource,
	BufferTarget,
	CanvasSink,
	CustomVideoDecoder,
	EncodedPacket,
	EncodedVideoPacketSource,
	Input,
	MATROSKA,
	MkvOutputFormat,
	Output,
	registerDecoder,
	VideoCodec,
	VideoSample,
} from '../../src/index.js';

const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

const createInput = async () => {
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1), {
		decoderConfig: { codec: 'vp8', codedWidth: 8, codedHeight: 4 },
	});
	await output.finalize();
	return new Input({ formats: [MATROSKA], source: new BufferSource(output.target.buffer!) });
};

const createDecoder = (afterSample = () => {}) => {
	const started = gate();
	const release = gate();
	const closed = gate();
	const sample = new VideoSample(new Uint8Array(128), {
		format: 'RGBA', codedWidth: 8, codedHeight: 4, timestamp: 0, duration: 1,
	});
	let active = true;
	class Decoder extends CustomVideoDecoder {
		static override supports(codec: VideoCodec) { return active && codec === 'vp8'; }
		init() {}
		async decode() {
			started.resolve();
			await release.promise;
			this.onSample(sample);
			afterSample();
		}

		flush() {}
		close() { closed.resolve(); }
	}
	registerDecoder(Decoder);
	return {
		started, release, closed, sample,
		dispose() {
			active = false;
			sample.close();
		},
	};
};

describe.each(['canvases', 'canvasesAtTimestamps'] as const)('given a %s iterator', (method) => {
	const iterate = (sink: CanvasSink) => method === 'canvases'
		? sink.canvases()
		: sink.canvasesAtTimestamps([0]);

	describe('when returned or thrown into while decoding is pending', () => {
		it.each(['return', 'throw'] as const)('should finish pending reads on %s before decode', async (stop) => {
			const decoder = createDecoder();
			using input = await createInput();
			const iterator = iterate(new CanvasSink((await input.getPrimaryVideoTrack())!));
			const pending = iterator.next();
			const queued = iterator.next();
			const error = new Error('Stop canvas iteration');
			try {
				await decoder.started.promise;
				const stopped = stop === 'return'
					? iterator.return().then(result => expect(result.done).toBe(true))
					: expect(iterator.throw(error)).rejects.toBe(error);
				expect(await Promise.race([
					Promise.all([stopped, pending, queued]).then(() => 'stopped'),
					setImmediate('still decoding'),
				])).toBe('stopped');
				expect(await pending).toEqual({ done: true, value: undefined });
				expect(await queued).toEqual({ done: true, value: undefined });
				decoder.release.resolve();
				await decoder.closed.promise;
				expect(() => decoder.sample.allocationSize()).toThrow('VideoSample is closed');
				expect(await iterator.next()).toEqual({ done: true, value: undefined });
			} finally {
				decoder.release.resolve();
				await Promise.allSettled([pending, queued, iterator.return()]);
				await decoder.closed.promise;
				decoder.dispose();
			}
		});
	});

	describe('when returned during sample handoff', () => {
		it('should close the handed-off sample instead of rendering it', async () => {
			let returned!: Promise<IteratorResult<unknown>>;
			const decoder = createDecoder(() => {
				queueMicrotask(() => {
					returned = iterator.return();
				});
			});
			using input = await createInput();
			const iterator = iterate(new CanvasSink((await input.getPrimaryVideoTrack())!));
			try {
				const pending = iterator.next();
				await decoder.started.promise;
				decoder.release.resolve();
				expect(await pending).toEqual({ done: true, value: undefined });
				expect(await returned).toEqual({ done: true, value: undefined });
				expect(() => decoder.sample.allocationSize()).toThrow('VideoSample is closed');
			} finally {
				decoder.release.resolve();
				await iterator.return();
				await decoder.closed.promise;
				decoder.dispose();
			}
		});
	});

	describe('when naturally exhausted and then disposed', () => {
		it('should stay done', async () => {
			const decoder = createDecoder();
			decoder.release.resolve();
			using input = await createInput();
			const sink = new CanvasSink((await input.getPrimaryVideoTrack())!);
			const iterator = method === 'canvases' ? sink.canvases(0, 0) : sink.canvasesAtTimestamps([]);
			try {
				expect(await iterator.next()).toEqual({ done: true, value: undefined });
				input.dispose();
				expect(await iterator.next()).toEqual({ done: true, value: undefined });
				expect(await iterator.next()).toEqual({ done: true, value: undefined });
			} finally {
				await iterator.return();
				await decoder.closed.promise;
				decoder.dispose();
			}
		});
	});

	describe('when canvas allocation fails', () => {
		it('should release the sample, propagate the error, and finish queued reads', async () => {
			const error = new Error('Canvas allocation failed');
			vi.stubGlobal('OffscreenCanvas', class {
				constructor() { throw error; }
			});
			const decoder = createDecoder();
			using input = await createInput();
			const iterator = iterate(new CanvasSink((await input.getPrimaryVideoTrack())!));
			try {
				const pending = iterator.next();
				const queued = iterator.next();
				await decoder.started.promise;
				decoder.release.resolve();
				await expect(pending).rejects.toBe(error);
				expect(() => decoder.sample.allocationSize()).toThrow('VideoSample is closed');
				expect(await queued).toEqual({ done: true, value: undefined });
			} finally {
				decoder.release.resolve();
				await iterator.return();
				await decoder.closed.promise;
				decoder.dispose();
				vi.unstubAllGlobals();
			}
		});
	});
});

describe('given timestamp requests before the first frame', () => {
	describe('when reading concurrently', () => {
		it('should yield one null per timestamp and then finish', async () => {
			const decoder = createDecoder();
			using input = await createInput();
			const sink = new CanvasSink((await input.getPrimaryVideoTrack())!);
			const iterator = sink.canvasesAtTimestamps([-2, -1]);
			try {
				expect(await Promise.all([iterator.next(), iterator.next(), iterator.next()])).toEqual([
					{ done: false, value: null },
					{ done: false, value: null },
					{ done: true, value: undefined },
				]);
			} finally {
				await iterator.return();
				await decoder.closed.promise;
				decoder.dispose();
			}
		});
	});
});
