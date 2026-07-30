# Objective grade signature of the reference plates

Measured over all 21 God of War Ragnarök plates in `reference/Reference/` with
`tools/refstats.py`. Run the same tool on any candidate shot and compare.

```bash
python3 tools/refstats.py shots/round3/arena_ots.png
python3 tools/refstats.py reference/Reference --summary
```

These are **objective pass/fail gates**. A shot outside these bands is wrong
regardless of how good it looks in isolation — and "looks fine to me" is not a
rebuttal to a number.

| Metric | Reference median | Acceptable band | What it catches |
|---|---|---|---|
| `black_point` (p0.1 luma) | **0.019** | 0.005 – 0.060 | Crushed blacks. Near 0 = the #1 amateur tell. |
| `pure_black_frac` | **0.0005** | < 0.010 | Dead pixels. The reference essentially never hits pure black. |
| `pure_white_frac` | **0.0001** | < 0.008 | Blown highlights / bad tonemap. |
| `white_point` (p99.9) | **0.921** | 0.75 – 1.00 | Whether anything reaches near-white at all. |
| `contrast_p95_p5` | **0.592** | 0.45 – 0.80 | Flat, foggy, low-contrast renders. |
| `sat_mean` | **0.288** | 0.10 – 0.45 | Oversaturation (the second-most common tell). |
| `sat_p95` | **0.619** | 0.27 – 0.97 | Whether *some* areas are vividly coloured (fires, runes). |
| `luma_pct.p50` | **0.397** | 0.13 – 0.73 | Overall exposure. |
| `detail_far_over_mid` | **0.656** | 0.15 – 1.10 | **Aerial perspective + DOF.** Ratio of high-frequency detail in the far third of frame vs the mid third. Reference backgrounds carry only ~2/3 the detail of the combat plane. A value above ~1.2 means your background is as sharp as your foreground — no fog, no depth of field, instant loss. |

## Split-tone

`warmth_*_RmB` is mean(R) − mean(B) within a tone zone.

| Zone | Reference median | Reading |
|---|---|---|
| shadows | +0.023 | Near neutral, individual plates swing −0.20 (cold ruin) to +0.22 (ember) |
| mids | +0.026 | Near neutral |
| highlights | +0.028 | Slightly warm |

The spread matters more than the median: the **cold overcast** recipe should land
shadows clearly negative (−0.08 to −0.20) with warm highlights, and the **ember**
recipe clearly positive across the board. A shot with all three zones at exactly
0.00 has no grade at all and will read as an untouched engine render.

## How a critic should use this

1. Run `refstats.py` on the candidate.
2. Any metric outside its band is a **hard finding** — name the number.
3. Metrics inside band do *not* mean the shot passes. They only rule out the
   cheapest failures. The blind side-by-side is still the verdict.
