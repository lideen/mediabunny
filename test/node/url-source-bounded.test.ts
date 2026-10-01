import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { UrlSource, type UrlSourceOptions } from '../../src/source.js';
import { Reader, readBytes } from '../../src/reader.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';

const content = Buffer.alloc(2 ** 20);
for (let i = 0; i < content.length; i++) {
	content[i] = i % 251;
}
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) {
		close();
	}
});

const setup = async (
	options: UrlSourceOptions = { rangePolicy: { minimumRequestSize: 32768 } },
	respond?: (response: http.ServerResponse, start: number, end: number, index: number) => boolean,
) => {
	const ranges: string[] = [];
	let writtenBytes = 0;
	const server = http.createServer((req, res) => {
		const range = req.headers.range!;
		ranges.push(range);
		const match = /^bytes=(\d+)-(\d*)$/.exec(range)!;
		const start = Number(match[1]);
		const end = Math.min(match[2] ? Number(match[2]) : content.length - 1, content.length - 1);
		if (respond?.(res, start, end, ranges.length)) {
			return;
		}
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${end}/${content.length}`,
			'Content-Length': end - start + 1,
		});
		const bytes = content.subarray(start, end + 1);
		writtenBytes += bytes.length;
		res.end(bytes);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	cleanup.push(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert(address && typeof address !== 'string');
	const source = new UrlSource(`http://127.0.0.1:${address.port}/data.m3u8`, options);
	const ref = source.ref();
	cleanup.push(() => {
		if (!ref.freed) {
			ref.free();
		}
	});
	const reader = new Reader(source);
	const events: { start: number; end: number }[] = [];
	source.on('read', event => events.push(event));
	const read = async (start: number, length = 1, offset = 0) => {
		const slice = await reader.requestSlice(start, length);
		expect(slice).not.toBeNull();
		expect(Buffer.from(readBytes(slice!, length)))
			.toEqual(content.subarray(offset + start, offset + start + length));
	};
	return { source, ref, reader, read, ranges, events, writtenBytes: () => writtenBytes };
};

describe('given a bounded HTTP range policy', () => {
	describe('when reading sparse regions', () => {
		it('should transfer only forward floors and reuse cached bytes without bridging gaps', async () => {
			const server = await setup();
			for (const start of [100, 33000, 400000, 900000, 100]) {
				await server.read(start);
			}
			expect(server.ranges).toEqual([
				'bytes=100-32867', 'bytes=33000-65767', 'bytes=400000-432767', 'bytes=900000-932767',
			]);
			expect(server.writtenBytes()).toBe(131072);
			expect(server.events.reduce((sum, event) => sum + event.end - event.start, 0)).toBe(131072);
			expect(await server.source.getSize()).toBe(content.length);
		});

		it('should read a large contiguous packet in one uncapped range and clamp the tail', async () => {
			const server = await setup();
			await server.read(100, 200000);
			await server.read(content.length - 10, 10);
			expect(server.ranges).toEqual(['bytes=100-200099', 'bytes=1048566-1048575']);
			expect(server.writtenBytes()).toBe(200010);
		});

		it('should learn the total from a first request whose floor extends past EOF', async () => {
			const server = await setup();
			await server.read(content.length - 10, 10);
			expect(server.ranges).toEqual(['bytes=1048566-1081333']);
			expect(server.writtenBytes()).toBe(10);
			expect(await server.source.getSize()).toBe(content.length);
		});

		it('should split large reads at the maximum request size and cap the prefetch floor', async () => {
			const server = await setup({ rangePolicy: { minimumRequestSize: 32768, maximumRequestSize: 1000 } });
			await server.read(100, 2500);
			await server.read(5000);
			expect(server.ranges).toEqual([
				'bytes=100-1099', 'bytes=1100-2099', 'bytes=2100-2599', 'bytes=5000-5999',
			]);
			expect(server.writtenBytes()).toBe(3500);
		});
	});

	describe('when the worker target grows during a response', () => {
		it('should fetch the remainder without treating the response end as file EOF', async () => {
			const received = promiseWithResolvers();
			let release!: () => void;
			const server = await setup(undefined, (res, start, end, index) => {
				if (index !== 1) {
					return false;
				}
				res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}` });
				release = () => res.end(content.subarray(start, end + 1));
				received.resolve();
				return true;
			});
			const first = server.read(0);
			await received.promise;
			const adjacent = server.read(32768);
			const overlapping = server.read(32760, 16);
			release();
			await Promise.all([first, adjacent, overlapping]);
			expect(server.ranges).toEqual(['bytes=0-32767', 'bytes=32768-65535']);
			expect(await server.source.getSize()).toBe(content.length);
		});

		it('should continue after a server returns a smaller valid range', async () => {
			const server = await setup(undefined, (res, start, _end, index) => {
				if (index !== 1) {
					return false;
				}
				res.writeHead(206, { 'Content-Range': `bytes ${start}-${start + 99}/${content.length}` });
				res.end(content.subarray(start, start + 100));
				return true;
			});
			await server.read(0, 32768);
			expect(server.ranges).toEqual(['bytes=0-32767', 'bytes=100-32767']);
		});
	});

	describe('when responses have invalid range metadata', () => {
		it.each([undefined, 'bytes 0-32767/*', 'bytes 1-32767/1048576', 'bytes 0-32768/1048576',
			'bytes 0-32767/10', 'bytes 0-32767/9007199254740992'])(
			'should reject missing or invalid Content-Range: %s', async (header) => {
				const server = await setup(undefined, (res) => {
					res.writeHead(206, header ? { 'Content-Range': header } : {});
					res.end(content.subarray(0, 32768));
					return true;
				});
				await expect(server.reader.requestSlice(0, 1)).rejects.toThrow(/Content-Range/);
				expect(server.events).toEqual([]);
			},
		);

		it('should reject encoded range bodies before accepting bytes', async () => {
			const server = await setup(undefined, (res, start, end) => {
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end}/${content.length}`,
					'Content-Encoding': 'identity',
				});
				res.end(content.subarray(start, end + 1));
				return true;
			});
			await expect(server.reader.requestSlice(0, 1)).rejects.toThrow(/unencoded/);
			expect(server.events).toEqual([]);
		});

		it('should reject a changed resource total on a later range', async () => {
			const server = await setup(undefined, (res, start, end, index) => {
				if (index === 1) {
					return false;
				}
				res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length + 1}` });
				res.end(content.subarray(start, end + 1));
				return true;
			});
			await server.read(0);
			await expect(server.reader.requestSlice(400000, 1)).rejects.toThrow(/Content-Range/);
			expect(server.events).toEqual([{ start: 0, end: 32768 }]);
		});
	});

	describe('when the body does not match a valid Content-Range', () => {
		it('should reject a read requiring missing bytes after a clean short response', async () => {
			const server = await setup(undefined, (res, start, end) => {
				res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}` });
				res.end(content.subarray(start, start + 100));
				return true;
			});
			await expect(server.reader.requestSlice(0, 32768))
				.rejects.toThrow('Bounded range response ended before its Content-Range was delivered.');
			expect(server.events).toEqual([{ start: 0, end: 100 }]);
			expect(server.ranges).toEqual(['bytes=0-32767']);
		});

		it('should reject an oversized chunk before emitting or caching its bytes', async () => {
			const server = await setup({ rangePolicy: { minimumRequestSize: 100 } },
				(res, start, end, index) => {
					if (index !== 1) {
						return false;
					}
					res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}` });
					res.end(content.subarray(start, end + 2));
					return true;
				});
			await expect(server.reader.requestSlice(0, 1))
				.rejects.toThrow('Bounded range response exceeded its Content-Range.');
			expect(server.events).toEqual([]);
			await server.read(0);
			expect(server.ranges).toEqual(['bytes=0-99', 'bytes=0-99']);
			expect(server.events).toEqual([{ start: 0, end: 100 }]);
		});
	});

	describe('when using an offset view', () => {
		it('should retain user Range offsets and clamp prefetch to the view', async () => {
			const server = await setup({
				rangePolicy: { minimumRequestSize: 32768 },
				requestInit: { headers: { Range: 'bytes=1000-1099' } },
			});
			await server.read(0, 100, 1000);
			expect(server.ranges).toEqual(['bytes=1000-1099']);
			expect(await server.source.getSize()).toBe(100);
		});

		it('should preserve sliced source offsets and size with forward prefetch', async () => {
			const server = await setup();
			const view = server.source.slice(1000, 100);
			using ref = view.ref();
			const slice = await new Reader(ref.source).requestSlice(0, 100);
			expect(Buffer.from(readBytes(slice!, 100))).toEqual(content.subarray(1000, 1100));
			expect(server.ranges).toEqual(['bytes=1000-33767']);
			expect(await view.getSize()).toBe(100);
		});
	});

	describe('when a request fails or is disposed', () => {
		it('should retire out-of-range demand when a canceled read learns the file size', async () => {
			const received = promiseWithResolvers();
			const errors: unknown[] = [];
			let release!: () => void;
			const server = await setup({
				rangePolicy: { minimumRequestSize: 100, maximumRequestSize: 100 },
				handleUnhandledError: error => errors.push(error),
			}, (res) => {
				release = () => {
					res.writeHead(206, { 'Content-Range': 'bytes 0-49/100', 'Content-Length': 50 });
					res.end(content.subarray(0, 50));
				};
				received.resolve();
				return true;
			});
			const controller = new AbortController();
			const reason = new Error('Read canceled');
			const canceled = expect(server.source._read(0, 1000, 0, 1000, true, controller.signal))
				.rejects.toBe(reason);
			await received.promise;
			const near = server.source._read(0, 50, 0, 50);
			const farController = new AbortController();
			const far = server.source._read(900, 1000, 900, 1000, false, farController.signal);
			controller.abort(reason);
			await canceled;
			release();
			expect((await near)?.bytes).toEqual(new Uint8Array(content.subarray(0, 50)));
			expect(await far).toBeNull();
			await setImmediate();
			farController.abort();
			await setImmediate();
			expect(await far).toBeNull();
			expect(await server.source.getSize()).toBe(100);
			expect(server.ranges).toEqual(['bytes=0-99']);
			expect(errors).toEqual([]);
		});

		it('should cancel only one operation and avoid fetching its remaining capped ranges', async () => {
			const received = promiseWithResolvers();
			let release!: () => void;
			const server = await setup({ rangePolicy: { minimumRequestSize: 100, maximumRequestSize: 100 } },
				(res, start, end, index) => {
					if (index !== 1) {
						return false;
					}
					res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}` });
					release = () => res.end(content.subarray(start, end + 1));
					received.resolve();
					return true;
				});
			const controller = new AbortController();
			const reason = new Error('Read canceled');
			const canceled = expect(server.source._read(0, 1000, 0, 1000, true, controller.signal))
				.rejects.toBe(reason);
			await received.promise;
			const live = server.read(0, 50);
			const distant = server.read(900, 100);
			controller.abort(reason);
			await canceled;
			release();
			await Promise.all([live, distant]);
			expect(server.ranges).toEqual(['bytes=0-99', 'bytes=900-999']);
		});

		it('should retry the same bounded range after a connection failure', async () => {
			const server = await setup({ rangePolicy: { minimumRequestSize: 32768 }, getRetryDelay: () => 0 },
				(res, _start, _end, index) => {
					if (index !== 1) {
						return false;
					}
					res.destroy();
					return true;
				});
			await server.read(0);
			expect(server.ranges).toEqual(['bytes=0-32767', 'bytes=0-32767']);
		});

		it('should resume a failed response at the last delivered byte', async () => {
			let interrupt!: () => void;
			const server = await setup({ rangePolicy: { minimumRequestSize: 32768 }, getRetryDelay: () => 0 },
				(res, start, end, index) => {
					if (index !== 1) {
						return false;
					}
					res.writeHead(206, {
						'Content-Range': `bytes ${start}-${end}/${content.length}`,
						'Content-Length': end - start + 1,
					});
					interrupt = () => res.destroy();
					res.write(content.subarray(start, start + 100));
					return true;
				});
			server.source.on('read', () => interrupt());
			await server.read(0, 32768);
			expect(server.ranges).toEqual(['bytes=0-32767', 'bytes=100-32767']);
		});

		it('should cancel the connection and reject the pending read on disposal', async () => {
			const received = promiseWithResolvers();
			const closed = promiseWithResolvers();
			const server = await setup(undefined, (res) => {
				res.on('close', () => closed.resolve());
				received.resolve();
				return true;
			});
			const pending = expect(server.reader.requestSlice(0, 1)).rejects.toThrow(/disposed/i);
			await received.promise;
			server.ref.free();
			await pending;
			await closed.promise;
			expect(server.ranges).toHaveLength(1);
		});
	});

	describe('when the server ignores Range', () => {
		it('should fall back to correct sequential reads', async () => {
			const server = await setup(undefined, (res) => {
				res.writeHead(200, { 'Content-Length': content.length });
				res.end(content);
				return true;
			});
			await server.read(100000, 100);
			await server.read(0);
			expect(await server.source.getSize()).toBe(content.length);
			expect(server.ranges).toHaveLength(1);
		});

		it('should reject fallback for a strict finite read and allow a later ordinary read', async () => {
			const server = await setup(undefined, (res) => {
				res.writeHead(200, { 'Content-Length': content.length });
				res.end(content);
				return true;
			});
			await expect(server.source._read(0, 100, 0, 100, true)).rejects.toThrow(/HTTP 206/);
			expect(server.events).toEqual([]);
			await server.read(0, 100);
			expect(() => server.source._read(0, 100, 0, 100, true)).toThrow(/HTTP 206/);
		});
	});
});

describe('given no bounded policy', () => {
	it('should preserve open-ended requests and backward prefetch', async () => {
		const server = await setup({});
		await server.read(100);
		expect(server.ranges).toEqual(['bytes=0-']);
		expect(() => server.source._read(0, 1, 0, 1, true)).toThrow(/rangePolicy/);
	});
});

describe('given invalid request sizes', () => {
	it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
		'should reject %s at construction', (size) => {
			expect(() => new UrlSource('https://example.com', { rangePolicy: { minimumRequestSize: size } }))
				.toThrow(/minimumRequestSize must be a positive safe integer/);
			expect(() => new UrlSource('https://example.com', {
				rangePolicy: { minimumRequestSize: 1, maximumRequestSize: size },
			})).toThrow(/maximumRequestSize must be a positive safe integer/);
		},
	);
});
