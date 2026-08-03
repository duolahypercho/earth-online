#!/usr/bin/env python3
"""Compare game frames against the real San Francisco reference image."""
import argparse
import json
import math
import sys

from PIL import Image, ImageFilter, ImageOps, ImageStat


def average_hash(image, size=8):
    gray = ImageOps.grayscale(image).resize((size, size), Image.LANCZOS)
    pixels = list(gray.getdata())
    mean = sum(pixels) / len(pixels)
    return "".join("1" if value >= mean else "0" for value in pixels)


def histogram(image, bins=32):
    rgb = image.convert("RGB")
    hist = [0] * (bins * 3)
    width, height = rgb.size
    pixels = rgb.load()
    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y]
            hist[(r * bins) // 256] += 1
            hist[bins + (g * bins) // 256] += 1
            hist[bins * 2 + (b * bins) // 256] += 1
    total = max(1, sum(hist))
    return [value / total for value in hist]


def histogram_intersection(a, b):
    return sum(min(x, y) for x, y in zip(a, b))


def lab_distance(a, b):
    a = a.convert("LAB").resize((128, 72), Image.LANCZOS)
    b = b.convert("LAB").resize((128, 72), Image.LANCZOS)
    pa = a.load()
    pb = b.load()
    total = 0.0
    count = 0
    for y in range(72):
        for x in range(128):
            la, aa, ba = pa[x, y]
            lb, ab, bb = pb[x, y]
            total += math.sqrt(
                (la - lb) ** 2 + (aa - ab) ** 2 + (ba - bb) ** 2
            )
            count += 1
    return total / max(1, count)


def metrics(path):
    image = Image.open(path).convert("RGB")
    sample = image.resize((320, 180), Image.LANCZOS)
    gray = ImageOps.grayscale(sample)
    gray_stat = ImageStat.Stat(gray)
    hsv = sample.convert("HSV")
    sat_stat = ImageStat.Stat(hsv.split()[1])
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edge_stat = ImageStat.Stat(edges)
    pixels = list(gray.getdata())
    non_blank = sum(1 for value in pixels if value > 8) / len(pixels)
    quantized = sample.quantize(colors=64, method=Image.MEDIANCUT)
    unique = len(quantized.getcolors(maxcolors=1000000) or [])
    return {
        "width": image.width,
        "height": image.height,
        "meanLuma": round(gray_stat.mean[0], 3),
        "lumaStd": round(gray_stat.stddev[0], 3),
        "meanSaturation": round(sat_stat.mean[0], 3),
        "edgeDensity": round(edge_stat.mean[0], 4),
        "nonBlankRatio": round(non_blank, 4),
        "quantizedColors": unique,
        "histogram": histogram(image),
        "averageHash": average_hash(image),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ref", required=True)
    parser.add_argument("--out", default=".qa-visual-critic.json")
    parser.add_argument("game", nargs="+")
    args = parser.parse_args()

    ref = metrics(args.ref)
    output = {
        "reference": args.ref,
        "referenceMetrics": {
            key: value for key, value in ref.items()
            if key not in ("histogram", "averageHash")
        },
        "frames": [],
    }
    for path in args.game:
        try:
            game = metrics(path)
        except Exception as error:  # noqa: BLE001 - report any unreadable frame
            output["frames"].append({"path": path, "error": str(error)})
            continue
        hamming = sum(
            1 for a, b in zip(ref["averageHash"], game["averageHash"]) if a != b
        )
        output["frames"].append({
            "path": path,
            "metrics": {
                key: value for key, value in game.items()
                if key not in ("histogram", "averageHash")
            },
            "histogramIntersection": round(
                histogram_intersection(ref["histogram"], game["histogram"]), 4
            ),
            "perceptualHashHamming": hamming,
            "labDistance": round(lab_distance(Image.open(args.ref), Image.open(path)), 3),
        })
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
    print(json.dumps({
        "out": args.out,
        "frames": [
            {
                "path": frame["path"],
                "histogramIntersection": frame.get("histogramIntersection"),
                "labDistance": frame.get("labDistance"),
                "perceptualHashHamming": frame.get("perceptualHashHamming"),
            }
            for frame in output["frames"]
        ],
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - keep failures readable in CI
        print(json.dumps({"result": "failed", "error": str(error)}))
        sys.exit(1)
