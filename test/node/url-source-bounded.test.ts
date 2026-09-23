import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { UrlSource, type UrlSourceOptions } from '../../src/source.js';
import { Reader, readBytes } from '../../src/reader.js';
import { assert } from '../../src/misc.js';

const content = Buffer.alloc(2 ** 20);
for (let i = 0; i < content.length; i++) content[i] = i % 251;
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
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
		if (respond?.(res, start, end, ranges.length)) return;
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
		if (!ref.freed) ref.free();
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
		it('should transfer only three forward floors and reuse cached bytes', async () => {
			const server = await setup();
			await server.read(100);
			await server.read(400000);
			await server.read(900000);
			await server.read(100);
			expect(server.ranges).toEqual(['bytes=100-32867', 'bytes=400000-432767', 'bytes=900000-932767']);
			expect(server.writtenBytes()).toBe(98304);
			expect(server.events.reduce((sum, event) => sum + event.end - event.start, 0)).toBe(98304);
			expect(await server.source.getSize()).toBe(content.length);
		});

		it('should not bridge even small positive gaps', async () => {
			const server = await setup();
			await server.read(0);
			await server.read(33000);
			expect(server.ranges).toEqual(['bytes=0-32767', 'bytes=33000-65767']);
		});

		it('should read a large contiguous packet in one range and clamp the tail', async () => {
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
	});

	describe('when the worker target grows during a response', () => {
		it('should fetch the remainder without treating the response end as file EOF', async () => {
			let release!: () => void;
			let received!: () => void;
			const firstRequest = new Promise<void>((resolve) => {
				received = resolve;
			});
			const server = await setup(undefined, (res, start, end, index) => {
				if (index !== 1) return false;
				res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}` });
				release = () => res.end(content.subarray(start, end + 1));
				received();
				return true;
			});
			const first = server.read(0);
			await firstRequest;
			const adjacent = server.read(32768);
			const overlapping = server.read(32760, 16);
			release();
			await Promise.all([first, adjacent, overlapping]);
			expect(server.ranges).toEqual(['bytes=0-32767', 'bytes=32768-65535']);
			expect(await server.source.getSize()).toBe(content.length);
		});

		it('should continue after a server returns a smaller valid range', async () => {
			const server = await setup(undefined, (res, start, _end, index) => {
				if (index !== 1) return false;
				res.writeHead(206, { 'Content-Range': `bytes ${start}-${start + 99}/${content.length}` });
				res.end(content.subarray(start, start + 100));
				return true;
			});
			await server.read(0, 32768);
			expect(server.ranges).toEqual(['bytes=0-32767', 'bytes=100-32767']);
			expect(await server.source.getSize()).toBe(content.length);
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
	});

	describe('when the body does not match a valid Content-Range', () => {
		it('should reject a read requiring missing bytes after a clean short response', async () => {
			const server = await setup(undefined, (res, start, end) => {
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end}/${content.length}`,
					'Transfer-Encoding': 'chunked',
				});
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
					if (index !== 1) return false;
					res.writeHead(206, {
						'Content-Range': `bytes ${start}-${end}/${content.length}`,
						'Transfer-Encoding': 'chunked',
					});
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
			const reader = new Reader(ref.source);
			const slice = await reader.requestSlice(0, 100);
			expect(Buffer.from(readBytes(slice!, 100))).toEqual(content.subarray(1000, 1100));
			expect(server.ranges).toEqual(['bytes=1000-33767']);
			expect(await view.getSize()).toBe(100);
		});
	});

	describe('when a request fails or is disposed', () => {
		it('should retry the same bounded range after a connection failure', async () => {
			const server = await setup({ rangePolicy: { minimumRequestSize: 32768 }, getRetryDelay: () => 0 },
				(res, _start, _end, index) => {
					if (index !== 1) return false;
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
					if (index !== 1) return false;
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
			let received!: () => void;
			let closed!: () => void;
			const request = new Promise<void>((resolve) => {
				received = resolve;
			});
			const connectionClosed = new Promise<void>((resolve) => {
				closed = resolve;
			});
			const server = await setup(undefined, (res) => {
				res.on('close', closed);
				received();
				return true;
			});
			const pending = expect(server.reader.requestSlice(0, 1)).rejects.toThrow(/disposed/i);
			await request;
			server.ref.free();
			await pending;
			await connectionClosed;
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
	});
});

describe('given no bounded policy', () => {
	it('should preserve open-ended requests and backward prefetch', async () => {
		const server = await setup({});
		await server.read(100);
		expect(server.ranges).toEqual(['bytes=0-']);
	});
});

describe('given invalid minimum request sizes', () => {
	it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
		'should reject %s at construction', (minimumRequestSize) => {
			expect(() => new UrlSource('https://example.com', { rangePolicy: { minimumRequestSize } }))
				.toThrow(/positive safe integer/);
		},
	);
});
