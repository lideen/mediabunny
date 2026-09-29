"""Generate redistributable moving-pattern MXFs, not repeated short decode selections.

Usage: python3 test/node/generate-mpeg2-qualification.py NEW_DIRECTORY [SECONDS=30]
FFmpeg and ffprobe must be on PATH. Outputs are local evidence, not repository fixtures.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

output = Path(sys.argv[1]).resolve()
seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 30
if not 30 <= seconds <= 120:
    raise ValueError('Use 30..120 seconds for the continuous sequence')
output.mkdir(parents=True, exist_ok=False)
cases = []
for name, width, height, duration, field in [
    ('progressive420', 1280, 720, seconds, None),
    ('top422', 1920, 1080, 2, 'top'),
    ('bottom422', 1920, 1080, 2, 'bottom'),
]:
    media = output / (name + '.mxf')
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
            f'testsrc2=size={width}x{height}:rate={50 if field else 25}',
            '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', str(duration)]
    if field:
        args += ['-vf', f'format=yuv422p,tinterlace=interleave_{field}',
                 '-flags:v', '+ilme+ildct', '-top', '1' if field == 'top' else '0']
    args += ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv422p' if field else 'yuv420p',
             '-profile:v', '0' if field else '4', '-level:v', '2' if field else '4',
             '-g', '12', '-bf', '2' if field else '0', '-q:v', '4', '-threads:v', '1',
             '-c:a', 'pcm_s16le', '-f', 'mxf', str(media)]
    subprocess.run(args, check=True)
    probe = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_packets',
        '-show_data_hash', 'sha256', '-of', 'json', str(media)]))
    targets = [0, duration * 25 // 2, duration * 25 - 1]
    references = {}
    for ordinal in targets:
        filename = f'{name}-{ordinal}.rgba'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-n', '-idct', 'faani',
                        '-i', str(media), '-vf', f'select=eq(n\\,{ordinal})',
                        '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo',
                        str(output / filename)], check=True)
        references[str(ordinal)] = filename
    cases.append(dict(name=name, file=media.name, width=width, height=height,
                      frames=duration * 25, duration=duration, format='I422' if field else 'I420',
                      scan=f'interlaced-{field}-first' if field else 'progressive',
                      sha256=hashlib.sha256(media.read_bytes()).hexdigest(), references=references,
                      packets=[dict(timestamp=float(p['pts_time']), duration=float(p['duration_time']),
                                    sha256=p['data_hash'][7:].lower()) for p in probe['packets']]))
(output / 'manifest.json').write_text(json.dumps(dict(
    generator='FFmpeg lavfi testsrc2 and sine; no customer media',
    ffmpeg=subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0],
    renderReference='FFmpeg FAANI RGBA; color smoke only, not exact IDCT or color conformance',
    cases=cases), indent=2) + '\n')
