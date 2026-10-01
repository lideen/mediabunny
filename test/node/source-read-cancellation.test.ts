import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { CustomPathedSource, CustomSource, Input, MP4, type Source } from '../../src/index.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';

const content = readFileSync(new URL('../public/video.mp4', import.meta.url));

// Per-operation signals are an internal source contract consumed by demuxers, not a public Input option.
const read = async (source: Source, start: number, end: number, signal?: AbortSignal) => {
	const result = await source._read(start, end, start, end, false, signal);
	assert(result);
	return Buffer.from(result.bytes.subarray(start - result.offset, end - result.offset));
};

describe('given operations sharing a source', () => {
	describe('when an operation extending a live read is canceled', () => {
		it.each(['direct', 'slice', 'pathed'] as const)(
			'should remove only its demand through a %s source', async (wrapper) => {
				const entered = promiseWithResolvers();
				const gate = promiseWithResolvers();
				const calls: [number, number][] = [];
				const offset = wrapper === 'slice' ? 1000 : 0;
				const backing = Buffer.concat([Buffer.alloc(offset), content]);
				const source = new CustomSource({
					getSize: () => backing.length,
					maxCacheSize: 0,
					read: async (start, end) => {
						calls.push([start, end]);
						if (calls.length === 1) {
							entered.resolve();
							await gate.promise;
						}
						return backing.subarray(start, end);
					},
				});
				const wrapped = wrapper === 'slice'
					? source.slice(offset, content.length)
					: wrapper === 'pathed' ? new CustomPathedSource('/root.mp4', async () => source) : source;
				using input = new Input({ source: wrapped, formats: [MP4] });
				const live = read(wrapped, 100, 200);
				await entered.promise;
				const controller = new AbortController();
				const reason = new Error('Operation canceled');
				const pending = expect(read(wrapped, 200, 400, controller.signal)).rejects.toBe(reason);
				controller.abort(reason);
				gate.resolve();
				await pending;
				expect(await live).toEqual(content.subarray(100, 200));
				await setImmediate();
				expect(calls).toEqual([[offset + 100, offset + 200]]);
				expect(await input.getFormat()).toBe(MP4);
			},
		);
	});

	describe('when a queued range loses its overlapping demand', () => {
		it('should shrink and split the queued reads and finish surviving operations', async () => {
			const entered = promiseWithResolvers();
			const gate = promiseWithResolvers();
			const calls: [number, number][] = [];
			const source = new CustomSource({
				getSize: () => content.length,
				maxCacheSize: 0,
				read: async (start, end) => {
					calls.push([start, end]);
					if (calls.length <= 2) {
						if (calls.length === 2) {
							entered.resolve();
						}
						await gate.promise;
					}
					return content.subarray(start, end);
				},
			});
			using input = new Input({ source, formats: [MP4] });
			const active = [read(source, 0, 100), read(source, 500000, 500100)];
			await entered.promise;
			const controller = new AbortController();
			const reason = new Error('Queued operation canceled');
			const canceled = expect(read(source, 1000000, 1500000, controller.signal)).rejects.toBe(reason);
			const left = read(source, 1000100, 1000200);
			const right = read(source, 1400000, 1400100);
			controller.abort(reason);
			await canceled;
			gate.resolve();
			await Promise.all(active);
			expect(await left).toEqual(content.subarray(1000100, 1000200));
			expect(await right).toEqual(content.subarray(1400000, 1400100));
			expect(calls.slice(2)).toEqual([[1000100, 1000200], [1400000, 1400100]]);
			expect(await input.getFormat()).toBe(MP4);
		});
	});

	describe('when canceling stream consumption', () => {
		it.each(['callback', 'pull', 'shared'] as const)(
			'should stop only unneeded pulls after a held %s', async (mode) => {
				const entered = promiseWithResolvers();
				const gate = promiseWithResolvers();
				const finished = promiseWithResolvers();
				let pulls = 0;
				let cancels = 0;
				let holding = true;
				const source = new CustomSource({
					getSize: () => content.length,
					maxCacheSize: 0,
					read: async (start, end) => {
						if (!holding) {
							return content.subarray(start, end);
						}
						if (mode === 'callback') {
							entered.resolve();
							await gate.promise;
						}
						let position = start;
						return new ReadableStream<Uint8Array>({
							async pull(controller) {
								pulls++;
								if (pulls === 1 && mode !== 'callback') {
									entered.resolve();
									await gate.promise;
								}
								const next = Math.min(position + 100, end);
								controller.enqueue(content.subarray(position, next));
								position = next;
								if (position === end) {
									controller.close();
									finished.resolve();
								}
							},
							cancel() {
								cancels++;
								finished.resolve();
							},
						}, { highWaterMark: 0 });
					},
				});
				using input = new Input({ source, formats: [MP4] });
				const controller = new AbortController();
				const reason = new Error('Stream operation canceled');
				const canceled = expect(read(source, 1000, 2000, controller.signal)).rejects.toBe(reason);
				await entered.promise;
				const live = mode === 'shared' ? read(source, 1000, 2000) : null;
				controller.abort(reason);
				await canceled;
				gate.resolve();
				await finished.promise;
				if (live) {
					expect(await live).toEqual(content.subarray(1000, 2000));
				}
				expect(pulls).toBe(mode === 'callback' ? 0 : mode === 'pull' ? 1 : 10);
				expect(cancels).toBe(mode === 'shared' ? 0 : 1);
				holding = false;
				expect(await input.getFormat()).toBe(MP4);
			},
		);
	});

	describe('when cancellation precedes source resolution', () => {
		it('should reject an already aborted operation without invoking the source', async () => {
			let calls = 0;
			const source = new CustomSource({
				getSize: () => content.length,
				read: (start, end) => {
					calls++;
					return content.subarray(start, end);
				},
			});
			using ref = source.ref();
			const reason = new Error('Already canceled');
			await expect(read(ref.source, 0, 100, AbortSignal.abort(reason))).rejects.toBe(reason);
			expect(calls).toBe(0);
		});

		it.each(['size', 'path'] as const)('should reject promptly while waiting for %s', async (mode) => {
			const gate = promiseWithResolvers();
			let calls = 0;
			const source = new CustomSource({
				getSize: async () => {
					if (mode === 'size') {
						await gate.promise;
					}
					return content.length;
				},
				read: (start, end) => {
					calls++;
					return content.subarray(start, end);
				},
			});
			const wrapped = mode === 'path'
				? new CustomPathedSource('/root.mp4', async () => {
					await gate.promise;
					return source;
				})
				: source;
			using input = new Input({ source: wrapped, formats: [MP4] });
			const controller = new AbortController();
			const reason = new Error('Resolution canceled');
			const pending = expect(read(wrapped, 0, 100, controller.signal)).rejects.toBe(reason);
			controller.abort(reason);
			await pending;
			gate.resolve();
			await setImmediate();
			expect(calls).toBe(0);
			expect(await input.getFormat()).toBe(MP4);
		});
	});
});
