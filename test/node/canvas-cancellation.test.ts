import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BufferSource, CanvasSink, Input, MXF, VideoSample, VideoSampleSink } from '../../src/index.js';
import { makeMxf } from './mxf-fixture.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';

describe('given a naturally exhausted canvas iterator', () => {
	it.each(['canvases', 'canvasesAtTimestamps'] as const)(
		'should keep %s done after input disposal', async (method) => {
			registerHtj2kDecoder();
			const data = readFileSync(new URL('../fixtures/htj2k/rgb8.j2c', import.meta.url));
			using input = new Input({ formats: [MXF], source: new BufferSource(makeMxf({
				htj2k: { data, bits: 8 }, videoOnly: true,
			}).data) });
			const sink = new CanvasSink((await input.getPrimaryVideoTrack())!);
			const iterator = method === 'canvases' ? sink.canvases(0, 0) : sink.canvasesAtTimestamps([]);
			expect(await iterator.next()).toEqual({ done: true, value: undefined });
			input.dispose();
			expect(await iterator.next()).toEqual({ done: true, value: undefined });
			expect(await iterator.next()).toEqual({ done: true, value: undefined });
		});
});

describe('given a canvas iterator with an in-flight sample', () => {
	it.each(['canvases', 'canvasesAtTimestamps'] as const)(
		'should forward %s return immediately and close a sample arriving after cancellation', async (method) => {
			const data = readFileSync(new URL('../fixtures/htj2k/rgb8.j2c', import.meta.url));
			using input = new Input({ formats: [MXF], source: new BufferSource(makeMxf({
				htj2k: { data, bits: 8 }, videoOnly: true,
			}).data) });
			const track = (await input.getPrimaryVideoTrack())!;
			const sample = new VideoSample(new Uint8Array(128), {
				format: 'RGBA', codedWidth: 8, codedHeight: 4, timestamp: 0,
			});
			const close = vi.spyOn(sample, 'close');
			let release!: (result: IteratorResult<VideoSample, void>) => void;
			let started!: () => void;
			const gate = new Promise<IteratorResult<VideoSample, void>>((resolve) => {
				release = resolve;
			});
			const waiting = new Promise<void>((resolve) => {
				started = resolve;
			});
			let returns = 0;
			const inner: AsyncGenerator<VideoSample, void, unknown> = {
				next() {
					started();
					return gate;
				},
				async return() {
					returns++;
					return { done: true, value: undefined };
				},
				async throw(error) { throw error; },
				[Symbol.asyncIterator]() { return this; },
			};
			const sourceMethod = method === 'canvases' ? 'samples' : 'samplesAtTimestamps';
			const spy = vi.spyOn(VideoSampleSink.prototype, sourceMethod).mockImplementation(() => inner);
			try {
				const sink = new CanvasSink(track, { poolSize: 2 });
				const iterator = method === 'canvases' ? sink.canvases() : sink.canvasesAtTimestamps([0]);
				const pending = iterator.next();
				void pending.catch(() => {});
				await waiting;
				const returned = iterator.return();
				void returned.catch(() => {});
				await vi.waitFor(() => expect(returns).toBe(1));
				expect((await returned).done).toBe(true);
				release({ done: false, value: sample });
				expect((await pending).done).toBe(true);
				expect(close).toHaveBeenCalledTimes(1);
				expect((await iterator.next()).done).toBe(true);
			} finally {
				release({ done: false, value: sample });
				spy.mockRestore();
				sample.close();
			}
		});
});
