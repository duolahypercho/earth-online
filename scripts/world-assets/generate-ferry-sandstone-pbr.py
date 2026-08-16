#!/usr/bin/env python3
"""Package the approved Poly Haven CC0 sandstone set for the Ferry landmark."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "public/assets"
DEFAULT_DIFFUSE = Path("/tmp/polyhaven-sandstone-blocks-08-diffuse-2k.jpg")
DEFAULT_NORMAL = Path("/tmp/polyhaven-sandstone-blocks-08-normal-gl-2k.jpg")
DEFAULT_ROUGHNESS = Path("/tmp/polyhaven-sandstone-blocks-08-roughness-2k.jpg")
DEFAULT_AO = Path("/tmp/polyhaven-sandstone-blocks-08-ao-2k.jpg")
OUT_DIFFUSE = ASSETS / "polyhaven-sandstone-blocks-08-diffuse-2k.jpg"
OUT_NORMAL = ASSETS / "polyhaven-sandstone-blocks-08-normal-gl-2k.jpg"
OUT_ORM = ASSETS / "polyhaven-sandstone-blocks-08-orm-2k.png"
OUT_MANIFEST = ASSETS / "polyhaven-sandstone-blocks-08.provenance.json"

SOURCES = {
    "diffuse": {
        "url": "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_diff_2k.jpg",
        "md5": "2bd2a87974f1870fad58e25da35ed706",
    },
    "normalGl": {
        "url": "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_nor_gl_2k.jpg",
        "md5": "5156759065d1550ef60475c46611b89b",
    },
    "roughness": {
        "url": "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_rough_2k.jpg",
        "md5": "1f6cd4b874436929d438f8f5ba8818d9",
    },
    "ao": {
        "url": "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_ao_2k.jpg",
        "md5": "f56484d9686107d40e6b483b9cae0d13",
    },
}


def digest(path: Path, algorithm: str) -> str:
    hasher = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def require_source(path: Path, source: dict[str, str]) -> Image.Image:
    if not path.is_file():
        raise FileNotFoundError(f"Missing downloaded Poly Haven source: {path}")
    actual = digest(path, "md5")
    if actual != source["md5"]:
        raise ValueError(f"MD5 mismatch for {path}: expected {source['md5']}, received {actual}")
    return Image.open(path).convert("L")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diffuse", type=Path, default=DEFAULT_DIFFUSE)
    parser.add_argument("--normal", type=Path, default=DEFAULT_NORMAL)
    parser.add_argument("--roughness", type=Path, default=DEFAULT_ROUGHNESS)
    parser.add_argument("--ao", type=Path, default=DEFAULT_AO)
    args = parser.parse_args()

    diffuse = require_source(args.diffuse, SOURCES["diffuse"])
    normal = require_source(args.normal, SOURCES["normalGl"])
    roughness = require_source(args.roughness, SOURCES["roughness"])
    ao = require_source(args.ao, SOURCES["ao"])
    if len({diffuse.size, normal.size, roughness.size, ao.size}) != 1:
        raise ValueError("Poly Haven source maps must share an exact resolution.")

    ASSETS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.diffuse, OUT_DIFFUSE)
    shutil.copyfile(args.normal, OUT_NORMAL)
    orm = np.dstack((
        np.asarray(ao, dtype=np.uint8),
        np.asarray(roughness, dtype=np.uint8),
        np.zeros((ao.height, ao.width), dtype=np.uint8),
    ))
    Image.fromarray(orm).save(OUT_ORM, optimize=False, compress_level=9)

    manifest = {
        "schemaVersion": 1,
        "asset": "polyhaven-sandstone-blocks-08-2k",
        "license": "CC0-1.0",
        "author": "Rob Tuytel",
        "assetPage": "https://polyhaven.com/a/sandstone_blocks_08",
        "physicalWidthMetres": 3,
        "intent": "presentation-only material for an OSM-aligned Ferry Building approximation; not survey or scan reconstruction",
        "sources": {
            key: {
                **source,
                "downloadedMd5": digest(path, "md5"),
                "downloadedSha256": digest(path, "sha256"),
            }
            for key, source, path in [
                ("diffuse", SOURCES["diffuse"], args.diffuse),
                ("normalGl", SOURCES["normalGl"], args.normal),
                ("roughness", SOURCES["roughness"], args.roughness),
                ("ao", SOURCES["ao"], args.ao),
            ]
        },
        "outputs": {
            "diffuse": {
                "path": "public/assets/polyhaven-sandstone-blocks-08-diffuse-2k.jpg",
                "sha256": digest(OUT_DIFFUSE, "sha256"),
                "encoding": "sRGB base color",
            },
            "normalGl": {
                "path": "public/assets/polyhaven-sandstone-blocks-08-normal-gl-2k.jpg",
                "sha256": digest(OUT_NORMAL, "sha256"),
                "encoding": "OpenGL tangent-space normal, linear/no-color",
            },
            "orm": {
                "path": "public/assets/polyhaven-sandstone-blocks-08-orm-2k.png",
                "sha256": digest(OUT_ORM, "sha256"),
                "encoding": "R Poly Haven AO, G Poly Haven roughness, B metallic=0; linear/no-color",
            },
        },
        "generator": {
            "path": "scripts/world-assets/generate-ferry-sandstone-pbr.py",
            "sha256": digest(Path(__file__), "sha256"),
            "algorithm": "lossless copy of verified 2K diffuse/OpenGL normal; deterministic AO+roughness+metallic-zero ORM pack",
            "pillow": Image.__version__,
            "numpy": np.__version__,
        },
    }
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
