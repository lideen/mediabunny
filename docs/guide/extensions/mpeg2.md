# Private MPEG-2 decoder

`@mediabunny/mpeg2` is an optional local WASM decoder. **It is not licensed for public distribution or npm publication.** The Rust dependency has no selected project license. The local media-player example explicitly registers it, so generated example assets also remain private.

```ts
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';

registerMpeg2Decoder();
```

Like `registerProresDecoder()`, `registerMpeg2Decoder()` accepts no arguments and is idempotent. Call it before starting a decoding task, then use `VideoSampleSink` or `CanvasSink`. The decoder class is internal; Mediabunny owns its instances, packet ordering and cleanup.

Each decoder initializes the standalone `createMpeg2Decoder` factory without an execution override. The factory uses direct decoding without browser Worker support, one serial worker without cross-origin isolation or SharedArrayBuffer, or automatic slice-pool sizing when both are available. Pool sizing chooses the largest supported `1`/`2`/`4` not exceeding a valid positive integer `navigator.hardwareConcurrency`; invalid or missing hints select `1`. Two/four pool workers add one coordinator. No core is subtracted for it, and no Node `worker_threads` backend is provided.

Explicit `concurrency` belongs only to the standalone factory for callers supplying elementary-picture packets, just as concurrency belongs to TurboRes's `Decoder.create` rather than ProRes registration. It is not a Mediabunny extension option or export. See the standalone factory declarations linked from `packages/mpeg2/README.md`. MPEG-2 slices can run in parallel; frames retain their reference dependencies and decode order.

The factory embeds its WASM and worker graph; there is no runtime URL or asset directory to supply. CSP must allow Blob/module workers and WebAssembly compilation. Cross-origin isolation requires COOP/COEP headers and compatible resource policies. A selected backend's initialization failure rejects without retrying direct decoding. Automatic sizing does not promise higher throughput or real-time playback.

Use `formats: [MXF]` when creating the input. Registration does not add MXF to `ALL_FORMATS`, enable encoding or muxing, or install a server/native fallback.

This integration supports a [narrow indexed MPEG-2 MXF subset](../supported-formats-and-codecs#experimental-mxf-input): progressive Main Profile / High and High-1440 Level 4:2:0, plus 4:2:2 Profile / High Level with profile byte `82`. It produces owned I420 or I422 samples at visible sequence dimensions. The 4:2:2 path supports frame pictures with FrameLayout 1 field-based descriptor geometry and woven interlaced output. Native per-picture flags preserve top-first or bottom-first scan order. It neither deinterlaces nor doubles the frame rate; canvas and VideoFrame conversions do not retain scan metadata. Separate field pictures, repeated-field cadence, scalable coding and D-10 remain unsupported.

The separate opt-in [LXF input](../supported-formats-and-codecs#experimental-lxf-input) also uses this decoder for its version-1, closed all-I 4:2:2 subset. Its timestamps come from the 720 kHz wire clock, and its planar PCM24 is normalized to interleaved packets at the container boundary. This adds no native decoder fallback, output format or distribution permission.

Restart anchors contain sequence and GOP headers. Progressive Main-profile open-flag GOPs still require the MXF reader's bounded proof of an unreordered I/P-only interval. The 4:2:2 path uses an explicit decode-start plan for open-GOP B pictures. Initial leading Bs may receive header-only preroll only when strictly before the selection minimum. This preserves persistent matrix updates without emitting pixels or claiming entropy validation. Requested leading Bs instead require an earlier dependency anchor. Missing coverage or dependencies outside the 256-entry inversion window fail explicitly; the window is not a promise to support every 255-picture lookback. Ordinary packet iteration omits nothing, and there is no decode-from-frame-zero fallback.

Stored macroblock padding is not exposed as extra decoded pixels. Plane data, packet timestamps and durations remain independent of native reset and disposal. Unspecified color primaries and transfer remain unspecified.

The WASM bytes are bundled locally and compiled on first use without fetching another resource. Each decoder limits complete packets and padded frames to 8 MiB, with bounded native references and no 64-frame lifetime cap. Flush finishes a requested selection and resets for the next independent key; it does not claim complete-stream integrity when a selection omits trailing B pictures.

Default WASM uses the user-authorized `h262-butterfly-q14-q5-v1` integer transform. Native decoding remains f64. Rounding and pixels intentionally change; there is no IDCT mode option. Retained media showed predictive drift up to 2, and an authored consumer matrix-update fixture showed accumulated drift up to 3. These observations do not bound unseen streams. IEEE 1180 A2 qualification is incomplete and no IEEE or full H.262 conformance is claimed.

See `packages/mpeg2/README.md`, `packages/mpeg2/NUMERICAL_MIGRATION.md` and `packages/mpeg2/vendor/decoder/PROVENANCE.json` for lifecycle details, exact artifact identity, permission limits and validation scope. Tests retain independent FAANI/native/f64 references and use separately labeled, input-bound qualified WASM regression hashes for changed output. Matrix-state, planning-cutoff and asynchronous initialization checks remain. These hashes are not independent accuracy evidence. Browser acceptance requires a fresh-built runtime gate; historical results do not verify the current artifact.

Historical Chromium 154 verification of the previous adapter covered all 18 fixture frames, backward selections, held samples after disposal, and canvas conversion. Both minified and unminified bundles matched every independent YUV plane hash. On independently selected uniform-chroma regions, canvas RGB differed from the floating-point BT.709 limited-range reference by at most 0.501 levels per channel. The built media player displayed all 18 frames on playback and replay, reached natural EOF, and scheduled the stereo PCM buffers. This 0.72-second local fixture does not establish sustained real-time performance or broader format support, nor verify the factory-backed adapter. The entire generated example deployment must remain private because its shared bundle includes this decoder.
