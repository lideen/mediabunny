---
description: Mediabunny supports a wide range of media container formats (.mp4, .webm, .mp3, .wav, .m3u8, ...) and video/audio codecs (H.264, HEVC, VP9, AV1, AAC, Opus, FLAC, ...).
---

# Supported formats & codecs
 
## Container formats

Mediabunny supports many commonly used media container formats, all of which are supported bidirectionally (reading & writing):

- ISOBMFF-based formats (.mp4, .m4v, .m4a, ...)
- QuickTime File Format (.mov)
- Segmented MP4 (CMAF) (.m4s)
- Matroska (.mkv)
- WebM (.webm)
- Ogg (.ogg)
- MP3 (.mp3)
- WAVE (.wav)
- ADTS (.aac)
- FLAC (.flac)
- MPEG Transport Stream (.ts)
- HLS (.m3u8)

### Experimental MXF input

MXF reading is opt-in with `new Input({ source, formats: [MXF] })`. Import `MXF` from `mediabunny`; it is not included in `ALL_FORMATS`. There is no MXF writer. `canRead()` recognizes the file signature; reading track metadata can still reject unsupported layouts.

The reader discovers tracks and extracts packets from finalized, seekable, self-contained OP1a files with a closed complete header at byte zero. It supports progressive, frame-wrapped ProRes, a limited AVC subset described below, and ST 382 AES/BWF packed 16/24/32-bit little-endian PCM. ST 331 AES3 subframe packing is not supported. ProRes decoding uses the existing `@mediabunny/prores` extension. AVC uses the browser's native WebCodecs decoder when available, without a decoder extension.

Color primaries, transfer characteristics, and matrix coefficients come from the first ProRes frame header or AVC SPS. MXF mastering-display and content-light metadata are not preserved.

The supported metadata graph has one material package, one file source package, and one untrimmed SourceClip per media track. Origin and StartPosition must be zero, material and source edit rates must match, and descriptors must identify their source tracks through LinkedTrackID. Interlaced/PsF pictures, offset display apertures, other wrapping or sound coding, external essence, source-clip channel selection, and more complex edits are rejected. ProRes also requires equal stored and display dimensions. AVC allows macroblock padding when its SPS display dimensions agree with the descriptor. Timecode components are exposed separately in `MetadataTags.raw` under `mxf.timecode.<track ID>`, not as audio tracks.

Indexed lookup discovers partitions from the trailing Random Index Pack, or from the header's footer pointer and previous-partition chain. RIP entries identify partitions, not frames. BodySID and IndexSID select the essence and index streams; BodyOffset maps index stream offsets into the appropriate physical partition. Supported index segments use fixed two-byte or BER local lengths, with non-reordered VBE entries or whole-container CBE edit-unit byte counts. CBE requires start position zero, duration zero or the full track duration, and no index entries or slices. The exceptional CBE layout with a different-sized first unit falls back to scanning. DeltaEntry and SliceOffset values locate individual elements, whose KLV keys identify the tracks.

Distributed indexes and repeated footer indexes are supported. On indexed lookup, scalar segment summaries are checked for ordering and overlap within each index partition. ProRes/PCM fetch the requested entries and their successors, not the complete entry array. Applicable repeated entries must resolve to the same essence location and size; conflicting copies are rejected. Indexed end-of-track trusts the declared duration and index coverage. It does not scan otherwise unreferenced trailing essence to validate the total picture count. Full sequential scans retain the picture-count check.

AVC accepts ST 381-3 default Annex B frame wrapping, essence-container label `060e2b340401010a0d01030102106001`, Main or High picture coding, progressive 8-bit 4:2:0 SPS, and closed GOPs whose random-access entries identify IDR pictures. It does not accept custom GOP wrapping, NAL-stream wrapping, open-GOP/recovery-only access points, AVC-Intra, 10-bit or interlaced AVC. Every key access unit must repeat SPS, PPS and IDR for native cold decoding. Metadata-only lookup requires the index SPS flag but does not inspect payloads. Full key-packet retrieval validates the presence of SPS/PPS/IDR and requires parameter-set bytes identical to the first access unit, allowing set order to differ. Configuration changes within a track are outside this subset. The reader does not rewrite packets or insert missing parameter sets. Encoded payloads remain Annex B; decoder configuration intentionally omits `description`, which would otherwise select length-prefixed AVC.

AVC requires VBE index entries with video DeltaEntry PosTableIndex -1, signed temporal/key offsets, and no temporal-offset overflow or fractional position tables. For presentation position `p`, the coded position is `d = p + TemporalOffset[p]`; the stream offset, flags and key offset come from entry `d`. Inverse lookup requires one match in the bounded presentation window `[d - 127, d + 128]`. Entries are fetched in contiguous blocks of 128 with at most 16 blocks cached. Missing coverage, ambiguous inverses and unsupported timing reject explicitly, never falling back to monotonic scanning. PCM's PosTableIndex 0 ignores video reordering. `sequenceNumber` and `getNextPacket()` use decode order; `timestamp` and `getPacket(t)` use presentation order. Key seeks return an IDR at or before the requested presentation timestamp. No public DTS field is added.

PCM uses indexed timing only when the descriptor explicitly marks audio as locked and the audio sample rate is an integer multiple of the edit rate. Each retrieved payload must contain exactly that number of sample frames. Fractional-rate PCM, unlocked PCM, missing index coverage, and unsupported index timing representations use sequential KLV discovery and actual payload sample counts. In particular, the reader does not infer or repeat a 29.97/59.94 fps audio cadence. Such fallback seeks can still inspect all preceding essence headers. Malformed index lengths, unsafe offsets, inconsistent partition pointers, and invalid slice references are errors, not reasons to invent packet timing.

Metadata-only packet retrieval does not request essence payloads. Decoder configuration separately reads the first 36 bytes of ProRes essence or the first AVC access unit. Structural prefetch uses bounded windows of up to 4 KiB inside metadata/index regions and, when its address is known, the footer, in addition to AVC entry blocks. Full indexed packet reads permit the source's existing forward prefetch up to the end of the containing body partition, allowing subsequent essence headers and interleaved tracks to reuse its cache. Sequential fallback without a known partition end keeps exact reads. No additional MXF playback buffer or prefetch setting is used. A source's own caching or read-ahead can transfer additional bytes; HTTP callers that need finite range requests can use `UrlSource`'s opt-in `rangePolicy`. The default HTTP policy can use open-ended requests, so the demuxer's read bounds are not a wire-byte limit. Header metadata is limited to 16 MiB, individual metadata sets to 1 MiB, and indexed partition directories to 10,000 entries. These are subset and resource limits, not a claim of general MXF support.

The node tests include a sparse 10 GB logical file without allocating its essence, CBE/VBE and BER-local indexes, partition-pointer fallback, malformed indexes, packet ownership, and measured source reads. Run `npm test -- node/mxf`. Set `MXF_PRORES_FIXTURE` to a local FFmpeg FATE `Meridian-Apple_ProResProxy-HDR10.mxf` file to enable the ProRes Proxy interoperability case. `MXF_GENERATED_FIXTURE` enables the independently probed 24-second, 720p25 ProRes LT/stereo PCM24 fixture case, including packet hashes across distributed index boundaries. Neither media file is included in the repository. These tests verify packet extraction and timing, not universal decoder or audio-playback compatibility.

AVC tests always run against synthetic index/Annex B fixtures, including cross-segment reordering, IDR preroll, fractional rates, corruption, disposal and sparse-file HTTP budgets. For real compressed essence, run `python3 test/node/generate-mxf-avc.py <new-directory>` with FFmpeg 7.1.1 and libx264, then set `MXF_AVC_FIXTURE` to the generated `SYNTHETIC-corrected-index-avc-high-720p25-g25-b2-pcm24.mxf`. The original file must remain beside it for the rejection test. FFmpeg 7.1.1 writes incorrect AVC B-frame index timing and reference-B flags. The script explicitly corrects only index bytes using independently decoded frame order and NAL reference flags, leaving all essence untouched. This is a synthetic corrected-index fixture, not evidence of real-producer MXF conformance. Fixed packet hashes in the opt-in test correspond to the recorded FFmpeg 7.1.1/libx264 build; encoder-version changes may change those hashes. Browser decoding and presentation need separate runtime verification.

## Codecs

Mediabunny supports a wide range of video, audio, and subtitle codecs. More specifically, it supports all codecs specified by the WebCodecs API and a few additional PCM codecs out of the box.

The availability of the codecs provided by the WebCodecs API depends on the browser and thus cannot be guaranteed by this library. Mediabunny provides [special utility functions](#querying-codec-encodability) to check which codecs are able to be encoded. You can also specify [custom coders](#custom-coders) to provide your own encoder/decoder implementation if the browser doesn't support the codec natively.

For precise definitions of each codec including the corresponding packet format, please refer to the [Mediabunny Codec Registry](/codec-registry/overview).

::: info
Mediabunny ships with built-in decoders and encoders for all audio PCM codecs, meaning they are always supported.
:::

### Video codecs

- `'avc'` - Advanced Video Coding (AVC) / H.264
- `'hevc'` - High Efficiency Video Coding (HEVC) / H.265
- `'vp8'` - VP8
- `'vp9'` - VP9
- `'av1'` - AOMedia Video 1 (AV1)
- `'prores'` - Apple ProRes [^prores]

### Audio codecs

- `'aac'` - Advanced Audio Coding (AAC) [^aac]
- `'opus'` - Opus
- `'mp3'` - MP3 [^mp3]
- `'vorbis'` - Vorbis
- `'flac'` - Free Lossless Audio Codec (FLAC) [^flac]
- `'ac3'` - Dolby Digital (AC-3) [^ac3]
- `'eac3'` - Dolby Digital Plus (E-AC-3) [^ac3]
- `'dts'` - DTS Coherent Acoustics [^dts]
- `'pcm-u8'` - 8-bit unsigned PCM
- `'pcm-s8'` - 8-bit signed PCM
- `'pcm-s16'` - 16-bit little-endian signed PCM
- `'pcm-s16be'` - 16-bit big-endian signed PCM
- `'pcm-s24'` - 24-bit little-endian signed PCM
- `'pcm-s24be'` - 24-bit big-endian signed PCM
- `'pcm-s32'` - 32-bit little-endian signed PCM
- `'pcm-s32be'` - 32-bit big-endian signed PCM
- `'pcm-f32'` - 32-bit little-endian float PCM
- `'pcm-f32be'` - 32-bit big-endian float PCM
- `'pcm-f64'` - 64-bit little-endian float PCM
- `'pcm-f64be'` - 64-bit big-endian float PCM
- `'ulaw'` - μ-law PCM
- `'alaw'` - A-law PCM

### Subtitle codecs

- `'webvtt'` - WebVTT

## Compatibility table

Not all codecs can be used with all containers. The following table specifies the supported codec-container combinations:

|                |   .mp4   | .mov  | .mkv  | .webm[^webm] | .ogg  | .mp3  | .wav  | .aac  | .flac |  .ts  |
|:--------------:|:--------:|:-----:|:-----:|:---------:|:-----:|:-----:|:-----:|:-----:|:-----:|:-----:|
| `'avc'`        |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |   ✓   |
| `'hevc'`       |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |   ✓   |
| `'vp8'`        |    ✓     |   ✓   |   ✓   |     ✓     |       |       |       |       |       |       |
| `'vp9'`        |    ✓     |   ✓   |   ✓   |     ✓     |       |       |       |       |       |       |
| `'av1'`        |    ✓     |   ✓   |   ✓   |     ✓     |       |       |       |       |       |       |
| `'prores'`     |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |       |
| `'aac'`        |    ✓     |   ✓   |   ✓   |           |       |       |       |   ✓   |       |   ✓   |
| `'opus'`       |    ✓     |   ✓   |   ✓   |     ✓     |   ✓   |       |       |       |       |       |
| `'mp3'`        |    ✓     |   ✓   |   ✓   |           |       |   ✓   |       |       |       |   ✓   |
| `'vorbis'`     |    ✓     |   ✓   |   ✓   |     ✓     |   ✓   |       |       |       |       |       |
| `'flac'`       |    ✓     |   ✓   |   ✓   |           |       |       |       |       |   ✓   |       |
| `'ac3'`        |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |   ✓   |
| `'eac3'`       |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |   ✓   |
| `'dts'`        |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |   ✓   |
| `'pcm-u8'`     |          |   ✓   |   ✓   |           |       |       |   ✓   |       |       |       |
| `'pcm-s8'`     |          |   ✓   |       |           |       |       |       |       |       |       |
| `'pcm-s16'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |       |
| `'pcm-s16be'`  |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |       |
| `'pcm-s24'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |       |
| `'pcm-s24be'`  |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |       |
| `'pcm-s32'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |       |
| `'pcm-s32be'`  |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |       |
| `'pcm-f32'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |       |
| `'pcm-f32be'`  |    ✓     |   ✓   |       |           |       |       |       |       |       |       |
| `'pcm-f64'`    |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |       |
| `'pcm-f64be'`  |    ✓     |   ✓   |       |           |       |       |       |       |       |       |
| `'ulaw'`       |          |   ✓   |       |           |       |       |   ✓   |       |       |       |
| `'alaw'`       |          |   ✓   |       |           |       |       |   ✓   |       |       |       |
| `'webvtt'`[^webvtt] |   (✓)    |       |  (✓)  |    (✓)    |       |       |       |       |       |       |

For HLS, the supported codecs depend on the segment format chosen.

[^prores]: ProRes is not supported by WebCodecs. To decode it, use the [`@mediabunny/prores`](./extensions/prores) extension package. The [`@mediabunny/server`](./extensions/server) extension package provides both decoding and encoding support for server-side environments.
[^aac]: In some browsers, AAC encoding is not supported by WebCodecs. You can polyfill it with the [`@mediabunny/aac-encoder`](./extensions/aac-encoder) extension package.
[^mp3]: MP3 encoding is not supported by WebCodecs. You can polyfill it with the [`@mediabunny/mp3-encoder`](./extensions/mp3-encoder) extension package.
[^flac]: FLAC encoding is not supported by WebCodecs. You can polyfill it with the [`@mediabunny/flac-encoder`](./extensions/flac-encoder) extension package.
[^ac3]: AC-3 and E-AC-3 are not natively supported by WebCodecs. To encode or decode these codecs, you can use the [`@mediabunny/ac3`](./extensions/ac3) extension package.
[^dts]: DTS is not natively supported by WebCodecs. To encode or decode it, you can use the [`@mediabunny/dts`](./extensions/dts) extension package.
[^webm]: WebM only supports a small subset of the codecs supported by Matroska. However, this library can technically read all codecs from a WebM that are supported by Matroska.
[^webvtt]: WebVTT can only be written, not read.

## Querying codec encodability

Mediabunny provides utility functions that you can use to check if the browser can encode a given codec. Additionally, you
can check if a codec is encodable with a specific _configuration_.

`canEncode` tests whether a codec can be encoded using typical settings:
```ts
import { canEncode } from 'mediabunny';

canEncode('avc'); // => Promise<boolean>
canEncode('opus'); // => Promise<boolean>
```
Video codecs are checked using 1280x720, while audio codecs are checked using 2 channels at 48 kHz.

You can also check encodability using specific configurations:
```ts
import { canEncodeVideo, canEncodeAudio, Quality } from 'mediabunny';

canEncodeVideo('hevc', {
	width: 1920, height: 1080, frameRate: 60, quality: new Quality({ bitrate: 1e7 })
}); // => Promise<boolean>

canEncodeAudio('aac', {
	numberOfChannels: 1, sampleRate: 44100, quality: new Quality({ bitrate: 192e3 })
}); // => Promise<boolean>
```

Additionally, most properties of [`VideoEncodingConfig`](./media-sources#video-encoding-config) and [`AudioEncodingConfig`](./media-sources#audio-encoding-config) can be used here as well.

---

In addition, you can use the following functions to check encodability for multiple codecs at once, getting back a list of supported codecs:
```ts
import {
	getEncodableCodecs,
	getEncodableVideoCodecs,
	getEncodableAudioCodecs,
	getEncodableSubtitleCodecs,
	Quality,
} from 'mediabunny';

getEncodableCodecs(); // => Promise<MediaCodec[]>
getEncodableVideoCodecs(); // => Promise<VideoCodec[]>
getEncodableAudioCodecs(); // => Promise<AudioCodec[]>
getEncodableSubtitleCodecs(); // => Promise<SubtitleCodec[]>

// These functions also accept optional configuration options.
// Here, we check which of AVC, HEVC and VP8 can be encoded at 1920x1080 @10Mbps:
getEncodableVideoCodecs(
	['avc', 'hevc', 'vp8'],
	{ width: 1920, height: 1080, quality: new Quality({ bitrate: 1e7 }) },
); // => Promise<VideoCodec[]>
```

---

If you simply want to find the best codec that the browser can encode, you can use these functions, which return the first codec supported by the browser:
```ts
import {
	getFirstEncodableVideoCodec,
	getFirstEncodableAudioCodec,
	getFirstEncodableSubtitleCodec,
	Quality,
} from 'mediabunny';

getFirstEncodableVideoCodec(['avc', 'vp9', 'av1']); // => Promise<VideoCodec | null>
getFirstEncodableAudioCodec(['opus', 'aac']); // => Promise<AudioCodec | null>

getFirstEncodableVideoCodec(
	['avc', 'hevc', 'vp8'],
	{ width: 1920, height: 1080, quality: new Quality({ bitrate: 1e7 }) },
); // => Promise<VideoCodec | null>
```

If none of the listed codecs is supported, `null` is returned.

These functions are especially useful in conjunction with an [output format](./output-formats) to retrieve the best codec that is supported both by the encoder as well as the container format:
```ts
import {
	Mp4OutputFormat,
	getFirstEncodableVideoCodec,
} from 'mediabunny';

const outputFormat = new Mp4OutputFormat();
const containableVideoCodecs = outputFormat.getSupportedVideoCodecs();
const bestVideoCodec = await getFirstEncodableVideoCodec(containableVideoCodecs);
```

::: info
Codec encodability checks take [custom encoders](#custom-encoders) into account.
:::

## Querying codec decodability

If you already have an `InputTrack`, you can check its decodability using its [`canDecode`](./reading-media-files#codec-information) method, which uses the track's actual codec configuration:
```ts
const canDecodeTrack = await inputTrack.canDecode(); // => boolean
```

However, you can also gauge decodability even in the absence of any concrete track. `canDecode` tests whether a codec can be decoded using typical settings:
```ts
import { canDecode } from 'mediabunny';

canDecode('avc'); // => Promise<boolean>
canDecode('opus'); // => Promise<boolean>
```
Video codecs are checked using 1280x720, while audio codecs are checked using 2 channels, 48 kHz.

You can also check decodability using specific configurations:
```ts
import { canDecodeVideo, canDecodeAudio } from 'mediabunny';

canDecodeVideo('hevc', {
	codedWidth: 1920, codedHeight: 1080
}); // => Promise<boolean>

canDecodeAudio('aac', {
	numberOfChannels: 1, sampleRate: 44100
}); // => Promise<boolean>
```

All additional properties of [`VideoDecoderConfig`](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure#config) and [`AudioDecoderConfig`](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder/configure#config) can be used here as well.

---

In addition, you can use the following functions to check decodability for multiple codecs at once, getting back a list of supported codecs:
```ts
import {
	getDecodableCodecs,
	getDecodableVideoCodecs,
	getDecodableAudioCodecs,
} from 'mediabunny';

getDecodableCodecs(); // => Promise<MediaCodec[]>
getDecodableVideoCodecs(); // => Promise<VideoCodec[]>
getDecodableAudioCodecs(); // => Promise<AudioCodec[]>

// These functions also accept optional configuration options.
// Here, we check which of AVC, HEVC and VP8 can be decoded at 1920x1080:
getDecodableVideoCodecs(
	['avc', 'hevc', 'vp8'],
	{ codedWidth: 1920, codedHeight: 1080 },
); // => Promise<VideoCodec[]>
```

::: info
Codec decodability checks take [custom decoders](#custom-decoders) into account.
:::

## Custom coders

Mediabunny allows you to register your own custom encoders and decoders - useful if you want to polyfill a codec that's not supported in all browsers, or want to use Mediabunny outside of an environment with WebCodecs (such as Node.js).

Encoders and decoders can be registered for [all video and audio codecs](#codecs) supported by the library. It is not possible to add new codecs.

::: warning
Mediabunny requires customs encoders and decoders to follow very specific implementation rules. Pay special attention to the parts labeled with "**must**" to ensure compatibility.
:::

### Custom encoders

To create a custom video or audio encoder, you'll need to create a class which extends `CustomVideoEncoder` or `CustomAudioEncoder`. Then, you **must** register this class using `registerEncoder`:
```ts
import { CustomAudioEncoder, registerEncoder } from 'mediabunny';

class MyAwesomeMp3Encoder extends CustomAudioEncoder {
	// ...
}
registerEncoder(MyAwesomeMp3Encoder);
```

The following properties are available on each encoder instance and are set by the library:
```ts
class {
	// For video encoders:
	codec: VideoCodec;
	config: VideoEncoderConfig;
	onPacket: (packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) => unknown;

	// For audio encoders:
	codec: AudioCodec;
	config: AudioEncoderConfig;
	onPacket: (packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) => unknown;

	// For both:
	onError: (error: unknown) => void;
}
```

`codec` and `config` specify the concrete codec configuration to use, and `onPacket` is a method that your code **must** call for each encoded packet it creates. `onError` is a method you can call to surface any out-of-band errors that occur outside of the regular method calls (such as from an asynchronous background task); these errors would otherwise go uncaught.

You **must** implement the following methods in your custom encoder class:
```ts
class {
	// For video encoders:
	static supports(codec: VideoCodec, config: VideoEncoderConfig): boolean;
	// For audio encoders:
	static supports(codec: AudioCodec, config: AudioEncoderConfig): boolean;

	init(): Promise<void> | void;
	encode(sample: VideoSample, options: VideoEncoderEncodeOptions): Promise<void> | void; // For video
	encode(sample: AudioSample): Promise<void> | void; // For audio
	flush(): Promise<void> | void;
	close(): Promise<void> | void;
}
```
- `supports`\
	This is a *static* method that **must** return `true` if the encoder is able to encode the specified codec, and `false` if not. If it returns `true`, a new instance of your encoder class will be created by the library and will be used for encoding, taking precedence over the default encoders.
- `init`\
	Called by the library after your class is instantiated. Place any initialization logic here.
- `encode`\
	Called for each sample that is to be encoded. The resulting encoded packet **must** then be passed to the `onPacket` method.
- `flush`\
	Called when the encoder is expected to finish the encoding process for all remaining samples that haven't finished encoding yet. This method **must** return/resolve only once all samples passed to `encode` have been fully encoded. It **must** then reset its own internal state to be ready for the next encoding batch.
- `close`\
	Called when the encoder is no longer needed and can release its internal resources.

::: info
All instance methods of the class can return promises. In this case, the library will make sure to *serialize* all method calls such that no two methods ever run concurrently.
:::

::: warning
The packets passed to `onPacket` **must** be in [decode order](./media-sinks.md#decode-vs-presentation-order).
:::

### Custom decoders

To create a custom video or audio decoder, you'll need to create a class which extends `CustomVideoDecoder` or `CustomAudioDecoder`. Then, you **must** register this class using `registerDecoder`:
```ts
import { CustomAudioDecoder, registerDecoder } from 'mediabunny';

class MyAwesomeMp3Decoder extends CustomAudioDecoder {
	// ...
}
registerDecoder(MyAwesomeMp3Decoder);
```

The following properties are available on each decoder instance and are set by the library:
```ts
class {
	// For video decoders:
	codec: VideoCodec;
	config: VideoDecoderConfig;
	onSample: (sample: VideoSample) => unknown;

	// For audio decoders:
	codec: AudioCodec;
	config: AudioDecoderConfig;
	onSample: (sample: AudioSample) => unknown;

	// For both:
	onError: (error: unknown) => void;
}
```

`codec` and `config` specify the concrete codec configuration to use, and `onSample` is a method that your code **must** call for each video/audio sample it creates. `onError` is a method you can call to surface any out-of-band errors that occur outside of the regular method calls (such as from an asynchronous background task); these errors would otherwise go uncaught.

You **must** implement the following methods in your custom decoder class:
```ts
class {
	// For video decoders:
	static supports(codec: VideoCodec, config: VideoDecoderConfig): boolean;
	// For audio decoders:
	static supports(codec: AudioCodec, config: AudioDecoderConfig): boolean;

	init(): Promise<void> | void;
	decode(packet: EncodedPacket): Promise<void> | void;
	flush(): Promise<void> | void;
	close(): Promise<void> | void;
}
```
- `supports`\
	This is a *static* method that **must** return `true` if the decoder is able to decode the specified codec, and `false` if not. If it returns `true`, a new instance of your decoder class will be created by the library and will be used for decoding, taking precedence over the default decoders.
- `init`\
	Called by the library after your class is instantiated. Place any initialization logic here.
- `decode`\
	Called for each `EncodedPacket` that is to be decoded. The resulting video or audio sample **must** then be passed to the `onSample` method.
- `flush`\
	Called when the decoder is expected to finish the decoding process for all remaining packets that haven't finished decoding yet. This method **must** return/resolve only once all packets passed to `decode` have been fully decoded. It **must** then reset its own internal state to be ready for the next decoding batch.
- `close`\
	Called when the decoder is no longer needed and can release its internal resources.

::: info
All instance methods of the class can return promises. In this case, the library will make sure to *serialize* all method calls such that no two methods ever run concurrently.
:::

::: warning
The samples passed to `onSample` **must** be sorted by increasing timestamp. This especially means if the decoder is decoding a video stream that makes use of [B-frames](./media-sources.md#b-frames), the decoder **must** internally hold on to these frames so it can emit them sorted by presentation timestamp. This strict sorting requirement is reset each time `flush` is called.
:::
