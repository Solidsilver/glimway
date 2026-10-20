"""Prepare the generated Wick Tree master and export public icon sizes."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT.parents[2] / "public"
BACKGROUND = (36, 31, 49)


def tree_mask(image: Image.Image) -> Image.Image:
    """Separate warm bark/foliage from the generated purple background."""
    mask = Image.new("L", image.size)
    source, target = image.load(), mask.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b = source[x, y]
            # The generated background is purple; tree outlines, bark and
            # foliage are warm or green, so blue leads neither red nor green.
            target[x, y] = 0 if b > r + 6 and b > g + 6 else 255
    return mask


def native_icon(image: Image.Image, size: int) -> Image.Image:
    mask = tree_mask(image)
    bounds = mask.getbbox()
    if not bounds:
        raise ValueError("no tree pixels found in generated source")
    crop = image.crop(bounds)
    subject_mask = mask.crop(bounds)
    scale = min(size / crop.width, size / crop.height)
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    crop = crop.resize((width, height), Image.Resampling.LANCZOS)
    subject_mask = subject_mask.resize((width, height), Image.Resampling.LANCZOS).point(lambda v: 255 if v >= 128 else 0)
    # Quantize only tree colors, then place them on the exact flat brand field.
    crop = crop.quantize(colors=24, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    result = Image.new("RGB", (32, 32), BACKGROUND)
    x, y = (32 - width) // 2, (32 - height) // 2
    result.paste(crop, (x, y), subject_mask)
    return result


def main() -> None:
    source = Image.open(ROOT / "wick-tree-generated.png").convert("RGB")
    normal = native_icon(source, 25)
    maskable = native_icon(source, 20)
    normal.save(ROOT / "wick-tree-grid-32.png")
    maskable.save(ROOT / "wick-tree-maskable-grid-32.png")

    def export(master: Image.Image, filename: str, size: int) -> None:
        master.resize((size, size), Image.Resampling.NEAREST).save(PUBLIC / filename, optimize=True)

    export(normal, "favicon.png", 32)
    export(normal, "apple-touch-icon.png", 180)
    export(normal, "icon-192.png", 192)
    export(normal, "icon-512.png", 512)
    export(maskable, "icon-maskable-512.png", 512)

    # Review native icon details alongside platform mask previews.
    sheet = Image.new("RGB", (6 * 204, 258), (238, 226, 205))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    native_icons = [
        normal.resize((16, 16), Image.Resampling.NEAREST),
        normal,
        normal.resize((64, 64), Image.Resampling.NEAREST),
        Image.open(PUBLIC / "apple-touch-icon.png").convert("RGB"),
    ]
    labels = ["16 px · zoomed 4×", "32 px · zoomed 2×", "64 px", "180 px"]
    for i, (icon, label) in enumerate(zip(native_icons, labels)):
        shown = icon.resize((64, 64), Image.Resampling.NEAREST) if i < 2 else icon
        x = i * 204
        draw.rectangle((x, 0, x + 203, 257), fill=(238, 226, 205), outline=(144, 126, 103))
        draw.text((x + 8, 10), label, font=font, fill=(58, 42, 40))
        sheet.paste(shown, (x + (204 - shown.width) // 2, 38))
        # Preserve the actual 16px and 32px raster samples on the same sheet.
        if i < 2:
            sheet.paste(icon, (x + 12, 118))
            draw.text((x + 52, 122), "actual pixels", font=font, fill=(58, 42, 40))

    rounded = Image.open(PUBLIC / "apple-touch-icon.png").convert("RGB")
    rounded_mask = Image.new("L", rounded.size, 0)
    ImageDraw.Draw(rounded_mask).rounded_rectangle((0, 0, 179, 179), radius=40, fill=255)
    rounded_preview = Image.new("RGB", rounded.size, (238, 226, 205))
    rounded_preview.paste(rounded, (0, 0), rounded_mask)
    circle_icon = Image.open(PUBLIC / "icon-maskable-512.png").convert("RGB").resize((180, 180), Image.Resampling.NEAREST)
    circle_mask = Image.new("L", circle_icon.size, 0)
    ImageDraw.Draw(circle_mask).ellipse((0, 0, 179, 179), fill=255)
    circle_preview = Image.new("RGB", circle_icon.size, (238, 226, 205))
    circle_preview.paste(circle_icon, (0, 0), circle_mask)
    for i, (preview, label) in enumerate([(rounded_preview, "iOS rounded mask"), (circle_preview, "Maskable circle crop")], start=4):
        x = i * 204
        draw.rectangle((x, 0, x + 203, 257), fill=(238, 226, 205), outline=(144, 126, 103))
        draw.text((x + 8, 10), label, font=font, fill=(58, 42, 40))
        sheet.paste(preview, (x + 12, 38))
    sheet.save(ROOT / "contact-sheet.png")


if __name__ == "__main__":
    main()
