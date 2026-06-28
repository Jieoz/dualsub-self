#!/usr/bin/env python3
"""生成占位图标：纯色圆角方块 + 白色字母 D。输出 16/48/128 三种尺寸 PNG。"""
from PIL import Image, ImageDraw, ImageFont

BG = (26, 115, 232, 255)   # 蓝色
FG = (255, 255, 255, 255)  # 白字

def rounded(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(2, size // 5)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    # 画字母 D：优先用字体，拿不到就用图形兜底
    font = None
    for path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        try:
            font = ImageFont.truetype(path, int(size * 0.7))
            break
        except Exception:
            continue
    if font:
        try:
            bbox = d.textbbox((0, 0), "D", font=font)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), "D", font=font, fill=FG)
            return img
        except Exception:
            pass
    # 兜底：手绘一个 D 形状
    m = size * 0.22
    d.rectangle([m, m, m + size * 0.16, size - m], fill=FG)
    d.arc([m, m, size - m, size - m], start=-90, end=90, fill=FG, width=max(2, size // 10))
    return img

for s in (16, 48, 128):
    rounded(s).save(f"icons/{s}.png")
    print(f"wrote icons/{s}.png")
