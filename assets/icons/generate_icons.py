"""
generate_icons.py — one-off script that renders GoPal's app icons as flat PNGs
using only Pillow (no external assets). Run manually if icons need regenerating:

    python assets/icons/generate_icons.py

Produces: icon-192.png, icon-512.png, icon-maskable-512.png in this directory.
Design: OLED-dark surface background + a single-stroke "eye" mark in accent
blue, matching the app's design tokens (--surface #0F172A, --accent #38BDF8).
"""

from PIL import Image, ImageDraw
import math
import os

BG = (15, 23, 42, 255)       # --surface
ACCENT = (56, 189, 248, 255)  # --accent
PUPIL = (2, 6, 23, 255)       # --bg (dark pupil against bright accent iris)

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def draw_eye_mark(size, margin_ratio=0.16, maskable=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background: rounded square (or full-bleed square for maskable safe zone).
    radius = size * (0.22 if not maskable else 0.0)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    margin = size * margin_ratio
    cx, cy = size / 2, size / 2
    eye_w = size - 2 * margin
    eye_h = eye_w * 0.55

    # Almond-shaped eye outline built from two arcs, single-stroke style.
    stroke_w = max(2, int(size * 0.045))
    left = cx - eye_w / 2
    right = cx + eye_w / 2
    top = cy - eye_h / 2
    bottom = cy + eye_h / 2

    # Upper lid arc
    draw.arc([left, top, right, bottom + eye_h * 0.15], start=200, end=340, fill=ACCENT, width=stroke_w)
    # Lower lid arc
    draw.arc([left, top - eye_h * 0.15, right, bottom], start=20, end=160, fill=ACCENT, width=stroke_w)

    # Iris (filled circle, accent)
    iris_r = eye_h * 0.42
    draw.ellipse([cx - iris_r, cy - iris_r, cx + iris_r, cy + iris_r], fill=ACCENT)
    # Pupil (dark circle on top)
    pupil_r = iris_r * 0.45
    draw.ellipse([cx - pupil_r, cy - pupil_r, cx + pupil_r, cy + pupil_r], fill=PUPIL)
    # Highlight glint
    glint_r = pupil_r * 0.35
    gx, gy = cx - pupil_r * 0.4, cy - pupil_r * 0.4
    draw.ellipse([gx - glint_r, gy - glint_r, gx + glint_r, gy + glint_r], fill=(248, 250, 252, 255))

    return img


def main():
    icon_192 = draw_eye_mark(192, margin_ratio=0.18)
    icon_192.save(os.path.join(OUT_DIR, 'icon-192.png'))

    icon_512 = draw_eye_mark(512, margin_ratio=0.18)
    icon_512.save(os.path.join(OUT_DIR, 'icon-512.png'))

    # Maskable: keep artwork within the ~80% safe zone, no rounded corners
    # (the OS applies its own mask shape), background fills edge-to-edge.
    icon_maskable = draw_eye_mark(512, margin_ratio=0.28, maskable=True)
    icon_maskable.save(os.path.join(OUT_DIR, 'icon-maskable-512.png'))

    print('Wrote icon-192.png, icon-512.png, icon-maskable-512.png to', OUT_DIR)


if __name__ == '__main__':
    main()
