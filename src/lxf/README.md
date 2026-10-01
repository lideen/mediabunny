# Narrow LXF input

Use `formats: [LXF]` explicitly. LXF is not MXF and is not included in `ALL_FORMATS`. There is no LXF muxer or encoder.

The admitted subset requires a known finite size, checksummed version-1 headers of 72 to 256 bytes, one 25 fps closed all-I MPEG-2 4:2:2/profile-82 stream with N=1/M=1 and temporal reference zero, and one 48 kHz packed PCM24 stream with 1 to 8 contiguous channel ordinals. Both tracks are required. Separate field pictures, repeated fields, reordered video, version 0, sparse channel masks, 20-bit packing, multiple stream IDs and midstream format changes are unsupported. The optional MPEG-2 decoder retains woven field order without deinterlacing.

Only a single segment is supported. Its type-2 header must be at byte zero. Observed later segment boundaries reject during traversal, successor validation or bounded discovery, even when the original duration still agrees with the video tail. During resynchronization, an unproved segment-like signature inside unvisited payload remains only a candidate; a valid predicted successor or EOF must establish its boundary. Known packet extents exclude embedded candidates throughout each scan. This does not authenticate forged chains in unknown payloads or prove that unvisited bytes contain no further segments.

## Ownership and bounds

`lxf-reader.ts` owns version-1 little-endian envelopes, checksums, finite source reads and operation budgets. `lxf-demuxer.ts` owns track discovery, sparse timestamp anchors, tail proof, packet navigation and planar-to-interleaved PCM24 conversion. There is no file-wide scan or invented on-disk index.

Whole packet extents, including headers and ancillary bytes, are capped at 2 MiB. Each seek permits at most twelve 1 MiB search windows and 12 MiB of uncached navigation requests, including successor headers. Tail discovery has one 1 MiB window and a 2 MiB read budget. The shared anchor cache holds at most 256 entries, and each transaction has bounded local anchors. Missing coverage, timestamp gaps or exhausted budgets reject rather than return a future frame or scan from zero. These limits can reject otherwise valid layouts; they are not arbitrary-duration seek guarantees.

Next-packet traversal examines at most 32 envelopes. If that limit is reached after a shorter track ends, the same bounded tail proof may establish EOF for that track. It returns `null` only when the supplied packet matches the track's proved final packet; missing proof or a different endpoint still rejects.

These budgets count logical demuxer requests, not HTTP traffic. LXF requests finite reads and passes the packet operation's abort signal to the source. `UrlSource` therefore requires an explicit finite `rangePolicy` and a server that honors byte ranges with HTTP 206; its default open-ended transport is not sufficient. Source discovery, transport policy and any separately configured prefetch can transfer additional bytes. Packet payload delivery is separate from the navigation budget. Source cancellation must reject a pending operation without waiting for blocked I/O to finish; cancelled operations must not publish tail results or packets.

The clock is 720,000 Hz. The supported cadence is 28,800 ticks per packet, checked against MPEG-2 sequence rate, segment frame count/duration, extended format metadata when present, and 1,920 PCM samples at 48 kHz. Nonzero origins remain common to both tracks. `getDurationFromMetadata` and `computeDuration` return end timestamps, matching Mediabunny's contract. `getPacket` beyond a track's end returns its last packet, not a new packet or extended duration. Audio may end before video.

Every returned video packet is checked for the supported picture syntax and stable configuration, including metadata-only requests. PCM uses channel ordinals, not inferred speaker positions. Public payloads interleave complete signed-24 triplets into owned buffers; metadata-only packets retain the same byte length. Silent channels are not removed.

Ancillary payloads and segment metadata are skipped except for the fields needed to validate this subset. Source timecode, captions/ANC and descriptive tags are not exposed or preserved by this demuxer.

## Provenance and verification

This is an independently authored TypeScript parser and bounded navigator, extracted from the archived LXF implementation. Wire facts were researched from FFmpeg n7.1.1 `libavformat/lxfdec.c` and MediaInfoLib `File_Lxf.cpp`, then checked against bounded local LXF samples. No upstream parser or seeking implementation was copied or translated. This is not a clean-room claim. The MPL notice covers this implementation, not those reference sources or the separately unlicensed MPEG-2 decoder.

References recorded by the original implementation:

- FFmpeg: <https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavformat/lxfdec.c>, LGPL-2.1-or-later. Retained SHA-256 `ea3dffec5e65fbc098f614337f7da56cf0118dfa203ba6a1099f24b3fe5640db`.
- MediaInfoLib: <https://github.com/MediaArea/MediaInfoLib/blob/master/Source/MediaInfo/Multiple/File_Lxf.cpp>. Retained SHA-256 `daa42d1f7b8460edce21faab9cc0f1aea562445b1099a6c234d64f50381b0a74`. Its repository license supplies BSD-style and alternative grants. The retained hash identifies the moving source URL.

`test/node/lxf-fixture.ts` writes envelopes directly from the recorded wire facts. It reuses existing authored MPEG-2 I pictures from `open422.mxf` and `interlaced422.mxf`, sets temporal reference to zero, and compares against the original pictures' independent FAANI hashes. The current `9a19284` MPEG-2 decoder was requalified against FFmpeg 7.1.1 FAANI for these pictures; the old decoder's regression golden is not used. FFmpeg can also demux the authored LXF for pixel verification with an explicit input `-c:v mpeg2video`; its default codec selection treats the fixture's minimal segment metadata as MJPEG. FFmpeg's synthetic LXF DTS and inferred channel count are not timing or channel-layout oracles.

Audio uses distinct channel patterns and signed extrema. Logical large files synthesize bytes on demand without allocating gigabytes. Public-input tests cover packet bytes, timestamps, separate endpoints, decoded samples, channel ordering, cancellation and bounded navigation failures. Node pixel equality does not establish browser playback, canvas color conversion or real-time performance.

`test/fixtures/lxf/changing422.m2v` adds six independently FFmpeg-encoded, visibly different closed I pictures. Seek tests wrap them with packet-varying PCM and nonuniform ancillary extents, then compare selected payloads and decoded pixels against the original stream and independent FAANI hashes. The fixture README records the encoding and pixel-reference commands.
