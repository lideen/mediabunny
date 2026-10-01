---
description: Optional MPEG-2 WASM decoding for indexed MXF input.
---

# @mediabunny/mpeg2

The optional `@mediabunny/mpeg2` workspace package provides MPEG-2 decoding through Mediabunny's custom decoder API. MXF is included in `ALL_FORMATS`; container discovery and packet extraction do not require decoder registration. Decoding requires an explicit call to `registerMpeg2Decoder()` before using a sample sink.

```ts
import { Input, ALL_FORMATS, BufferSource, VideoSampleSink } from 'mediabunny';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';

registerMpeg2Decoder();
using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
if (track) {
    using sample = await new VideoSampleSink(track).getSample(1 / 25);
    // Read or draw the sample here.
}
```

Explicit `formats: [MXF]` remains valid when only MXF input is needed. Registration is idempotent, accepts no arguments, and enables neither encoding nor muxing. The package retains its `private: true` and `UNLICENSED` metadata and supplied notices. Publication authorization does not change those license declarations.

## Supported MPEG-2 input

The MXF subset requires finalized, seekable, self-contained OP1a input with a known size, a closed complete header, simple untrimmed source clips, and supported temporal indexes. MPEG-2 essence must be frame-wrapped with an MPEGVideoDescriptor and container label `060e2b34040101020d01030102046001`.

Supported picture-coding/profile-level pairs are:

| Picture-coding label | Profile/level byte | Picture format |
| --- | --- | --- |
| `060e2b34040101030401020201030300` | `44` | Main Profile, High Level, progressive 8-bit 4:2:0 |
| `060e2b34040101030401020201050300` | `46` | Main Profile, High-1440 Level, progressive 8-bit 4:2:0 |
| `060e2b34040101030401020201040300` | `82` | 4:2:2 Profile, High Level, progressive or interlaced 8-bit frame pictures |

Per-field descriptor heights report full-frame visible dimensions. Stored dimensions may include macroblock padding; sampled/display rectangles must agree and have zero offsets. Separate field pictures, repeated fields, scalable coding, and D-10 are unsupported.

Headers are checked against index picture types, timestamps, descriptor geometry, rate, aspect, and profile. Each restart carries sequence, sequence-extension, GOP, and I-picture headers. Parsing is limited to 512 bytes before the first slice. Closed GOPs support I/P/B pictures. Main-profile open-flag GOPs require an unreordered I/P-only interval proven through the next key or track end, bounded to 128 pictures plus the boundary entry. An isolated open-flag I picture is not enough to prove a safe restart.

For profile `82`, requested leading B pictures require an earlier valid anchor. Only initial, unrequested leading Bs before the selection minimum use header-only preroll. This preserves persistent codec state, including matrix updates, without reconstructing those pictures. Packet sinks still expose every complete source packet. Header-only preroll does not establish entropy validity or decoded-picture accuracy.

For presentation ordinal `p`, decode ordinal is `d = p + TemporalOffset[p]`. Inversion searches `[d - 127, d + 128]` and requires a unique match. Missing coverage or dependencies outside that window reject without scanning from zero. Packet iteration and `sequenceNumber` use decode order; timestamps use presentation order.

Metadata-only MPEG-2 reads inspect up to 512 payload bytes per validated picture. This is a demuxer read bound, not an HTTP traffic bound. Source-managed prefetch can transfer additional bytes.

The separate opt-in [LXF input](../supported-formats-and-codecs#experimental-lxf-input) uses this decoder for a narrower finite, single-segment, version-1 subset: 25 fps closed all-I profile-82 frame pictures with temporal reference zero and planar PCM24 audio. Use `formats: [LXF]`; LXF is not included in `ALL_FORMATS`. Container timestamps come from the 720 kHz wire clock. This adds no native decoder fallback, output format or license grant.

## Decoding and browser execution

The standalone `mpeg2-wasm` decoder embeds its scalar/shared WASM and worker graph. No assets URL or external runtime directory is needed. Every execution mode requires WebAssembly SIMD128. It selects direct execution when browser Workers are unavailable, a serial worker without cross-origin isolation, or an automatically sized slice pool when shared memory is available. Browser CSP must permit WebAssembly compilation and Blob module workers. Pooling requires cross-origin isolation, normally with these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Samples own their I420 or I422 pixels. `VideoSample.scan` preserves progressive status or woven-picture field order, including on clones. Canvas and VideoFrame conversion do not deinterlace or retain that metadata. Video/canvas sample selections accept an AbortSignal; abort and Input disposal cancel supported pending decoder work without changing source-range policies.

The package README records the pinned artifact, ownership tradeoff, provenance, and validation commands. Numerical-version hashes are regression expectations, not independent conformance oracles. Independent FFprobe manifests verify packet bytes and timing; the gray interlaced fixture also checks FAANI pixel hashes. Browser worker/pool execution requires separate validation, and no real-time playback or complete H.262 conformance claim is made.
