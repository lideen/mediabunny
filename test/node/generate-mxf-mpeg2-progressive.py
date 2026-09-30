"""Generate original I/P MXFs with open GOP flags, padded width and consecutive I pictures.

Usage: python3 test/node/generate-mxf-mpeg2-progressive.py NEW_OUTPUT_DIRECTORY
FFmpeg/ffprobe 7.1.1. No container, index or essence patches are applied.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=False)
for name, width, level in [('padded-high', 1718, 4), ('high1440', 1280, 6)]:
    target = root / (name + '.mxf')
    video = (f"nullsrc=size={width}x720:rate=24,"
             "geq=lum='32+96*X/W+32*Y/H+48*between(X,40+12*N,200+12*N)*between(Y,180,340)':"
             "cb='96+48*Y/H':cr='144+24*X/W',setsar=1")
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', video,
               '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*440*t)|0.15*sin(2*PI*660*t):s=48000',
               '-map', '0:v:0', '-map', '1:a:0', '-t', '1.5', '-c:v', 'mpeg2video',
               '-pix_fmt', 'yuv420p', '-profile:v', '4', '-level:v', str(level),
               '-r', '24', '-g', '12', '-bf', '0', '-force_key_frames', '0,0.5,0.541667,0.583333,1',
               '-flags:v', '+bitexact', '-sc_threshold', '1000000000', '-q:v', '4', '-threads:v', '1',
               '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-fflags', '+bitexact',
               '-metadata', 'creation_time=2026-01-01T00:00:00Z', '-f', 'mxf', str(target)]
    subprocess.run(command, check=True)
    packets = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', str(target)]))
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-c:v', 'mpeg2video', '-idct', 'faani',
                                   '-i', str(target), '-map', '0:v:0', '-fps_mode', 'passthrough',
                                   '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'])
    size = width * 720 * 3 // 2
    assert len(raw) == 36 * size
    manifest = {'width': width, 'height': 720, 'rate': 24, 'frames': 36, 'command': command,
                'fileSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                'frameHashes': [hashlib.sha256(raw[i:i+size]).hexdigest() for i in range(0, len(raw), size)],
                'packets': packets['packets']}
    (root / (name + '.json')).write_text(json.dumps(manifest, indent=2) + '\n')
