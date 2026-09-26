"""Generate private authored open-GOP MXF using the supplied mpeg2-rs mathematical bit writers.

Usage: python3 -B test/node/generate-mxf-mpeg2-open.py MPEG2_RS_DIRECTORY NEW_OUTPUT_DIRECTORY
The Rust checkout is read-only. No source media or Rust builds are used.
"""
import importlib.util
import json
import hashlib
from pathlib import Path
import subprocess
import sys

source, output = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=False)
spec = importlib.util.spec_from_file_location('authored', source / 'tools/generate-b-vectors.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
packets = []
for gop in range(3):
    packets.append(m.v.sequence(64, 48, chroma=2, profile=0x82)
                   + m.gop(gop == 0) + m.anchor(2, 2, 3 + gop * 8))
    for tr in [0, 1, 5, 3, 4, 8, 6, 7, 11, 9, 10]:
        packet = (m.p.predictive_picture(2, tr, 'residual') if tr in [5, 8, 11]
                  else m.b_picture(2, tr, 'backward' if gop == 0 and tr < 2 else 'all'))
        if gop == 1 and tr == 0:
            update = m.v.Bits()
            update.put(3, 4)
            for matrix in range(4):
                update.put(int(matrix == 1), 1)
                if matrix == 1:
                    for i in range(64):
                        update.put(16 + i % 23, 8)
            start = packet.index(b'\x00\x00\x01\x01')
            packet = packet[:start] + update.unit(0xb5) + packet[start:]
        packets.append(packet)
es = output / 'open422.m2v'
es.write_bytes(b''.join(packets))
mxf = output / 'open422.mxf'
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-n', '-fflags', '+genpts', '-r', '25',
                '-i', str(es), '-c:v', 'copy', '-f', 'mxf', str(mxf)], check=True)
manifest = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_packets',
                                               '-show_data_hash', 'sha256', '-of', 'json', str(mxf)]))
raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-c:v', 'mpeg2video', '-idct', 'faani', '-i', str(mxf),
                               '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'])
assert len(raw) == 36 * 64 * 48 * 2
manifest['faani'] = [hashlib.sha256(raw[i:i+6144]).hexdigest() for i in range(0, len(raw), 6144)]
(output / 'open422.json').write_text(json.dumps(manifest, indent=2) + '\n')

interlaced = output / 'interlaced422.mxf'
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=gray:s=64x48:r=25',
                '-t', '0.72', '-c:v', 'mpeg2video', '-pix_fmt', 'yuv422p', '-profile:v', '0', '-level:v', '2',
                '-flags:v', '+ilme+ildct+bitexact', '-top', '1', '-g', '12', '-bf', '2', '-q:v', '4',
                '-threads:v', '1', '-fflags', '+bitexact', '-f', 'mxf', str(interlaced)], check=True)
manifest = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_packets',
                                               '-show_data_hash', 'sha256', '-of', 'json', str(interlaced)]))
raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-c:v', 'mpeg2video', '-idct', 'faani', '-i', str(interlaced),
                               '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'])
assert len(raw) == 18 * 64 * 48 * 2
manifest['faani'] = [hashlib.sha256(raw[i:i+6144]).hexdigest() for i in range(0, len(raw), 6144)]
(output / 'interlaced422.json').write_text(json.dumps(manifest, indent=2) + '\n')
