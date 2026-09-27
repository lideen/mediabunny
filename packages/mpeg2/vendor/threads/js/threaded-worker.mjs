let decoder;
let memory;
let queue = Promise.resolve();
let queued = 0;
let failed = false;

function fatal(error) {
  if (failed) return;
  failed = true;
  self.onmessage = self.onmessageerror = null;
  queueMicrotask(() => { throw error; });
}

// The parent owns real worker handles, including during startup failure or a trap.
class PoolWorker extends EventTarget {
  constructor(url, options) {
    super();
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = ({ data }) => this.dispatchEvent(new MessageEvent('message', { data }));
    this.port.onmessageerror = () => fatal(new Error('pool message could not be deserialized'));
    self.postMessage({ type: 'spawn', url: String(url), options, port: channel.port2 }, [channel.port2]);
  }
  postMessage(data) { this.port.postMessage(data); }
}

const metadataKeys = ['width', 'height', 'chromaFormat', 'codedWidth', 'codedHeight',
  'chromaWidth', 'chromaHeight', 'yStride', 'cbStride', 'crStride', 'progressive',
  'progressiveSequence', 'topFieldFirst', 'temporalReference', 'frameRateNumerator',
  'frameRateDenominator', 'pixelAspectNumerator', 'pixelAspectDenominator',
  'colorPrimaries', 'colorTransfer', 'colorMatrix'];

function take(output) {
  if (!output) return undefined;
  const frame = output.frame;
  try {
    return { timestamp: output.timestamp, duration: output.duration,
      frame: { ...Object.fromEntries(metadataKeys.map(key => [key, frame[key]])),
        y: frame.takeY(), cb: frame.takeCb(), cr: frame.takeCr() } };
  } finally { frame.free(); }
}

async function handle({ id, operation, input, timing, options }) {
  let sendingReply = false;
  try {
    let value;
    if (operation === 'init') {
      const moduleStart = performance.now();
      const api = await import(options.runtimeUrl);
      const runtime = await api.init();
      const moduleInitMs = performance.now() - moduleStart;
      memory = runtime.memory;
      const poolStart = performance.now();
      if (options.threadCount > 1) {
        globalThis.Worker = PoolWorker;
        await api.initThreadPool(options.threadCount);
      }
      const poolStartupMs = performance.now() - poolStart;
      const decoderStart = performance.now();
      decoder = api.createPacketDecoder(options);
      value = { maxPacketBytes: decoder.maxPacketBytes, maxFrameBytes: decoder.maxFrameBytes,
        maxReferenceBytes: decoder.maxReferenceBytes, moduleInitMs, poolStartupMs,
        decoderSetupMs: performance.now() - decoderStart };
    } else if (operation === 'decode') {
      value = decoder.decode(input, timing).map(take);
    } else if (operation === 'discardLeadingB') {
      value = decoder.discardLeadingB(input);
    } else if (operation === 'finishSegment' || operation === 'drain') {
      value = take(decoder[operation]());
    } else if (operation === 'reset') {
      decoder.reset();
    } else if (operation === 'close') {
      // All earlier synchronous codec calls and borrowed Rayon jobs have joined.
      decoder?.free();
      decoder = undefined;
    } else {
      throw new Error('unknown packet worker operation');
    }
    const outputs = operation === 'decode' ? value : value?.frame ? [value] : [];
    const transfer = outputs.flatMap(output => [output.frame.y.buffer, output.frame.cb.buffer, output.frame.cr.buffer]);
    sendingReply = true;
    self.postMessage({ type: 'reply', id, value, memoryBytes: memory?.buffer.byteLength }, transfer);
    if (operation === 'close') self.close();
  } catch (error) {
    const terminal = sendingReply || operation === 'init' || error instanceof WebAssembly.RuntimeError;
    self.postMessage({ type: 'reply', id, error: { name: error.name, message: error.message },
      fatal: terminal });
    if (terminal) failed = true;
  }
}

self.onmessage = ({ data }) => {
  if (failed) return;
  if (++queued > 2) {
    fatal(new Error('packet worker queue limit exceeded'));
    return;
  }
  queue = queue.then(() => { if (!failed) return handle(data); })
    .finally(() => { queued--; }).catch(fatal);
};
self.addEventListener('messageerror', () => fatal(new Error('packet message could not be deserialized')));
