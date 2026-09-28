# Private MPEG-2 decoder extension

This package is for the user-authorized local integration only. It is `private: true` and `UNLICENSED`. Do not publish it, the generated media-player example, or bundles containing its WASM. The Rust project has not selected a license. The MPL headers on the Mediabunny adapter do not license the Rust module, generated bindings, or upstream JS facade. Public distribution requires a separate permission and licensing review.

```ts
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import { Input, MXF, BufferSource, VideoSampleSink } from 'mediabunny';

registerMpeg2Decoder();
const input = new Input({ source: new BufferSource(bytes), formats: [MXF] });
const track = await input.getPrimaryVideoTrack();
if (track) {
    const sample = await new VideoSampleSink(track).getSample(1 / 25);
    // Use the sample, then close it and dispose the input.
    sample?.close();
}
input.dispose();
```

The only extension export is `registerMpeg2Decoder()`. Like `registerProresDecoder()`, it accepts no arguments. Call it before starting a decoding task, then use Mediabunny's `VideoSampleSink` or `CanvasSink`. Mediabunny creates decoder instances and manages packet ordering, selection flushes and cleanup. The decoder class is internal.

Registration is explicit and idempotent. Neither core nor `@mediabunny/server` registers this decoder. MXF remains opt-in and outside `ALL_FORMATS`. There is no native WebCodecs fallback, FFmpeg fallback, encoder, or muxer.

## Execution and standalone configuration

The adapter calls the standalone `Decoder.create()` method from `mpeg2-rs`
during each decoder's initialization. It supplies 8 MiB packet/frame budgets and an
AbortSignal, but no execution override. `Decoder` chooses its default:

| Environment | Execution |
| --- | --- |
| No browser Worker | Direct decoding in the calling realm. |
| Worker without cross-origin isolation or SharedArrayBuffer | One embedded serial worker. |
| Worker with cross-origin isolation and SharedArrayBuffer | Automatic slice-pool sizing. |

Automatic sizing selects the largest supported `1`, `2` or `4` not exceeding a valid
positive integer `navigator.hardwareConcurrency`. Missing or invalid hints select
one worker. No core is subtracted for the coordinator. Two/four pool workers require
three/five total workers per decoder. There is no global shared pool or Node
`worker_threads` backend. A selected backend's initialization failure rejects the
decoding task without retrying another backend.

Advanced callers that supply elementary-picture packets use the separate
`@mpeg2-rs/decoder` package at the `mpeg2-rs` repository root. Its generated
[public declarations](vendor/decoder/mpeg2-decoder.d.mts) forward to
[the TypeScript class declarations](vendor/decoder/types/index.d.ts). The vendored
[package marker](vendor/decoder/package.json) preserves ESM resolution for those declarations.
The `Decoder.create()` `concurrency`
option supports `0` for direct, `1` for a serial worker, and `2`/`4` for slice pools.
Those options belong to `Decoder.create()`, not `registerMpeg2Decoder`. There is no
registration configuration object, setter, or re-export of `Decoder` or `Frame` here.
This is the same separation as Mediabunny's zero-argument ProRes registration and
TurboRes's lower-level `Decoder.create` options. MPEG-2 parallelizes eligible slices,
not independent frames; reference dependencies and delayed output remain stateful.

## Browser deployment

The standalone decoder embeds the scalar/shared WASM and worker graph. ESM and global extension
bundles need no external runtime URL, worker URL, CDN or copied asset tree. The
standalone decoder manages its Blob URLs and workers; Mediabunny does not build another
transport around it. Old vendored runtime trees remain audit material, not runtime
dependencies or package exports.

CSP must permit WebAssembly compilation under the applicable script policy,
including `'wasm-unsafe-eval'`, and `blob:` module workers/scripts. Enable automatic
pooling by serving the page with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, with compatible policies on its resources.
Ineligible slice layouts still use the kernel's serial path inside the selected
backend. Automatic sizing is not a throughput, optimality or real-time playback claim.

## Historical WASM qualification

The qualified shared module is 332,988 bytes, SHA-256
`32270a44364331fe90b2d22aeb590471c767a0bf4bd5c2e4e6346561e6ef7281`.
Its `PROVENANCE.json` records the qualified input manifest and source-file mapping.
The Rayon helper has a controlled Apache-2.0 adaptation that forwards asynchronous
child initialization rejection to the Worker's error event. `helper-adaptation.json`
records original/patched hashes and the adaptation script identity. The supplied
tree is `mpeg2-butterfly-idct-20260927/integration-ready-final/`.
The reviewed source commit is `3ccd64065dd45e6675b0a3602d1804315935b515`.
All 565 final snapshot source identities match that commit. Its build base was
`1fafe8f611afab696ce8b90d2d54b46f4c252789`.
The manifest preserves actual source hashes and original build records. Two recording
and packaging tools changed after the build; no compiled input changed. This is not
a clean-commit rebuild.
`NOTICE.txt` and `licenses/` retain the locked dependencies' license texts. These
licenses do not authorize distribution of the combined private MPEG-2 package.
Default WASM uses numerical version `h262-butterfly-q14-q5-v1`, an integer butterfly
with eleven multiplies per one-dimensional transform and Q14 constants/Q5 retained
precision. The native decoder remains f64. This user-authorized change deliberately
changes rounding and decoded pixels; it is not an exact-old-pixel optimization.
There is no public IDCT mode switch. The sixteen-row slice worklist, automatic sizing,
direct/worker/pool APIs and transport are unchanged. Experimental wide-fixed,
approximation and bounds-mode artifacts are not included.

Core qualification covers 83,773 blocks and 5,361,472 residuals, including exact
DC/F63 and half-boundary checks. IEEE 1180 A2 qualification is incomplete, A3 accuracy
is sampled, and there is no IEEE or full H.262 conformance claim. Core retained media
showed predictive drift up to 2. The consumer's authored open-GOP matrix fixture
additionally shows accumulated drift up to 3 after three residual P pictures.
Neither observation bounds unseen streams. The [numerical migration record](NUMERICAL_MIGRATION.md)
describes the consumer checks and retained old references.

### Historical f64 measurements

These records describe the previous adapter, transports and configuration API.
They are not deployment instructions or measurements of the factory-backed adapter.

The previous f64 consumer integration was compared against frozen production bundles
from Mediabunny `3a6e0b8`, using five warm and seven measured old/new ABBA rounds.
Both artifacts used identical core, transport, automatic-selection policy and owned
output transfer. Explicit direct and four-thread modes avoided policy differences.
Paired lifetime wall-time reductions were 8.64%/9.22%/8.52% for direct SWAT/Live/long-IPB
and 11.35%/12.81%/13.12% for their four-thread counterparts. Progressive 720p and Cosmos
also improved in both tested modes. These are combined public-sink observations,
not sums of isolated kernel gains. Timing included Input setup, pool startup, every
sample copy and disposal with observed termination calls. Media fetches, host-bundle
loading, hashes and rendering were excluded; lazy runtime loading and initialization
were inside timing. The browser process was reused, while local HTTP responses used
`Cache-Control: no-store`; engine code-cache behavior was not measured. The 18–60-frame
selections do not establish sustained playback or cold-browser startup performance.
Full frame hashes, timing, scan, backward selections and held clones matched the
old per-target output in direct/serial-worker/2/4 modes through ESM and global bundles.

Historical captured-media public-sink measurements (five warm ABBA rounds, seven measured rounds,
14 observations per mode/workload) found paired lifetime wall-time reductions of
38.0%/39.8% for SWAT/Live with two pool workers and 61.6%/64.0% with four. The
60-frame authored IPB selection improved 22.4%/42.1%. Short progressive 720p
selections regressed 28.9%/13.5%. The runtime URL remains an opt-in to automatic pooling,
and callers can force count 1. The sizing policy is not a new measured speed claim.
These unpaced runs included Input construction, startup, output copies and disposal,
but no canvas rendering. They do not establish sustained playback rates. Each
shared WASM instance has a 256 MiB maximum; observed linear-memory allocation is
not total process memory or evidence of reclamation after termination. Those timings
precede the final coordinator reply-loss and Rayon child-startup failure fixes.
The WASM kernels are identical, but the historical JS runtime hashes are not the
final runtime hashes. Correctness and lifecycle validation were repeated after refresh;
the timing campaign was not relabeled or repeated.

For that previous f64 integration, the built ESM/global paths matched the frozen scalar's complete frame pixels,
timing and scan metadata across six captured/authored selections, including backward
open-GOP selections and clones held after disposal. Cancellation during initialization,
decode and segment finish, capability rejection and partial startup failure were
checked separately. The `browser-threads` Vitest project serves built runtime files
unchanged and checks real-worker lifecycle and independent pixel goldens.

## Decoder ownership and cancellation

The adapter uses the existing custom-decoder serializer. It adds no packet queue or worker protocol. The standalone `Decoder` owns decoding, worker transport, cancellation and native resources. It returns owned `Frame` instances; the adapter packs their planes into I420/I422 samples with Mediabunny timing, scan and color metadata, then calls `Frame.clear()` on every returned frame in `finally`.

Abort/disposal invokes the synchronous custom-decoder `cancel()` hook before awaiting serialized cleanup. The adapter aborts pending `Decoder.create()` initialization and cancels an active standalone decoder immediately. Close awaits that same initialization promise, including standalone cleanup. Shared scalar compilation can continue into the standalone cache after cancellation, but cannot allocate a decoder for the canceled request. Late initialization cannot attach a decoder or emit frames. Close is idempotent. Errors remain sticky per decoder, including adapter output/callback failures. Other custom decoders without `cancel()` retain their previous close ordering.

`test/node/mpeg2-worker.test.ts` covers cancellation and startup-error propagation through the real standalone decoder and Input/sinks, blocking only worker startup. `test/node/sink-decoder-abort.test.ts` owns shared iterator cancellation and legacy close ordering. Browser tests cover real serial/pool initialization cancellation, default worker creation, I420/I422 pixels, backward open-GOP selections and held clones. The standalone decoder's tests own concurrency policy, worker messages, transfer validation, lost replies, child startup and per-operation transport failure handling.

### Historical worker responsiveness

Retained c9cae measurements cover main-thread responsiveness during unpaced 30/32-frame public-sink bursts with warmed caches, not paced playback or a later Rust optimization artifact. They time track setup through decoding, full sample copies, canvas draw-call execution and Input disposal; Input construction, fetch and hashing are excluded. Draw-call execution does not establish compositor completion or presentation. Worker heap/module duplication, bundle cost and aggregate memory with concurrent decoders were not measured. No heap or GC improvement is claimed; natural GC was included without forced-GC control. Lifecycle observations confirm calls to `Worker.terminate()`, not independently measured thread exit or heap reclamation.

## Supported input and ownership

The MXF subset includes progressive MPEG-2 Main Profile / High or High-1440 Level, 8-bit 4:2:0 in indexed OP1a frame wrapping. Those open-flag GOPs still require a per-restart proof of unreordered I/P-only index entries and actual picture headers through the next key or track end, at most 128 pictures. The additional 4:2:2 Profile / High Level path accepts frame pictures, including woven interlaced output, with explicit open-GOP dependency planning. Restart anchors carry in-band sequence, extension, GOP and I-picture headers. The generic packet classifier still returns `null` for open-flag I pictures; MXF owns the index and header proof.

Stored macroblock padding may exceed visible dimensions, with zero sampled/display offsets and matching sampled/display rectangles. Decoder configuration and owned planes use visible sequence dimensions. FrameLayout 1 descriptor heights are per-field and become full-frame heights. Sony D-10 remains unsupported. LXF uses a separate opt-in version-1 input with a narrower closed all-I contract; see `src/lxf/README.md`. Separate field pictures, repeated-field cadence, scalable coding, other profiles/levels and incomplete headers remain unsupported.

The adapter outputs owned planar I420 or I422 `VideoSample`s. Native per-picture flags set `scan` to progressive, interlaced-top-first or interlaced-bottom-first. Interlaced samples retain woven lines at the original frame rate; no deinterlacing is performed. Canvas and VideoFrame conversions do not retain this scan metadata. `Frame.takeY`, `Frame.takeCb`, and `Frame.takeCr` return owned JS planes; the adapter combines them using the reported strides and calls `Frame.clear()` in `finally`. Clearing is idempotent and preserves metadata and already-taken planes. Mediabunny's `VideoSample.close()` is unchanged. Held samples survive later decode, flush, close, and input disposal. Color metadata is forwarded from decoder configuration without filling in unspecified primaries or transfer.

Packet timing passes directly to `decode(bytes, { timestamp, duration })`. The native decoder associates delayed frames with their packets and returns display-ordered timed output. The adapter neither sorts temporal references nor maintains a timestamp map, packet history, or second operation queue.

In direct mode, the embedded 126,458-byte metadata-stripped scalar module is compiled lazily, shared between decoder instances in that realm, and loaded without fetches. Worker mode initializes a separate WASM environment per decoder worker. Each decoder owns its own native references. Input and padded frame budgets are 8 MiB each; native reference storage is bounded to 24 MiB per decoder. Width is at most 4096 and height at most 2304, subject to the tighter padded-frame budget. There is no 64-picture lifetime cap. Authored tests and bounded local 1080p I422 selections provide targeted evidence, not general MPEG-2 conformance certification.

## Selection lifecycle

`flush()` uses `finishSegment()`, captures the pending complete anchor, resets the native decoder, then emits the captured frame. It intentionally permits a selection such as I0/P3/B1 to stop before B2. It is not an end-of-stream integrity check. Strict `drain()` is not used. Each subsequent segment starts from a new backing-owned decode plan. No headers are synthesized from `config.description`.

Both sample iteration paths execute explicit header-only preroll through the existing decoder call serializer. Only consecutive initial cold-open-GOP leading Bs strictly before the requested selection may be discarded. `discardLeadingB` retains persistent matrix updates without reconstructing pixels or claiming entropy validation. Requested leading Bs use the previous dependency anchor instead. Decoders without this capability fail explicitly. Ordinary encoded-packet iteration never omits these packets. Index inversion uses a 256-entry window and rejects dependencies that cannot be proved there; it does not fall back to decoding from frame zero.

Malformed native pictures throw sticky errors. A failed finish does not reset away that error. Close frees references without draining, is idempotent, and invalidates pending lazy initialization. Native decode itself is synchronous and cannot be interrupted mid-call. Closing from a sample callback suppresses any remaining output from that call and frees its frames.

Capability checks retain the I420 geometry envelope. Native parsing enforces the actual chroma-specific padded-frame budget before allocation; configuration geometry alone does not prove I422 will fit.

## Provenance and validation

`vendor/decoder/PROVENANCE.json` identifies the self-contained decoder bundle and its embedded runtimes. The earlier `vendor/PROVENANCE.json` and `vendor/threads/` records retain the native build history and qualified WASM identities. They do not identify the new JS bundle. The license-header checker visits `src` only, never `vendor`. Bundle banners retain the distribution restriction and WASM identities.

The integrated TypeScript decoder module is 591,931 bytes, SHA-256 `f367bc1fd8944ad4845bbf44bf26fe382065945e5319579d98ff1468fc2b9ee5`. The previous factory module was 588,783 bytes, SHA-256 `57b577ebb4c4ffec36ba586e0b84f7b41d080bf67aaa66dcc6822402a57d6c09`. Supplied provenance records TypeScript/JS source identities and packaging adaptations separately from the frozen WASM inputs. Packaging removes only the WASM `name` and `producers` custom sections and deduplicates the scalar base64 payload. The WASM header, standard sections and `target_features` bytes are unchanged, but the complete deployed binaries have different hashes. Stack traces may show function indices instead of names. The build copies only `PROVENANCE.json`, `NOTICE.txt` and dependency `licenses/` into `dist/decoder/`, which is included in the private package. Standalone declarations remain build inputs, not extension exports. No standalone global bundle, raw diagnostic runtime or old external runtime tree is shipped separately. Mediabunny consumes the complete artifact without rebuilding the producer or reading its qualified inputs.

- Original WASM source commit: `3ccd64065dd45e6675b0a3602d1804315935b515`; original build base: `1fafe8f611afab696ce8b90d2d54b46f4c252789`.
- Original scalar WASM SHA-256: `c06ed93c42aa17dfe45bcad2e55b6d14fca5e0c07b5bca1cc469b52999407b9b`.
- Original shared WASM SHA-256: `32270a44364331fe90b2d22aeb590471c767a0bf4bd5c2e4e6346561e6ef7281`.
- Deployed scalar WASM: 126,458 bytes, SHA-256 `78c810d649f34fb574f5d1dd8aae1407dda6c3e960a4102e835553bc7ab6da54`.
- Deployed shared WASM: 244,600 bytes, SHA-256 `362a9776dabca4ffd182e628d9848d67e30e1a707a9098bfcbde18d6e25e2bf0`.
- Original build records pin compiler identities and separate scalar/shared flags. Packaging-only source changes after the build are recorded separately. No Rust rebuild or source modification is part of this package integration.

`test/node/mpeg2.test.ts` imports the actual bundled package and verifies all 18 authored MXF frames against qualified WASM regression hashes, unchanged independent PCM hashes, individual and batched backward selections, native error behavior, timing, ownership, close during initialization, and more than 64 packets without reset. Original FAANI/native/f64 references remain unchanged. The new hashes are regression records, not independent mathematical accuracy evidence. Browser canvas rendering requires separate real-browser verification; Node planar equality is not a canvas color-conversion proof.
