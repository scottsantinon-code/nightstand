from PIL import Image, ImageDraw

BG = (14, 14, 16, 255)        # #0e0e10
MOON = (227, 213, 184, 255)   # warm off-white

def make(size):
    ss = 8
    S = size * ss
    img = Image.new('RGBA', (S, S), BG)
    d = ImageDraw.Draw(img)
    # crescent: moon circle minus an offset bite of background colour
    cx, cy, r = S * 0.52, S * 0.48, S * 0.30
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=MOON)
    bx, by, br = cx - S * 0.115, cy - S * 0.075, r * 0.985
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=BG)
    return img.resize((size, size), Image.LANCZOS)

for size in (180, 192, 512):
    make(size).convert('RGB').save(f'icons/icon-{size}.png')
    print(f'icon-{size}.png')
