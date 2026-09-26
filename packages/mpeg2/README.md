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

The verified MXF subset is progressive MPEG-2 Main Profile / High Level, 8-bit 4:2:0 in indexed OP1a frame wrapping, with complete in-band sequence, extension and closed-GOP headers on every restart key. It uses the core's MPEGVideoDescriptor and index validation. This is not Sony D-10 support. Interlaced frames, 4:2:2, field pictures, repeated-field cadence, scalable coding, other profiles/levels and incomplete headers are not part of this MXF integration.

The adapter outputs planar I420 `VideoSample`s. Native `takeY`, `takeCb`, and `takeCr` transfer independent JS plane copies; the adapter combines them using the reported strides, creates an owned sample and frees each Rust frame in `finally`. Held samples survive later decode, flush, close, and input disposal. Color metadata is forwarded from decoder configuration without filling in unspecified primaries or transfer. The authored fixture specifies limited-range BT.709 matrix only.

Packet timing passes directly to `decode(bytes, { timestamp, duration })`. The native decoder associates delayed frames with their packets and returns display-ordered timed output. The adapter neither sorts temporal references nor maintains a timestamp map, packet history, or second operation queue.

The embedded 144,915-byte module is compiled lazily, shared between decoder instances, and loaded without fetches. Each decoder owns its own native references. Input and padded frame budgets are 8 MiB each; native reference storage is bounded to 24 MiB per decoder. Width is at most 4096 and height at most 2304, subject to the tighter padded-frame budget. There is no 64-picture lifetime cap. These limits admit the authored 720p fixture and 1080p I420 geometry; this integration's pixel acceptance fixture is 720p, not a general 1080p conformance claim.

## Selection lifecycle

`flush()` uses `finishSegment()`, captures the pending complete anchor, resets the native decoder, then emits the captured frame. It intentionally permits a selection such as I0/P3/B1 to stop before B2. It is not an end-of-stream integrity check. Strict `drain()` is not used. Each subsequent segment must start with a genuine independently decodable key containing its sequence/GOP headers. No headers are synthesized from `config.description`.

Malformed native pictures throw sticky errors. A failed finish does not reset away that error. Close frees references without draining, is idempotent, and invalidates pending lazy initialization. Native decode itself is synchronous and cannot be interrupted mid-call. Closing from a sample callback suppresses any remaining output from that call and frees its frames.

`Mpeg2Decoder` is also exported for applications already supplying complete elementary-picture packets. Direct callers set the inherited `codec`, `config`, `onSample`, and `onError` fields through their custom-coder setup, serialize calls, and close the decoder. The same progressive I420 output restrictions apply. Capability checks validate configuration geometry; actual syntax support is determined by decoding, not by `supports()`.

## Provenance and validation

`vendor/PROVENANCE.json` records the source commit, source/compiler hashes, dependency license metadata, original build-record hash, and every copied artifact hash. Upstream files are unmodified; only `vendor/js/index.d.mts` is an adapter-authored declaration for the used facade API. The license-header checker visits `src` only, never `vendor`. Bundle banners retain the distribution restriction and exact WASM identity.

- Source commit: `4aa77ea2d6bcc6a5904790d72bea54e2f18000f3`.
- WASM SHA-256: `85cdf25a0ea5a94ffb28dee6930972f8a4424dca8e63ade45a91d0678a752a2f`.
- Build tools: Rust 1.98.1 and wasm-bindgen 0.2.129. The supplied build occurred before the final commit; compiler-input hashes were checked against that commit. No Rust rebuild or source modification is part of this package integration.

`test/node/mpeg2.test.ts` imports the actual bundled package and verifies all 18 authored MXF frames against independent FFmpeg FAANI plane hashes, PCM hashes, individual and batched backward selections, native error behavior, timing, ownership, close during initialization, and more than 64 packets without reset. Browser canvas rendering requires separate real-browser verification; Node planar equality is not a canvas color-conversion proof.
