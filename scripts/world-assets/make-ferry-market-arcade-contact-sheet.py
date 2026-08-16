"""Make a compact labelled QA sheet from isolated Blender close cards."""
import json
import math
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
qa_root = Path(sys.argv[2])
manifest = json.loads((root / 'ferry-market-arcade-cc0.manifest.json').read_text())
cards = []
for asset in manifest['assets']:
    card = Image.open(qa_root / 'cards' / f"{asset['id']}.png").convert('RGB')
    card.thumbnail((400, 320), Image.Resampling.LANCZOS)
    tile = Image.new('RGB', (420, 370), '#111923')
    tile.paste(card, ((420 - card.width) // 2, 8))
    draw = ImageDraw.Draw(tile)
    draw.text((12, 332), f"{asset['classification'].upper()} - {asset['closeCard']}", fill='#dce8f4')
    draw.text((12, 350), f"{asset['export']['triangles']:,} tris | 1 PBR material", fill='#8ba0b5')
    cards.append(tile)
sheet = Image.new('RGB', (420 * 3, 370 * math.ceil(len(cards) / 3)), '#0b1118')
for index, card in enumerate(cards):
    sheet.paste(card, ((index % 3) * 420, (index // 3) * 370))
qa_root.mkdir(parents=True, exist_ok=True)
sheet.save(qa_root / 'contact-sheet.png', optimize=True)
