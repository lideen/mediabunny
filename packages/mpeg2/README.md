# Private MPEG-2 decoder extension

This package is `private: true` and `UNLICENSED`. Do not publish it or bundles containing its decoder. MPL-2.0 covers the Mediabunny adapter source, not the Rust decoder, generated bindings, or standalone JavaScript runtime. Dependency licenses do not authorize distribution of the combined package.

```ts
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import { Input, ALL_FORMATS, BufferSource, VideoSampleSink } from 'mediabunny';

registerMpeg2Decoder();
using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
if (track) {
    using sample = await new VideoSampleSink(track).getSample(1 / 25);
    // Read or draw the sample here.
}
```

`registerMpeg2Decoder()` is the only package export. It accepts no arguments and repeated calls are idempotent. Call it before decoding through `VideoSampleSink` or `CanvasSink`. Neither core nor the server extension registers it. MXF is included in `ALL_FORMATS`, so container discovery does not require decoder registration. Explicit `formats: [MXF]` remains valid when only MXF input is needed. There is no MPEG-2 encoder, muxer, native WebCodecs fallback, or FFmpeg fallback.

## Runtime and ownership

Each adapter instance calls the standalone `Decoder.create()` with an AbortSignal and 8 MiB packet/frame budgets. It leaves execution selection to that factory:

| Environment | Execution |
| --- | --- |
| No browser Worker | Direct in the calling realm |
| Worker without cross-origin isolation or SharedArrayBuffer | One serial worker |
| Worker with cross-origin isolation and SharedArrayBuffer | Automatic slice-pool sizing |

Automatic sizing selects the largest supported 1, 2, or 4 not exceeding a valid positive integer `navigator.hardwareConcurrency`, defaulting to 1 for an invalid hint. Pools with 2 or 4 workers also use a coordinator. Each decoder owns its workers; there is no global shared pool or Node `worker_threads` backend. Startup failure rejects rather than retrying another backend.

The artifact embeds its scalar/shared WASM and worker graph. No assets URL, copied runtime directory, or CDN is needed. Every execution mode requires WebAssembly SIMD128. Browser CSP must permit WebAssembly compilation and Blob module workers. Pooling requires cross-origin isolation, normally `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, with compatible resource policies. These capabilities do not promise real-time playback or optimal throughput.

The adapter produces owned I420 or I422 samples at visible dimensions. It concatenates decoded planes into a dedicated buffer and transfers that buffer into `VideoSample`, avoiding a second full-frame allocation and copy. Environments without `structuredClone` use the existing copying constructor. Plane concatenation and sample cloning still copy pixels; this is not an end-to-end zero-copy path. Samples and clones remain readable after the decoder and Input close.

`VideoSample.scan` preserves progressive status or woven-picture temporal field order. It defaults to `unknown` for other producers. Cloning preserves it; Canvas and VideoFrame conversions do not deinterlace or retain the metadata. Separate field pictures and repeated fields are not supported by the MXF subset.

Selection flushes finish a pending anchor and reset decoder state without requiring a complete elementary-stream drain. Header-only preroll consumes initial unrequested B-picture headers, preserving matrix updates without reconstructing those pictures. Packet sinks still return every complete packet.

Video and canvas selection options accept `signal`. Abort, iterator return, and Input disposal stop sample delivery and invoke the optional `CustomVideoDecoder.cancel()` hook immediately. Serialized work then settles before close. Source reads already in progress may finish; this integration adds no packet-range or source cancellation policy. Decode and initialization failures still release decoder resources.

## Pinned artifact

The complete 62-file `mpeg2-wasm@0.0.0` producer artifact is in `vendor/decoder`, including rolled-up declarations, package marker, notices, 55 license texts, and immutable schema-2 producer provenance. The BSD-3-Clause BRiDCT attribution and license are retained. [The import record](vendor/PROVENANCE.json) identifies clean packaging commit `9a19284b8944ad43aa3a632e6198016f5c312d0f` in `lideen/mpeg2-wasm` and module SHA-256 `fe44f50903ead53bd9890ef8e66c7d8379a75d0ba7bd66ecec9beb2d74eac80f`.

That packaging build used pinned WASM; it did not rebuild Rust. The WASM source was revision `ed40e8a14bdd1ce0f80f839c940042b7dfe40a55` with uncommitted changes, identified by source snapshot digest `e0c101161fb9dc2a0a524f589a9c2319e1e45bdf6a92eb6a62392f50cf1c1ec4`. The compact producer record retains input/output identities, packaging-source digest, vendor-manifest digest, and external qualification record identities rather than the original source snapshots. Paths in that record and inherited notices identify producer inputs, not files this consumer must provide.

`scripts/mpeg2-artifact.ts` verifies all producer output lengths/hashes, the approved module pin, and the embedded scalar/shared WASM identities before bundling. Builds copy provenance, notices, and licenses beside the bundles. They do not compile Rust or fetch a sibling repository. Retired `vendor/pkg`, `vendor/js`, `vendor/threads`, and historical numerical reports are not included.

The numerical version is now `bridct-f32-simd128-dc-v1`, replacing `h262-butterfly-q14-q5-v1`. This changes decoder arithmetic and pixel results. `test/fixtures/mpeg2/wasm-bridct-v1.json` records regression expectations generated with this exact decoder on the existing demuxed packets, not independent accuracy oracles. It identifies the module and embedded WASM used to generate the expectations.

Producer provenance records `locally-qualified-not-product-release` and numerical engineering gate SHA-256 `b8f21a882b236de47c8bb9f6b90d17f0bfa62ce4f6504bbcf311bbf87c92696e`. That external gate was not rerun for this import and does not establish IEEE 1180/H.262 A.2 conformance.

FFprobe packet/timing manifests and FFmpeg FAANI pixel manifests are independent references. All 144 frames across the five existing media fixtures matched FFmpeg 7.1.1 FAANI output byte-for-byte during this import. Regular tests retain the numerical-version regression hashes and independent references. These finite fixtures do not establish general FAANI equivalence, IEEE 1180, complete H.262 conformance, deinterlacing quality, or paced playback performance.

## Verification

From the repository root:

```sh
npm ci
npm run pre-test
npx vitest run --project=node test/node/mpeg2 test/node/mxf-mpeg2
npm run check
npm run build
npm run lint
npm run test-node
npx vitest run --config test/mpeg2-browser.config.ts
```

Node tests decode progressive, padded, interlaced, and open-GOP fixtures through real public sinks. They cover timing, seeks, ownership, malformed pictures, callback failures, and factory lifecycle. Node worker-cancellation tests deliberately block the Worker transport; they prove cancellation plumbing, not worker pixel decoding. The separate browser suite checks real serial-worker/pool decoding and termination. Its isolation headers do not change the upstream browser runner. A failed browser launch is a verification gap, not a passing worker test.

Fixtures are committed. Optional regeneration is described in their READMEs; regular tests and builds need neither FFmpeg nor the producer repository.
