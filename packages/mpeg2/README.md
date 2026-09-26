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

## Supported input and ownership

The MXF subset includes progressive MPEG-2 Main Profile / High or High-1440 Level, 8-bit 4:2:0 in indexed OP1a frame wrapping. Those open-flag GOPs still require a per-restart proof of unreordered I/P-only index entries and actual picture headers through the next key or track end, at most 128 pictures. The additional 4:2:2 Profile / High Level path accepts frame pictures, including woven interlaced output, with explicit open-GOP dependency planning. Restart anchors carry in-band sequence, extension, GOP and I-picture headers. The generic packet classifier still returns `null` for open-flag I pictures; MXF owns the index and header proof.

Stored macroblock padding may exceed visible dimensions, with zero sampled/display offsets and matching sampled/display rectangles. Decoder configuration and owned planes use visible sequence dimensions. FrameLayout 1 descriptor heights are per-field and become full-frame heights. This is not Sony D-10 or LXF support. Separate field pictures, repeated-field cadence, scalable coding, other profiles/levels and incomplete headers remain unsupported.

The adapter outputs owned planar I420 or I422 `VideoSample`s. Native per-picture flags set `scan` to progressive, interlaced-top-first or interlaced-bottom-first. Interlaced samples retain woven lines at the original frame rate; no deinterlacing is performed. Canvas and VideoFrame conversions do not retain this scan metadata. Native `takeY`, `takeCb`, and `takeCr` transfer independent JS plane copies; the adapter combines them using the reported strides and frees each Rust frame in `finally`. Held samples survive later decode, flush, close, and input disposal. Color metadata is forwarded from decoder configuration without filling in unspecified primaries or transfer.

Packet timing passes directly to `decode(bytes, { timestamp, duration })`. The native decoder associates delayed frames with their packets and returns display-ordered timed output. The adapter neither sorts temporal references nor maintains a timestamp map, packet history, or second operation queue.

The embedded 150,344-byte module is compiled lazily, shared between decoder instances, and loaded without fetches. Each decoder owns its own native references. Input and padded frame budgets are 8 MiB each; native reference storage is bounded to 24 MiB per decoder. Width is at most 4096 and height at most 2304, subject to the tighter padded-frame budget. There is no 64-picture lifetime cap. Authored tests and bounded local 1080p I422 selections provide targeted evidence, not general MPEG-2 conformance certification.

## Selection lifecycle

`flush()` uses `finishSegment()`, captures the pending complete anchor, resets the native decoder, then emits the captured frame. It intentionally permits a selection such as I0/P3/B1 to stop before B2. It is not an end-of-stream integrity check. Strict `drain()` is not used. Each subsequent segment starts from a new backing-owned decode plan. No headers are synthesized from `config.description`.

Both sample iteration paths execute explicit header-only preroll through the existing decoder call serializer. Only consecutive initial cold-open-GOP leading Bs strictly before the requested selection may be discarded. `discardLeadingB` retains persistent matrix updates without reconstructing pixels or claiming entropy validation. Requested leading Bs use the previous dependency anchor instead. Decoders without this capability fail explicitly. Ordinary encoded-packet iteration never omits these packets. Index inversion uses a 256-entry window and rejects dependencies that cannot be proved there; it does not fall back to decoding from frame zero.

Malformed native pictures throw sticky errors. A failed finish does not reset away that error. Close frees references without draining, is idempotent, and invalidates pending lazy initialization. Native decode itself is synchronous and cannot be interrupted mid-call. Closing from a sample callback suppresses any remaining output from that call and frees its frames.

`Mpeg2Decoder` is also exported for applications already supplying complete elementary-picture packets. Direct callers set the inherited `codec`, `config`, `onSample`, and `onError` fields through their custom-coder setup, serialize calls, and close the decoder. Capability checks retain the I420 geometry envelope. Native parsing enforces the actual chroma-specific padded-frame budget before allocation; configuration geometry alone does not prove I422 will fit.

## Provenance and validation

`vendor/PROVENANCE.json` records the source commit, source/compiler hashes, dependency license metadata, original build-record hash, and every copied artifact hash. Upstream files are unmodified; only `vendor/js/index.d.mts` is an adapter-authored declaration for the used facade API. The license-header checker visits `src` only, never `vendor`. Bundle banners retain the distribution restriction and exact WASM identity.

- Source commit: `1a9e585a52dcce079ca2543abe59aef50551f59a`.
- WASM SHA-256: `c9caeab946aa20774c8404066bfe6dcc2bb5a8aac0be670e7ffa2d83df0cfe08`.
- Build tools: Rust 1.98.1 and wasm-bindgen 0.2.129. The supplied build occurred before the final commit; compiler-input hashes were checked against that commit. No Rust rebuild or source modification is part of this package integration.

`test/node/mpeg2.test.ts` imports the actual bundled package and verifies all 18 authored MXF frames against independent FFmpeg FAANI plane hashes, PCM hashes, individual and batched backward selections, native error behavior, timing, ownership, close during initialization, and more than 64 packets without reset. Browser canvas rendering requires separate real-browser verification; Node planar equality is not a canvas color-conversion proof.
