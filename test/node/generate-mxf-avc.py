"""Generate testsrc2/PCM and a SYNTHETIC corrected ST 381-3 index, not a producer sample.

Usage: python3 test/node/generate-mxf-avc.py OUTPUT_DIRECTORY
Requires FFmpeg 7.1.1 with libx264 and ffprobe. Never overwrites an existing directory.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=False)
source = root / 'avc-high-720p25-g25-b2-pcm24.mxf'
target = root / ('SYNTHETIC-corrected-index-' + source.name)
with (root / 'generate.log').open('wb') as log:
    subprocess.run([
        'ffmpeg', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000', '-t', '8',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '3.1',
        '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '24', '-g', '25', '-bf', '2',
        '-x264-params', 'open-gop=0:scenecut=0:b-adapt=0:repeat-headers=1:annexb=1:aud=1',
        '-c:a', 'pcm_s24le', '-ac', '2', '-ar', '48000', '-f', 'mxf', str(source),
    ], stderr=log, check=True)


def probe(path, *options):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', *options, '-of', 'json', str(path)]))


original = source.read_bytes()
output = bytearray(original)
packets = probe(source, '-show_packets', '-show_data_hash', 'sha256')['packets']
video = [p for p in packets if p['codec_type'] == 'video']
frames = probe(source, '-select_streams', 'v:0', '-show_frames')['frames']
assert len(video) == len(frames) == 200
presentation_by_position = {int(f['pkt_pos']): p for p, f in enumerate(frames)}
assert len(presentation_by_position) == 200
coded_to_presentation = [presentation_by_position[int(p['pos'])] for p in video]
assert sorted(coded_to_presentation) == list(range(200))
presentation_to_coded = [coded_to_presentation.index(p) for p in range(200)]

# This fixture has one footer VBE segment with fixed-width local tags and 15-byte entries.
klvs = {}
offset = 0
while offset < len(original):
    key = original[offset:offset + 16].hex()
    start = offset + 17
    length = original[offset + 16]
    if length & 128:
        count = length & 127
        length = int.from_bytes(original[start:start + count], 'big')
        start += count
    klvs[offset] = (key, start, length)
    offset = start + length
assert offset == len(original)
indexes = [r for r in klvs.values() if r[0] == '060e2b34025301010d01020101100100']
assert len(indexes) == 1
_, offset, length = indexes[0]
end = offset + length
fields = {}
while offset < end:
    tag = int.from_bytes(original[offset:offset + 2], 'big')
    length = int.from_bytes(original[offset + 2:offset + 4], 'big')
    fields[tag] = offset + 4
    offset += 4 + length
assert offset == end
delta, entries = fields[0x3f09], fields[0x3f0a]
assert original[delta:delta + 26].hex() == '0000000300000006000000000000000000000200000100000000'
assert original[entries:entries + 8].hex() == '000000c80000000f'
output[delta + 14] = 255  # Only video uses TemporalOffset, never PCM or system data.
last_idr = None
for d, packet in enumerate(video):
    _, start, length = klvs[int(packet['pos'])]
    nals = [n for n in re.split(b'\x00\x00(?:\x00)?\x01', original[start:start + length]) if n]
    vcl = [n for n in nals if n[0] & 31 in (1, 5)]
    assert vcl
    idr = any(n[0] & 31 == 5 for n in vcl)
    referenced = any(n[0] & 0x60 for n in vcl)
    picture_type = frames[coded_to_presentation[d]]['pict_type']
    if idr:
        last_idr = d
        assert picture_type == 'I' and coded_to_presentation[d] == d
    assert last_idr is not None
    flags = {'I': 0, 'P': 0x22, 'B': 0x33}[picture_type]
    if idr or referenced:
        flags |= 4
    if any(n[0] & 31 == 7 for n in nals):
        flags |= 0x40
    if idr:
        flags |= 0x80
    temporal = presentation_to_coded[d] - d
    key = last_idr - d
    assert -128 <= temporal <= 127 and -128 <= key <= 0
    pos = entries + 8 + 15 * d
    output[pos:pos + 3] = bytes([temporal & 255, key & 255, flags])
allowed = {delta + 14} | {entries + 8 + 15 * i + j for i in range(200) for j in range(3)}
assert all(i in allowed for i, (a, b) in enumerate(zip(original, output)) if a != b)
target.write_bytes(output)
corrected = probe(target, '-show_packets', '-show_data_hash', 'sha256')['packets']
assert [p['pts'] for p in corrected if p['codec_type'] == 'video'] == coded_to_presentation
assert [p['data_hash'] for p in corrected] == [p['data_hash'] for p in packets]
assert [p['pts'] for p in corrected if p['codec_type'] == 'audio'] == [
    p['pts'] for p in packets if p['codec_type'] == 'audio']
(root / 'audit.json').write_text(json.dumps({
    'provenance': 'SYNTHETIC index-only correction; original FFmpeg B-frame timing is invalid',
    'sha256': hashlib.sha256(output).hexdigest(), 'codedToPresentation': coded_to_presentation,
    'changedBytes': sum(a != b for a, b in zip(original, output)),
    'packets': corrected,
}, indent=2))
print(target)
