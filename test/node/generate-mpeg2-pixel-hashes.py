"""Hash independently decoded FAANI planes, without importing the decoder under test.

Usage: python3 test/node/generate-mpeg2-pixel-hashes.py /path/to/expected-faani.yuv
Generate that file with the command in test/fixtures/mpeg2/README.md.
"""
import hashlib
import json
from pathlib import Path
import sys

raw = Path(sys.argv[1]).read_bytes()
assert len(raw) == 24883200
assert hashlib.sha256(raw).hexdigest() == "0b1f18b0b54bcd670c1dd34fe125fc4e0504017d44ca913dd487019c4f23f620"
frames = []
for index in range(18):
    frame = raw[index * 1382400:(index + 1) * 1382400]
    frames.append({
        "timestamp": index / 25,
        "duration": 1 / 25,
        "planes": [hashlib.sha256(plane).hexdigest() for plane in
                   (frame[:921600], frame[921600:1152000], frame[1152000:])],
    })
output = Path(__file__).resolve().parent.parent / "fixtures/mpeg2/pixels.json"
output.write_text(json.dumps({"format": "I420", "width": 1280, "height": 720,
                              "rawSha256": hashlib.sha256(raw).hexdigest(), "frames": frames}, indent=2) + "\n")
