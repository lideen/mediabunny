/* @ts-self-types="./mpeg2_wasm.d.ts" */
import { startWorkers } from './snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.no-bundler.js';


/**
 * Owns untaken frames. free() releases them; takeFrame() transfers ownership.
 */
export class DecodedBatch {
    static __wrap(ptr) {
        const obj = Object.create(DecodedBatch.prototype);
        obj.__wbg_ptr = ptr;
        DecodedBatchFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodedBatchFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decodedbatch_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get frameCount() {
        const ret = wasm.decodedbatch_frameCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {DecodedFrame | undefined}
     */
    takeFrame() {
        const ret = wasm.decodedbatch_takeFrame(this.__wbg_ptr);
        return ret === 0 ? undefined : DecodedFrame.__wrap(ret);
    }
}
if (Symbol.dispose) DecodedBatch.prototype[Symbol.dispose] = DecodedBatch.prototype.free;

/**
 * Owns one frame. Each take-plane method returns an independent JS Uint8Array
 * and relinquishes its Rust vector. Calling it again returns an empty array.
 */
export class DecodedFrame {
    static __wrap(ptr) {
        const obj = Object.create(DecodedFrame.prototype);
        obj.__wbg_ptr = ptr;
        DecodedFrameFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodedFrameFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decodedframe_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get cbStride() {
        const ret = wasm.decodedframe_cbStride(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    get chromaFormat() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedframe_chromaFormat(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get chromaHeight() {
        const ret = wasm.decodedframe_chromaHeight(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get chromaWidth() {
        const ret = wasm.decodedframe_chromaWidth(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get codedHeight() {
        const ret = wasm.decodedframe_codedHeight(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get codedWidth() {
        const ret = wasm.decodedframe_codedWidth(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number | undefined}
     */
    get colorMatrix() {
        const ret = wasm.decodedframe_colorMatrix(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * @returns {number | undefined}
     */
    get colorPrimaries() {
        const ret = wasm.decodedframe_colorPrimaries(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * @returns {number | undefined}
     */
    get colorTransfer() {
        const ret = wasm.decodedframe_colorTransfer(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * @returns {number}
     */
    get crStride() {
        const ret = wasm.decodedframe_crStride(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get frameRateDenominator() {
        const ret = wasm.decodedframe_frameRateDenominator(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get frameRateNumerator() {
        const ret = wasm.decodedframe_frameRateNumerator(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.decodedframe_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get pixelAspectDenominator() {
        const ret = wasm.decodedframe_pixelAspectDenominator(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get pixelAspectNumerator() {
        const ret = wasm.decodedframe_pixelAspectNumerator(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    get progressiveSequence() {
        const ret = wasm.decodedframe_progressiveSequence(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get progressive() {
        const ret = wasm.decodedframe_progressive(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {Uint8Array}
     */
    takeCb() {
        const ret = wasm.decodedframe_takeCb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    takeCr() {
        const ret = wasm.decodedframe_takeCr(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    takeY() {
        const ret = wasm.decodedframe_takeY(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get temporalReference() {
        const ret = wasm.decodedframe_temporalReference(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get topFieldFirst() {
        const ret = wasm.decodedframe_topFieldFirst(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.decodedframe_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get yStride() {
        const ret = wasm.decodedframe_yStride(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) DecodedFrame.prototype[Symbol.dispose] = DecodedFrame.prototype.free;

/**
 * Complete-picture packet input. Timings are transport metadata, never codec ordering.
 */
export class PacketVideoDecoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PacketVideoDecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_packetvideodecoder_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} input
     * @param {number} timestamp
     * @param {number} duration
     * @returns {TimedPacketFrame[]}
     */
    decode(input, timestamp, duration) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packetvideodecoder_decode(this.__wbg_ptr, ptr0, len0, timestamp, duration);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * @param {Uint8Array} input
     * @returns {PrerollDiscardReport}
     */
    discardLeadingB(input) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packetvideodecoder_discardLeadingB(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PrerollDiscardReport.__wrap(ret[0]);
    }
    /**
     * @returns {TimedPacketFrame | undefined}
     */
    drain() {
        const ret = wasm.packetvideodecoder_drain(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : TimedPacketFrame.__wrap(ret[0]);
    }
    /**
     * @returns {TimedPacketFrame | undefined}
     */
    finishSegment() {
        const ret = wasm.packetvideodecoder_finishSegment(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : TimedPacketFrame.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    get maxFrameBytes() {
        const ret = wasm.packetvideodecoder_maxFrameBytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get maxPacketBytes() {
        const ret = wasm.packetvideodecoder_maxPacketBytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get maxReferenceBytes() {
        const ret = wasm.packetvideodecoder_maxReferenceBytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} max_packet_bytes
     * @param {number} max_frame_bytes
     */
    constructor(max_packet_bytes, max_frame_bytes) {
        const ret = wasm.packetvideodecoder_new(max_packet_bytes, max_frame_bytes);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        PacketVideoDecoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    reset() {
        wasm.packetvideodecoder_reset(this.__wbg_ptr);
    }
}
if (Symbol.dispose) PacketVideoDecoder.prototype[Symbol.dispose] = PacketVideoDecoder.prototype.free;

/**
 * Header-only discard receipt. No decoded frame or timing is associated with it.
 */
export class PrerollDiscardReport {
    static __wrap(ptr) {
        const obj = Object.create(PrerollDiscardReport.prototype);
        obj.__wbg_ptr = ptr;
        PrerollDiscardReportFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PrerollDiscardReportFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_prerolldiscardreport_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get anchorTemporalReference() {
        const ret = wasm.__wbg_get_prerolldiscardreport_anchorTemporalReference(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint}
     */
    get packetId() {
        const ret = wasm.__wbg_get_prerolldiscardreport_packetId(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    get temporalReference() {
        const ret = wasm.__wbg_get_prerolldiscardreport_temporalReference(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) PrerollDiscardReport.prototype[Symbol.dispose] = PrerollDiscardReport.prototype.free;

/**
 * Transport owner consumed by the JS facade; taking its frame transfers pixel ownership.
 */
export class TimedPacketFrame {
    static __wrap(ptr) {
        const obj = Object.create(TimedPacketFrame.prototype);
        obj.__wbg_ptr = ptr;
        TimedPacketFrameFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TimedPacketFrameFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_timedpacketframe_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get duration() {
        const ret = wasm.timedpacketframe_duration(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {DecodedFrame | undefined}
     */
    takeFrame() {
        const ret = wasm.timedpacketframe_takeFrame(this.__wbg_ptr);
        return ret === 0 ? undefined : DecodedFrame.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    get timestamp() {
        const ret = wasm.timedpacketframe_timestamp(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) TimedPacketFrame.prototype[Symbol.dispose] = TimedPacketFrame.prototype.free;

/**
 * Owns one complete ES and persistent reference state. free() cancels without draining.
 * Previously returned frames remain owned by the caller, including after a later error.
 */
export class VideoDecoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        VideoDecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_videodecoder_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get maxFrameBytes() {
        const ret = wasm.videodecoder_maxFrameBytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get maxFrames() {
        const ret = wasm.videodecoder_maxFrames(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get maxReferenceBytes() {
        const ret = wasm.videodecoder_maxReferenceBytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {Uint8Array} input
     * @param {number} max_frame_bytes
     * @param {number} max_frames
     */
    constructor(input, max_frame_bytes, max_frames) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.videodecoder_new(ptr0, len0, max_frame_bytes, max_frames);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        VideoDecoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Undefined means final EOF, never a request for more input. Errors are sticky.
     * @returns {DecodedFrame | undefined}
     */
    nextFrame() {
        const ret = wasm.videodecoder_nextFrame(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : DecodedFrame.__wrap(ret[0]);
    }
}
if (Symbol.dispose) VideoDecoder.prototype[Symbol.dispose] = VideoDecoder.prototype.free;

/**
 * Decode the entire input or throw. Use js/index.mjs to validate before the
 * generated glue copies the input into WASM memory.
 * @param {Uint8Array} input
 * @param {number} max_output_bytes
 * @returns {DecodedBatch}
 */
export function decode(input, max_output_bytes) {
    const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode(ptr0, len0, max_output_bytes);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return DecodedBatch.__wrap(ret[0]);
}

/**
 * @param {number} num_threads
 * @returns {Promise<any>}
 */
export function initThreadPool(num_threads) {
    const ret = wasm.initThreadPool(num_threads);
    return ret;
}

export class wbg_rayon_PoolBuilder {
    static __wrap(ptr) {
        const obj = Object.create(wbg_rayon_PoolBuilder.prototype);
        obj.__wbg_ptr = ptr;
        wbg_rayon_PoolBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        wbg_rayon_PoolBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 0);
    }
    build() {
        wasm.wbg_rayon_poolbuilder_build(this.__wbg_ptr);
    }
    /**
     * @returns {string}
     */
    mainJS() {
        const ret = wasm.wbg_rayon_poolbuilder_mainJS(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    numThreads() {
        const ret = wasm.wbg_rayon_poolbuilder_numThreads(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    receiver() {
        const ret = wasm.wbg_rayon_poolbuilder_receiver(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) wbg_rayon_PoolBuilder.prototype[Symbol.dispose] = wbg_rayon_PoolBuilder.prototype.free;

/**
 * @param {number} receiver
 */
export function wbg_rayon_start_worker(receiver) {
    wasm.wbg_rayon_start_worker(receiver);
}
function __wbg_get_imports(memory) {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_memory_caa4a6165639c8b5: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_module_7115fb14045f9891: function() {
            const ret = wasmModule;
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_instanceof_Window_82d71df4eddf88bc: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_startWorkers_622cedd0d351664e: function(arg0, arg1, arg2) {
            const ret = startWorkers(arg0, arg1, wbg_rayon_PoolBuilder.__wrap(arg2));
            return ret;
        },
        __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_0b583911f537483a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_URL_fac851ed3060f4eb: function() {
            const ret = import.meta.url;
            return ret;
        },
        __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_timedpacketframe_new: function(arg0) {
            const ret = TimedPacketFrame.__wrap(arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
        memory: memory || new WebAssembly.Memory({initial:18,maximum:4096,shared:true}),
    };
    return {
        __proto__: null,
        "./mpeg2_wasm_bg.js": import0,
    };
}

const DecodedBatchFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decodedbatch_free(ptr, 1));
const DecodedFrameFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decodedframe_free(ptr, 1));
const PacketVideoDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packetvideodecoder_free(ptr, 1));
const PrerollDiscardReportFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_prerolldiscardreport_free(ptr, 1));
const TimedPacketFrameFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_timedpacketframe_free(ptr, 1));
const VideoDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_videodecoder_free(ptr, 1));
const wbg_rayon_PoolBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : undefined);
if (cachedTextDecoder) cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module, thread_stack_size) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    if (typeof thread_stack_size !== 'undefined' && (typeof thread_stack_size !== 'number' || thread_stack_size === 0 || thread_stack_size % 65536 !== 0)) {
        throw new Error('invalid stack size');
    }

    wasm.__wbindgen_start(thread_stack_size);
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module, memory, thread_stack_size} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports(memory);
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module, thread_stack_size);
}

async function __wbg_init(module_or_path, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path, memory, thread_stack_size} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('mpeg2_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports(memory);

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

export { initSync, __wbg_init as default };
