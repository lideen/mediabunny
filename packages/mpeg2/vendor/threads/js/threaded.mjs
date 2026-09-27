import { MAX_INPUT_BYTES, MAX_FRAME_BYTES } from './index.mjs';

class OwnedFrame {
  constructor(frame) { Object.assign(this, frame); }
  takeY() { const plane = this.y; this.y = new Uint8Array(); return plane; }
  takeCb() { const plane = this.cb; this.cb = new Uint8Array(); return plane; }
  takeCr() { const plane = this.cr; this.cr = new Uint8Array(); return plane; }
  free() { this.y = this.cb = this.cr = new Uint8Array(); }
}

/**
 * Async packet API with one owned coordinator and, for 2/4 threads, a private pool.
 * threadCount=1 uses ordinary nonshared WASM and requires no isolation headers.
 * Supply threadedRuntimeUrl for the separately built threaded-runtime.mjs.
 * Await close(); it invalidates pending work, joins decoding, then terminates workers.
 */
export async function createThreadedPacketDecoder({ threadCount = 1, threadedRuntimeUrl,
  scalarRuntimeUrl = new URL('./index.mjs', import.meta.url),
  workerUrl = new URL('./threaded-worker.mjs', import.meta.url),
  maxPacketBytes = MAX_INPUT_BYTES, maxFrameBytes = MAX_FRAME_BYTES, signal } = {}) {
  signal?.throwIfAborted();
  if (![1, 2, 4].includes(threadCount)) throw new RangeError('threadCount must be 1, 2 or 4');
  for (const [name, value, max] of [['packet', maxPacketBytes, MAX_INPUT_BYTES], ['frame', maxFrameBytes, MAX_FRAME_BYTES]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`ResourceLimit: ${name} budget must be an integer in 1..=${max} bytes`);
  }
  if (threadCount > 1 && (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')) {
    throw new Error('threadCount > 1 requires cross-origin isolation and SharedArrayBuffer');
  }
  if (threadCount > 1 && !threadedRuntimeUrl) throw new Error('threadedRuntimeUrl is required for threadCount > 1');
  const runtimeUrl = new URL(threadCount > 1 ? threadedRuntimeUrl : scalarRuntimeUrl, import.meta.url).href;
  let coordinator;
  const children = new Map();
  const requests = new Map();
  const blobUrls = new Set();
  let nextId = 0, busy = false, closing = false, closePromise, terminalError, failed = false, disposed = false;
  let allocatedBytes = 0, peakBytes = 0, createdWorkers = 0;
  let startup;

  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', abort);
    for (const [worker, port] of children) {
      worker.onmessage = worker.onerror = null;
      worker.removeEventListener('messageerror', messageError);
      port.onmessage = port.onmessageerror = null;
      worker.terminate(); port.close();
    }
    children.clear();
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls.clear();
    if (coordinator) {
      coordinator.onmessage = coordinator.onerror = null;
      coordinator.removeEventListener('messageerror', messageError);
      coordinator.terminate();
    }
  }
  function fail(error) {
    if (failed || disposed) return;
    failed = true;
    terminalError = error;
    closing = true;
    dispose();
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error); }
    requests.clear();
  }
  function abort() { fail(signal.reason); }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  if (failed) throw terminalError;
  try { coordinator = new Worker(workerUrl, { type: 'module' }); }
  catch (error) { fail(error); throw error; }
  if (failed) { coordinator.terminate(); throw terminalError; }
  function messageError() { fail(new Error('packet worker message could not be deserialized')); }
  coordinator.onerror = event => fail(new Error(event.message));
  coordinator.addEventListener('messageerror', messageError);
  coordinator.onmessage = ({ data }) => {
    if (data.type === 'spawn') {
      if (disposed) {
        data.port.close();
        if (data.url.startsWith('blob:')) URL.revokeObjectURL(data.url);
        return;
      }
      if (data.url.startsWith('blob:')) blobUrls.add(data.url);
      if (closing || children.size >= threadCount || threadCount === 1) {
        data.port.close(); fail(new Error('pool worker limit exceeded')); return;
      }
      let worker;
      try { worker = new Worker(data.url, data.options); }
      catch (error) { data.port.close(); fail(error); return; }
      children.set(worker, data.port); createdWorkers++;
      data.port.onmessage = event => {
        if (disposed) return;
        try { worker.postMessage(event.data); } catch (error) { fail(error); }
      };
      worker.onmessage = event => {
        if (disposed) return;
        try { data.port.postMessage(event.data); } catch (error) { fail(error); }
      };
      data.port.onmessageerror = messageError;
      worker.addEventListener('messageerror', messageError);
      worker.onerror = event => fail(new Error(event.message));
      return;
    }
    if (data.type === 'fatal') { fail(new Error(data.message)); return; }
    const request = requests.get(data.id);
    if (!request) return;
    requests.delete(data.id); clearTimeout(request.timer);
    if (data.memoryBytes !== undefined) {
      allocatedBytes = data.memoryBytes; peakBytes = Math.max(peakBytes, allocatedBytes);
    }
    if (data.error) {
      const error = Object.assign(new Error(data.error.message), { name: data.error.name });
      request.reject(error);
      if (data.fatal) fail(error);
    } else request.resolve(data.value);
  };
  function send(operation, value = {}, transfer = []) {
    if (failed) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => fail(new Error('packet worker operation timed out')), 30000);
      requests.set(id, { resolve, reject, timer });
      try { coordinator.postMessage({ id, operation, ...value }, transfer); }
      catch (error) { fail(error); }
    });
  }
  try {
    startup = await send('init', { options: { runtimeUrl, threadCount, maxPacketBytes, maxFrameBytes } });
    if (failed) throw terminalError;
    if (children.size !== (threadCount > 1 ? threadCount : 0)) throw new Error('pool worker count differs from request');
  } catch (error) { fail(error); throw error; }

  const timed = output => output && ({ ...output, frame: new OwnedFrame(output.frame) });
  async function call(operation, input, timing) {
    if (failed) throw terminalError;
    if (closing) throw new Error('packet decoder is closed');
    if (busy) throw new Error('only one packet operation may be in flight');
    let copy;
    if (input !== undefined) {
      if (!(input instanceof Uint8Array)) throw new TypeError('input must be a Uint8Array');
      if (input.byteLength > maxPacketBytes) throw new RangeError('ResourceLimit: packet bytes');
      copy = input.slice();
    }
    busy = true;
    try {
      const value = await send(operation, { input: copy, timing }, copy ? [copy.buffer] : []);
      if (failed) throw terminalError;
      if (closing) throw new DOMException('packet decoder closed during operation', 'AbortError');
      return operation === 'decode' ? value.map(timed) : value?.frame ? timed(value) : value;
    } finally { busy = false; }
  }
  return {
    threadCount, maxPacketBytes, maxFrameBytes, maxReferenceBytes: maxFrameBytes * 3,
    get stats() { return { threadCount, poolWorkers: children.size, createdWorkers, allocatedBytes, peakBytes,
      moduleInitMs: startup.moduleInitMs, poolStartupMs: startup.poolStartupMs, decoderSetupMs: startup.decoderSetupMs,
      maxMemoryBytes: threadCount > 1 ? 268435456 : undefined }; },
    decode(input, timing) {
      if (!Number.isFinite(timing?.timestamp) || !Number.isFinite(timing?.duration) || timing.duration < 0) {
        return Promise.reject(new TypeError('timestamp must be finite and duration finite and nonnegative'));
      }
      return call('decode', input, timing);
    },
    discardLeadingB: input => call('discardLeadingB', input),
    finishSegment: () => call('finishSegment'),
    drain: () => call('drain'),
    reset: () => call('reset'),
    cancel(reason = new DOMException('packet decoder cancelled', 'AbortError')) { fail(reason); },
    close() {
      if (failed) return Promise.resolve();
      if (!closePromise) {
        closing = true;
        closePromise = send('close').finally(dispose);
      }
      return closePromise;
    },
  };
}
