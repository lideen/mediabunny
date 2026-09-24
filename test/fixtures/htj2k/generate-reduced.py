"""Generate original deterministic RPCL fixtures using pinned OpenJPH ojph_compress.

Usage: python3 generate-reduced.py /path/to/ojph_compress
Encoder source commit: 23c422895ce6c3a156935222e4715ee0b7be952c.
The patterns and generated media are dedicated to the public domain (CC0-1.0).
"""
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
CASES = [
    (1, 65, 8, 2, "{16,16},{32,32}", "{8,8}"),
    (65, 1, 16, 2, "{16,16},{32,32}", "{8,8}"),
    (65, 49, 8, 2, "{16,16},{32,32}", "{8,8}"),
    (193, 131, 16, 3, "{32,16},{64,32}", "{16,8}"),
    (257, 129, 8, 4, "{32,32},{64,64}", "{16,16}"),
]
with tempfile.TemporaryDirectory() as directory:
    for width, height, depth, levels, precincts, blocks in CASES:
        ppm = Path(directory) / "pattern.ppm"
        pixels = bytearray()
        for y in range(height):
            for x in range(width):
                for c in range(3):
                    value = (x * 1009 + y * 313 + c * 7919 + (x * y) * 17) % (2 ** depth)
                    pixels.extend(value.to_bytes(depth // 8, "big"))
        ppm.write_bytes(f"P6\n{width} {height}\n{2 ** depth - 1}\n".encode() + pixels)
        subprocess.run([sys.argv[1], "-i", str(ppm), "-o",
                        str(ROOT / f"rpcl-{width}x{height}-{depth}.j2c"),
                        "-num_decomps", str(levels), "-reversible", "true",
                        "-colour_trans", "true", "-prog_order", "RPCL",
                        "-precincts", precincts, "-block_size", blocks], check=True)
