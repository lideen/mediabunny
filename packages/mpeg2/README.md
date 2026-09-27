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

Registration is explicit and idempotent. Neither core nor `@mediabunny/server` registers this decoder. MXF remains opt-in and outside `ALL_FORMATS`. There is no native WebCodecs fallback, FFmpeg fallback, encoder, or muxer.

## Optional browser worker

`registerMpeg2Decoder({ useWorker: true })` selects an embedded browser worker instead of main-thread decoding. Omitting the option retains direct decoding. Repeating the same mode is idempotent; changing modes after registration throws. Worker mode does not silently fall back to direct decoding if Worker support, initialization or CSP permission is missing. Applications that need a different mode must decide before registration in a fresh registry/application context.

Each decoder creates one worker lazily during initialization. The existing custom-decoder serializer owns scheduling; the transport permits only one outstanding request and has no packet queue of its own. Packet transfers copy only the caller's visible packet bytes, never detaching the caller's storage. The worker uses the same private vendored WASM, returns at most two packed owned frame buffers per decode, and frees native frames before sending them. The host validates reply IDs, dimensions, format, scan, timing and packed plane bounds before constructing samples. Held samples and clones own storage independently of the worker.

The build embeds a self-contained IIFE worker script and its WASM in the ESM/global extension bundles. It does not use a relative `import.meta.url`, external worker URL, CDN, SharedArrayBuffer, worker pool or Rust threads. Browser policy must permit `worker-src blob:` and WebAssembly compilation under the applicable script policy. Worker URLs are revoked after initialization or on failure/cancellation. Bundles remain private and unlicensed for distribution; worker packaging grants no additional permission.

Abort/disposal invokes the optional synchronous custom-decoder `cancel()` hook before awaiting serialized cleanup. Worker cancellation terminates the worker and rejects pending work, including initialization; queued calls cannot recreate it. Normal flush does not cancel: it runs `finishSegment`, packs the result, then resets only after success. Errors are sticky. Normal close remains idempotent. Other custom decoders without `cancel()` retain their previous close ordering.

`test/node/mpeg2-worker.test.ts` exercises real Input/sink ownership and cancellation against a fake browser transport. `test/node/sink-decoder-abort.test.ts` covers shared iterator cancellation and legacy decoder close ordering. `test/browser/mpeg2-worker.test.ts` exercises the rebuilt embedded worker with I420/I422 pixel and held-clone checks, stalled-request cancellation, and failed error reporting. The browser tests are required alongside Node tests; fake transport coverage alone does not establish browser-worker correctness. Worker mode remains opt-in and does not promise higher decode throughput or real-time playback.

Retained c9cae measurements cover main-thread responsiveness during unpaced 30/32-frame public-sink bursts with warmed caches, not paced playback or a later Rust optimization artifact. They time track setup through decoding, full sample copies, canvas draw-call execution and Input disposal; Input construction, fetch and hashing are excluded. Draw-call execution does not establish compositor completion or presentation. Worker heap/module duplication, bundle cost and aggregate memory with concurrent decoders were not measured. No heap or GC improvement is claimed; natural GC was included without forced-GC control. Lifecycle observations confirm calls to `Worker.terminate()`, not independently measured thread exit or heap reclamation.

## Supported input and ownership

The MXF subset includes progressive MPEG-2 Main Profile / High or High-1440 Level, 8-bit 4:2:0 in indexed OP1a frame wrapping. Those open-flag GOPs still require a per-restart proof of unreordered I/P-only index entries and actual picture headers through the next key or track end, at most 128 pictures. The additional 4:2:2 Profile / High Level path accepts frame pictures, including woven interlaced output, with explicit open-GOP dependency planning. Restart anchors carry in-band sequence, extension, GOP and I-picture headers. The generic packet classifier still returns `null` for open-flag I pictures; MXF owns the index and header proof.

Stored macroblock padding may exceed visible dimensions, with zero sampled/display offsets and matching sampled/display rectangles. Decoder configuration and owned planes use visible sequence dimensions. FrameLayout 1 descriptor heights are per-field and become full-frame heights. Sony D-10 remains unsupported. LXF uses a separate opt-in version-1 input with a narrower closed all-I contract; see `src/lxf/README.md`. Separate field pictures, repeated-field cadence, scalable coding, other profiles/levels and incomplete headers remain unsupported.

The adapter outputs owned planar I420 or I422 `VideoSample`s. Native per-picture flags set `scan` to progressive, interlaced-top-first or interlaced-bottom-first. Interlaced samples retain woven lines at the original frame rate; no deinterlacing is performed. Canvas and VideoFrame conversions do not retain this scan metadata. Native `takeY`, `takeCb`, and `takeCr` transfer independent JS plane copies; the adapter combines them using the reported strides and frees each Rust frame in `finally`. Held samples survive later decode, flush, close, and input disposal. Color metadata is forwarded from decoder configuration without filling in unspecified primaries or transfer.

Packet timing passes directly to `decode(bytes, { timestamp, duration })`. The native decoder associates delayed frames with their packets and returns display-ordered timed output. The adapter neither sorts temporal references nor maintains a timestamp map, packet history, or second operation queue.

In direct mode, the embedded 155,437-byte default-scalar module is compiled lazily, shared between decoder instances in that realm, and loaded without fetches. Worker mode initializes a separate WASM environment per decoder worker. Each decoder owns its own native references. Input and padded frame budgets are 8 MiB each; native reference storage is bounded to 24 MiB per decoder. Width is at most 4096 and height at most 2304, subject to the tighter padded-frame budget. There is no 64-picture lifetime cap. Authored tests and bounded local 1080p I422 selections provide targeted evidence, not general MPEG-2 conformance certification.

## Selection lifecycle

`flush()` uses `finishSegment()`, captures the pending complete anchor, resets the native decoder, then emits the captured frame. It intentionally permits a selection such as I0/P3/B1 to stop before B2. It is not an end-of-stream integrity check. Strict `drain()` is not used. Each subsequent segment starts from a new backing-owned decode plan. No headers are synthesized from `config.description`.

Both sample iteration paths execute explicit header-only preroll through the existing decoder call serializer. Only consecutive initial cold-open-GOP leading Bs strictly before the requested selection may be discarded. `discardLeadingB` retains persistent matrix updates without reconstructing pixels or claiming entropy validation. Requested leading Bs use the previous dependency anchor instead. Decoders without this capability fail explicitly. Ordinary encoded-packet iteration never omits these packets. Index inversion uses a 256-entry window and rejects dependencies that cannot be proved there; it does not fall back to decoding from frame zero.

Malformed native pictures throw sticky errors. A failed finish does not reset away that error. Close frees references without draining, is idempotent, and invalidates pending lazy initialization. Native decode itself is synchronous and cannot be interrupted mid-call. Closing from a sample callback suppresses any remaining output from that call and frees its frames.

`Mpeg2Decoder` is also exported for applications already supplying complete elementary-picture packets. Direct callers set the inherited `codec`, `config`, `onSample`, and `onError` fields through their custom-coder setup, serialize calls, and close the decoder. Capability checks retain the I420 geometry envelope. Native parsing enforces the actual chroma-specific padded-frame budget before allocation; configuration geometry alone does not prove I422 will fit.

## Provenance and validation

`vendor/PROVENANCE.json` records the source commit, source/compiler hashes, dependency license metadata, original build-record hash, and every copied artifact hash. Upstream files are unmodified; only `vendor/js/index.d.mts` is an adapter-authored declaration for the used facade API. The license-header checker visits `src` only, never `vendor`. Bundle banners retain the distribution restriction and exact WASM identity.

- Source commit: `3d38fca7df512389384b93697b7dd8cab4a3b49d`, accepted default scalar optimizations. Later tools-only commits do not change the decoder source identity; experimental autovectorized and factorized builds are excluded.
- WASM SHA-256: `7b26778cd36ec110c9d03cddeca96113f580f67b4364497472994cf41ca1766b`.
- Build tools: Rust 1.98.1 and wasm-bindgen 0.2.129. The supplied build occurred before the final commit; compiler-input hashes were checked against that commit. No Rust rebuild or source modification is part of this package integration.

`test/node/mpeg2.test.ts` imports the actual bundled package and verifies all 18 authored MXF frames against independent FFmpeg FAANI plane hashes, PCM hashes, individual and batched backward selections, native error behavior, timing, ownership, close during initialization, and more than 64 packets without reset. Browser canvas rendering requires separate real-browser verification; Node planar equality is not a canvas color-conversion proof.
