"""
Writes apps/web/src/lib/color-science-data.ts: the measured tables behind the home diagrams.

Every table comes from colour-science (BSD-3-Clause), which carries the published data:
CIE 1931 2° observer and D65 (CIE 015), Wright & Guild 1931 RGB CMFs, MacAdam (1942)
ellipses (Wyszecki & Stiles Table 2(5.4.1), calculated columns), Pointer (1980) gamut,
NPL camera sensitivities (Darrodi et al. 2015) and ANSI/IES TM-30-18 colour vector graphics.

    python3 -m venv .venv && .venv/bin/pip install colour-science==0.4.4
    .venv/bin/python scripts/generate-color-science-data.py
"""

import json
import pathlib
import warnings

warnings.filterwarnings("ignore")

import colour  # noqa: E402
import numpy as np  # noqa: E402

SHAPE = colour.SpectralShape(380, 780, 5)
OUTPUT = pathlib.Path(__file__).resolve().parents[1] / "apps/web/src/lib/color-science-data.ts"


def rounded(values, digits=6):
    return [float(f"{value:.{digits}g}") for value in np.asarray(values, dtype=float).ravel()]


def spectral(distribution):
    return distribution.copy().align(SHAPE).values


cmfs = colour.MSDS_CMFS["CIE 1931 2 Degree Standard Observer"].copy().align(SHAPE)
wright_guild = colour.MSDS_CMFS["Wright & Guild 1931 2 Degree RGB CMFs"].copy().align(SHAPE)
camera = colour.MSDS_CAMERA_SENSITIVITIES["Nikon 5100 (NPL)"].copy().align(SHAPE)
d65 = spectral(colour.SDS_ILLUMINANTS["D65"])

# Pointer's table is LCh(ab) under illuminant C: 16 lightness rings of 36 hues.
pointer_lch = colour.models.DATA_POINTER_GAMUT_VOLUME
assert pointer_lch.shape == (576, 3)
white_c = colour.models.CCS_ILLUMINANT_POINTER_GAMUT
white_d65 = colour.CCS_ILLUMINANTS["CIE 1931 2 Degree Standard Observer"]["D65"]
pointer_xyz = colour.chromatic_adaptation(
    colour.Lab_to_XYZ(colour.LCHab_to_Lab(pointer_lch), white_c),
    colour.xy_to_XYZ(white_c), colour.xy_to_XYZ(white_d65), method="Von Kries", transform="Bradford",
)

# The calculated columns, which Wyszecki & Stiles prefer: x0, y0, 10³a, 10³b, θ°.
macadam = colour.models.DATA_MACADAM_1942_ELLIPSES[:, [0, 1, 5, 6, 7]]

# A pair of reflectances that match under D65 and part under illuminant A. The metameric
# black (invisible under D65) is the smooth wave, from a small fixed set, that parts them most.
weights = cmfs.values * d65[:, None]
illuminant_a = spectral(colour.SDS_ILLUMINANTS["A"])
ramp = np.linspace(0, 1, len(d65))
base = 0.3 + 0.28 * np.exp(-0.5 * ((ramp - 0.42) / 0.18) ** 2)
null = np.eye(len(d65)) - weights @ np.linalg.solve(weights.T @ weights, weights.T)


def lab_under(reflectance, illuminant):
    white = cmfs.values.T @ illuminant
    xyz = cmfs.values.T @ (reflectance * illuminant)
    return colour.XYZ_to_Lab(xyz / white[1], colour.XYZ_to_xy(white / white[1]))


def candidate(frequency, phase):
    black = null @ np.cos(2 * np.pi * frequency * ramp + phase)
    black *= np.minimum((0.97 - base) / np.maximum(black, 1e-9), (base - 0.03) / np.maximum(-black, 1e-9)).min()
    pair = base + black
    return float(np.linalg.norm(lab_under(base, illuminant_a) - lab_under(pair, illuminant_a))), pair


_, metamer = max((candidate(frequency, phase) for frequency in np.arange(1, 4.01, 0.5)
                  for phase in np.linspace(0, np.pi, 4, endpoint=False)), key=lambda item: item[0])
assert metamer.min() >= 0.0299 and metamer.max() <= 0.9701


def tristimulus(reflectance, illuminant):
    k = 1 / (cmfs.values[:, 1] @ illuminant)
    return k * (cmfs.values.T @ (reflectance * illuminant))


assert np.allclose(tristimulus(base, d65), tristimulus(metamer, d65), atol=1e-9)

# TM-30 colour vector graphics: each bin's test average, relative to a unit reference circle.
SOURCES = [
    ("A", "白炽灯 A"), ("FL2", "冷白荧光 F2"), ("FL11", "三基色荧光 F11"), ("HP1", "高压钠灯 HP1"),
    ("LED-B3", "荧光粉 LED B3"), ("LED-RGB1", "RGB LED"), ("LED-V1", "紫光激发 LED V1"),
]
tm30 = []
for key, label in SOURCES:
    spec = colour.quality.colour_fidelity_index_ANSIIESTM3018(colour.SDS_ILLUMINANTS[key], additional_data=True)
    reference, test = np.asarray(spec.averages_reference), np.asarray(spec.averages_test)
    norms = np.hypot(reference[:, 0], reference[:, 1])
    angles = np.arctan2(reference[:, 1], reference[:, 0])
    vector = (test - reference) / norms[:, None] + np.stack([np.cos(angles), np.sin(angles)], axis=1)
    tm30.append({
        "label": label, "cct": round(float(spec.CCT)), "rf": round(float(spec.R_f), 1), "rg": round(float(spec.R_g), 1),
        "reference": rounded(angles, 5), "test": rounded(vector, 5),
    })

tables = {
    "SPECTRUM_START": 380, "SPECTRUM_STEP": 5,
    "CIE_1931_X": rounded(cmfs.values[:, 0]), "CIE_1931_Y": rounded(cmfs.values[:, 1]), "CIE_1931_Z": rounded(cmfs.values[:, 2]),
    "WRIGHT_GUILD_R": rounded(wright_guild.values[:, 0]), "WRIGHT_GUILD_G": rounded(wright_guild.values[:, 1]),
    "WRIGHT_GUILD_B": rounded(wright_guild.values[:, 2]),
    "D65_SPD": rounded(d65),
    "NIKON_5100_R": rounded(camera.values[:, 0]), "NIKON_5100_G": rounded(camera.values[:, 1]),
    "NIKON_5100_B": rounded(camera.values[:, 2]),
    "MACADAM_1942": rounded(macadam, 4),
    "POINTER_XYZ_D65": rounded(pointer_xyz, 5),
    "METAMER_BASE": rounded(base, 5), "METAMER_PAIR": rounded(metamer, 5),
    "TM30_SOURCES": tm30,
}

lines = [
    "// Generated by scripts/generate-color-science-data.py from colour-science 0.4.4. Do not edit.",
    "// Spectra run 380–780 nm in 5 nm steps. MACADAM_1942 rows: x0, y0, 10³a, 10³b, θ°.",
    "// POINTER_XYZ_D65: 16 lightness rings (L* 15–90) of 36 hues, Bradford-adapted from C, Y=1 white.",
    "",
]
for name, value in tables.items():
    lines.append(f"export const {name} = {json.dumps(value, ensure_ascii=False, separators=(',', ':'))} as const;")
OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")
