#!/usr/bin/env python3
"""Generate the app icons: white kanji 本 on black, matching manga-library.

Run via a container that has Pillow + Noto Sans CJK (see scripts/make_icons.sh).
Outputs into static/img/: icon-192, icon-512, icon-512-maskable, apple-touch-icon,
and favicon.ico.
"""
import glob
import os

from PIL import Image, ImageDraw, ImageFont

CHAR = "本"
OUT = os.path.join(os.path.dirname(__file__), "..", "static", "img")

# Prefer a bold Noto Sans CJK face (the manga icon reads as a heavy gothic).
PATTERNS = [
    "/usr/share/fonts/**/NotoSansCJK*Bold*.ttc",
    "/usr/share/fonts/**/NotoSansCJK*Bold*.otf",
    "/usr/share/fonts/**/NotoSansCJK*.ttc",
    "/usr/share/fonts/**/NotoSansCJK*.otf",
]


def find_font():
    for pat in PATTERNS:
        hits = glob.glob(pat, recursive=True)
        if hits:
            return sorted(hits)[0]
    raise SystemExit("No Noto Sans CJK font found")


FONT = find_font()


def render(px, fill_frac):
    img = Image.new("RGB", (px, px), "black")
    d = ImageDraw.Draw(img)
    target = px * fill_frac
    # Fit the glyph's larger dimension to the target by measuring then scaling.
    probe = ImageFont.truetype(FONT, px)
    l, t, r, b = d.textbbox((0, 0), CHAR, font=probe)
    size = max(1, int(px * target / max(r - l, b - t)))
    f = ImageFont.truetype(FONT, size)
    l, t, r, b = d.textbbox((0, 0), CHAR, font=f)
    x = (px - (r - l)) / 2 - l
    y = (px - (b - t)) / 2 - t
    d.text((x, y), CHAR, font=f, fill="white")
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    render(512, 0.84).save(os.path.join(OUT, "icon-512.png"))
    render(192, 0.84).save(os.path.join(OUT, "icon-192.png"))
    render(180, 0.80).save(os.path.join(OUT, "apple-touch-icon.png"))
    render(512, 0.62).save(os.path.join(OUT, "icon-512-maskable.png"))
    render(256, 0.86).save(os.path.join(OUT, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote icons to", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
