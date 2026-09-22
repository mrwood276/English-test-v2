"""Creates the sample files used by media_e2e.py (see fixtures_dir.py for where).

Run once:  python frontend/tests/make_fixtures.py
"""
import os
import random

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Pillow is missing. Install it with:  pip install pillow")

from fixtures_dir import fixtures_dir

FIX = fixtures_dir()
os.makedirs(FIX, exist_ok=True)
os.chdir(FIX)
random.seed(7)
w, h = 2400, 1600
img = Image.new("RGB", (w, h))
px = img.load()
for y in range(h):
    for x in range(w):
        n = random.randint(-12, 12)
        px[x, y] = ((x * 255 // w + n) % 256, (y * 255 // h + n) % 256, ((x + y) * 255 // (w + h) + n) % 256)
img.save("big.png")
for name, size, color in [("small.png", (200, 150), (30, 90, 200)), ("small2.png", (160, 120), (200, 90, 30)), ("small3.png", (120, 90), (20, 160, 90)), ("small4.png", (100, 80), (160, 20, 90))]:
    Image.new("RGB", size, color).save(name)
Image.new("RGB", (100, 80)).save("anim.gif")
open("story.mp3", "wb").write(b"ID3\x03\x00\x00\x00\x00\x00\x00" + os.urandom(300_000))
open("huge.mp3", "wb").write(b"ID3" + bytes(10_500_000))
open("notes.pdf", "wb").write(b"%PDF-1.4 fake")
print("sample files written to", FIX)
