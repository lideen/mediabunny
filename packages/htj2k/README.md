# @mediabunny/htj2k

Optional complete-frame HTJ2K decoding for Mediabunny. The extension bundles a pinned scalar OpenJPH WebAssembly decoder. Core Mediabunny does not import it.

```ts
import { Input, MXF, UrlSource, VideoSampleSink } from 'mediabunny';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';

registerHtj2kDecoder();
const input = new Input({
	formats: [MXF],
	source: new UrlSource(url, { requestInit: { mode: 'cors' } }),
});
const track = await input.getPrimaryVideoTrack();
if (track && await track.canDecode()) {
	const sample = await new VideoSampleSink(track).getSample(10);
	// Consume the sample, then close it and dispose the input.
	sample?.close();
}
input.dispose();
```

MXF is opt-in. The existing `examples/media-player` registers the extension alongside ProRes. Registration is idempotent and does not initialize WASM. Initialization is lazy, shared between decoder instances, and retried after failure. The bundles embed the WASM bytes, so there is no runtime asset URL, worker, SIMD requirement, or sibling-checkout dependency.

## Supported input

- Finalized, seekable OP1a MXF with frame-wrapped HTJ2K essence, RGBA descriptor, progressive RGB8 or RGB16, full component range, and BT.709 primaries and transfer.
- Three unsigned full-resolution components, one full-image tile and one tile-part, one quality layer, reversible 5/3 transform, up to six decompositions, and HT-only code blocks up to 64×64. RPCL and the other standard progression orders are accepted. The decoder applies the codestream's inverse color transform once.
- At most 8192 pixels on either axis, 16,777,216 pixels per image, and 128 MiB per compressed frame. These bounds are checked before native frame allocation.

Unsupported inputs fail rather than being reinterpreted as ProRes, YCbCr, XYZ, or signed RGB. Tile-header overrides, mixed HT/legacy blocks, lossy coding, subsampling, cropping, and interlacing are outside this initial profile. Encoded packets retain the complete original codestream, key-frame status, edit-unit timestamp, and duration. Metadata-only packet reads use a bounded KLV header probe of at most 25 bytes, clamped to EOF. This can include up to eight initial value bytes but does not request the frame payload or a decoder extraction window. Index lookup and source prefetch limits are unchanged.

The library codec name and decoder configuration string are `htj2k`. This is an internal custom-decoder identifier, **not a registered WebCodecs codec string**. MXF configurations carry a one-byte `description` containing the RGB component depth, 8 or 16. Geometry and component properties must match the codestream SIZ marker. Without a matching registered decoder, capability queries return false instead of probing a native `VideoDecoder` with this string. Initialization and decode failures propagate; there is no native fallback.

There is no HTJ2K encoder or muxer support. MP4, CMAF, MOV, and Matroska output codec lists exclude it. Complete-frame decoding remains the default. Reduced decoding is an explicit request, not automatic adaptation to canvas size.

## Explicit reduced decoding

Create remote inputs with finite ranges **before reading track metadata**:

```ts
const input = new Input({
	formats: [MXF],
	source: new UrlSource(url, { rangePolicy: { minimumRequestSize: 32768 } }),
});
const track = await input.getPrimaryVideoTrack();
const sink = new VideoSampleSink(track!, { reducedResolution: { width: 480, height: 270 } });
const sample = await sink.getSample(10);
sample?.close();
input.dispose();
```

The decoder selects the largest decomposition skip whose decoded width and height meet the requested positive integer dimensions. Unsupported containers, selected decoders, codestream layouts, and requests requiring skip zero reject. There is no complete-frame fallback. `CanvasSink` accepts the same request through `decoderOptions`; its display size does not enable reduced decoding. Cropping with reduced decoding is currently rejected.

The reduced subset additionally requires RPCL, the reversible multiple-component transform, one to six decompositions, explicit precincts no larger than 1024 on either axis, and precinct subbands at least as large as a codeblock. QCD must use one guard bit and positive exponents no greater than the component depth plus six. Only SIZ, CAP, COD, reversible QCD, optional COM, one SOT and SOD are accepted before packet data. Tile overrides, SOP/EPH, packed headers, and progression overrides are unsupported. Limits are 65,536 packets, 262,144 retained codeblock positions, and 128 MiB for both original and derived compressed buffers. Original geometry limits still apply.

The extension parses inclusion and zero-bitplane tag trees, coding-pass counts, HT placeholder passes, Lblock, segment lengths, and stuffed packet-header bits. It checks physical receipt of every required component/precinct packet body. It then copies the covered low-resolution prefix into a **private derived decode input**, corrects Psot, appends an empty packet for each omitted packet, and writes EOC. COD is unchanged. This buffer is never returned as an original `EncodedPacket`. Omitted high-resolution entropy data is not fetched or validated; this is not a validator for the complete original codestream.

Discovery scales its minimum refill with requested pixel area, from 16 KiB up to 640 KiB, rounded up to a 16 KiB multiple. Requests of 480×270 or larger retain the 640 KiB refill. This transport heuristic reduces smaller-preview overfetch without an extra header request; it is not an estimate or limit of required packet coverage. Refills are bounded by the remaining packet bytes. A larger parser request can require a larger refill, subject to the existing packet and working-buffer limits. The parser validates coverage independently and requests additional windows when needed, including incompressible inputs. The heuristic does not guarantee one request per frame or a playback rate. MXF caps source read-ahead at each requested window end, not the whole frame or partition. Remote readers reject a `UrlSource` without an explicit finite range policy, or one already using sequential fallback. The server must honor Range with 206 and expose Content-Range to cross-origin clients. A finite request policy is not an aggregate traffic budget. Playback iterators still look ahead, while the existing player's paused preview reads one target.

Bytes must describe an immutable resource for the input's lifetime. This path does **not** verify an ETag or send If-Match. A server that hides ETag or rejects conditional CORS requests cannot provide that assurance through this API. Applications needing verified source identity must enforce it in their source or proxy. Disposal and iterator cancellation prevent subsequent partial reads, but cannot interrupt native decoding already in progress.

Strict partial-read requirements propagate through source slices and custom path resolvers. A physical request retains its 206 requirement even if its logical caller cancels before response headers arrive. A non-206 response is canceled without draining its body or switching to sequential fallback. Ordinary reads retain their existing fallback behavior. A caller-defined `CustomSource` is responsible for honoring finite read bounds in its backing transport.

### Bounded range preparation

Explicit reduced range iterators use the decoder's optional `prepareReduced` / `decodePrepared` pair. At most two slots are admitted, counting preparing inputs, ready inputs, and native decoding. Each slot reserves a 64 MiB preparation-buffer allowance, so the aggregate allowance is 128 MiB. The extractor checks prefix storage, old and new read windows, the incoming reader copy, resize overlap, and the final derived allocation before allocating or requesting those bytes. Source-owned cache and copies, native memory, decoded samples, and separately bounded packet-header metadata are excluded. This is not a total process-memory limit.

The 64 MiB allowance admits the retained 3840×2160 RGB16 example's 480×270, 960×540, and 1920×1080 requests. With the 640 KiB refill setting, their measured per-slot peak accounted buffer sizes are approximately 2.28 MB, 7.19 MB, and 27.08 MB respectively. Larger valid inputs may exceed the preparation budget and reject; they do not fall back to complete-frame fetching.

Preparation snapshots configuration, request dimensions, and timing. It validates packet coverage without allocating native decoder state or emitting samples. The core submits prepared inputs to the existing native-call serializer in packet order and disposes them when decoding settles. Ready inputs are disposed on cancellation; inputs whose native call has started stay alive until that call settles. Timestamp iterators retain their serial reduced-decoding discipline. Decoders without the optional pair continue using `decodeReduced`; an incomplete pair is rejected during setup.

Prepared range navigation admits another packet only when a slot is available, rather than filling an independent metadata queue. Known intra-frame ranges stop preparation at the requested end. Cancellation removes that operation's queued and worker-attached read demands without disposing the shared Input or canceling other consumers. An already-started physical read may finish and contribute valid bytes to the cache, but it does not schedule continuation solely for canceled demands.

Packet-header interpretation follows OpenJPH 0.32.0 `ojph_precinct.cpp` and `ojph_bitbuffer_read.h`, pinned in `vendor/README.md`. The TypeScript parser is independently bounded and does not rely on native decode success as evidence of complete packet coverage.

## Precision, color, and ownership

Mediabunny's packed RGB sample formats are eight-bit. The extension returns owned RGBA8 storage, clamps each reconstructed component to its unsigned range, then shifts RGB16 values right by eight bits. Alpha is 255. The output retains `{ primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true }`. BT.709 transfer is not sRGB; no sRGB conversion or mastering-display interpretation is asserted. A renderer must respect this metadata. Canvas screenshots alone do not prove color accuracy or full-precision decoding.

The decoder consumes each borrowed native component row before pulling the next one and deletes the native decoder in `finally`. Held samples never alias native memory. Decoding is synchronous after lazy initialization and uses the existing sink queue limits. Input disposal cannot interrupt an in-progress native frame; it prevents further sink work once that call returns. The shared WASM heap retains its allocation high-water mark for reuse.

## Verification and provenance

`test/node/htj2k.test.ts` exercises registration, capabilities, output exclusion, indexed seek, packet identity, RGB8/RGB16 decode, held-sample ownership, and malformed frames through public APIs. Tiny synthetic codestreams are MIT-licensed original patterns, not excerpts from the remote demonstration media.

For the separately retained real frame and FFmpeg oracle:

```sh
npm run pre-test
HTJ2K_EVIDENCE=/path/to/htj2k-evidence npx vitest run --project node test/node/htj2k.test.ts
```

That opt-in test reads only retained byte ranges from the original 17.7 GB MXF, checks packet identity and timing, compares full-resolution RGB16 against FFmpeg's independently decoded SHA-256 oracle, then compares the public sample's RGBA8 bytes to an independently quantized reference. It does not download the movie or redistribute that media.

See `vendor/README.md` for pinned source, hashes, rebuild steps, and third-party licenses. No native build is needed to consume or build this package from the checked-in runtime.
