# MPEG-2 MXF fixture

`main420.mxf` contains authored moving luma/chroma ramps and stereo sine waves. No external media was used. It is unmodified FFmpeg 7.1.1 OP1a output, with 18 progressive 1280×720 Main Profile / High Level 4:2:0 pictures at 25 fps and 48 kHz stereo PCM16. Both tracks last 0.72 seconds. The actual closed GOP keys are decode ordinals 0 and 10, despite the encoder's requested GOP size of 12.

- File size: 232,505 bytes.
- SHA-256: `be9c27eb454997c802ac06a6c8434d70826ab038cf642b53fd7f640f117eda8b`.
- `packets.json` is independent ffprobe output with timestamps, complete essence sizes, and SHA-256 hashes for all 36 packets.
- Regenerate with `python3 test/node/generate-mxf-mpeg2.py <new-directory>`. The generator does not apply the AVC fixture's index correction. Tool-version changes and generated MXF identifiers can change the file hash; compare packet hashes separately.

The sequence-display extension specifies BT.709 matrix coefficients but leaves primaries and transfer unspecified. The encoder command's requested primaries/transfer are not the bitstream metadata.

These fixtures test demuxing and restart-header validation. They do not establish decoder or browser playback support.
