"""Generate authored progressive MPEG-2/PCM OP1a, without patching its index.

Usage: python3 test/node/generate-mxf-mpeg2.py OUTPUT_DIRECTORY
Recorded with FFmpeg/ffprobe 7.1.1. Never overwrites an existing directory.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=False)
target = root / 'main420.mxf'
video = ("nullsrc=size=1280x720:rate=25:duration=0.72,"
         "geq=lum='32+96*X/W+32*Y/H+48*between(X,40+24*N,200+24*N)*between(Y,180,340)':"
         "cb='96+48*Y/H':cr='144+24*X/W',setsar=1")
audio = 'aevalsrc=0.2*sin(2*PI*440*t)|0.15*sin(2*PI*660*t):s=48000:d=0.72'
with (root / 'generate.log').open('wb') as log:
    subprocess.run([
        'ffmpeg', '-hide_banner', '-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio,
        '-map', '0:v:0', '-map', '1:a:0', '-t', '0.72', '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p',
        '-profile:v', '4', '-level:v', '4', '-r', '25', '-g', '12', '-bf', '2', '-b_strategy', '0',
        '-flags:v', '+cgop+bitexact', '-sc_threshold', '1000000000', '-q:v', '4', '-threads:v', '1',
        '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-fflags', '+bitexact',
        '-metadata', 'creation_time=2026-01-01T00:00:00Z', '-f', 'mxf', str(target),
    ], stderr=log, check=True)

packets = subprocess.check_output([
    'ffprobe', '-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', str(target),
])
(root / 'packets.json').write_bytes(packets)
(root / 'provenance.json').write_text(json.dumps({
    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
    'bytes': target.stat().st_size,
    'ffmpeg': subprocess.check_output(['ffmpeg', '-version'], text=True),
}, indent=2) + '\n')
