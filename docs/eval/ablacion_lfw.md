# Ablation of pipeline stages on LFW

`mnemo-eval` protocol (seed 0, identity-level split, τ_high derived on validation for a target FPIR of 1%, band 0.08). Test probes for each N are in the "n" column; intervals are 95% Wilson intervals.

## Gallery N=10

| Configuration | τ_high | FPIR | FNIR [95% CI] | Rank-1 | Abstention | n (gen. / imp.) | FNIR at FPIR = 1% (τ on test) |
|---|---:|---:|---:|---:|---:|---:|---:|
| full | 0.269 | 0.89% | 2.63% [0.5%–13.5%] | 97.37% | 13.15% | 38 / 1240 | 2.63% |
| no alignment | 0.347 | 0.56% | 5.26% [1.5%–17.3%] | 97.37% | 7.43% | 38 / 1240 | 2.63% |
| no preprocessing | 0.239 | 0.89% | 2.63% [0.5%–13.5%] | 97.37% | 17.37% | 38 / 1240 | 2.63% |
| neither | 0.324 | 1.21% | 2.63% [0.5%–13.5%] | 100.00% | 7.20% | 38 / 1240 | 5.26% |

## Gallery N=25

| Configuration | τ_high | FPIR | FNIR [95% CI] | Rank-1 | Abstention | n (gen. / imp.) | FNIR at FPIR = 1% (τ on test) |
|---|---:|---:|---:|---:|---:|---:|---:|
| full | 0.354 | 0.09% | 3.37% [1.2%–9.4%] | 96.63% | 1.83% | 89 / 1114 | 3.37% |
| no alignment | 0.396 | 0.27% | 13.48% [7.9%–22.1%] | 98.88% | 4.32% | 89 / 1114 | 7.87% |
| no preprocessing | 0.328 | 0.00% | 4.49% [1.8%–11.0%] | 95.51% | 1.58% | 89 / 1114 | 4.49% |
| neither | 0.383 | 0.36% | 10.11% [5.4%–18.1%] | 97.75% | 4.32% | 89 / 1114 | 7.87% |

## Gallery N=50

| Configuration | τ_high | FPIR | FNIR [95% CI] | Rank-1 | Abstention | n (gen. / imp.) | FNIR at FPIR = 1% (τ on test) |
|---|---:|---:|---:|---:|---:|---:|---:|
| full | 0.384 | 0.11% | 2.87% [1.2%–6.5%] | 97.70% | 0.74% | 174 / 904 | 2.87% |
| no alignment | 0.416 | 0.55% | 14.94% [10.4%–21.0%] | 95.98% | 5.38% | 174 / 904 | 13.22% |
| no preprocessing | 0.348 | 0.00% | 3.45% [1.6%–7.3%] | 97.13% | 1.21% | 174 / 904 | 3.45% |
| neither | 0.399 | 0.77% | 9.77% [6.2%–15.1%] | 95.98% | 5.10% | 174 / 904 | 9.20% |

## Population by configuration

| Configuration | Useful identities | Validation / test | Images with no face detected | People with < 2 usable |
|---|---:|---:|---:|---:|
| full | 311 | 155 / 156 | 1 of 2681 | 0 |
| no alignment | 311 | 155 / 156 | 1 of 2681 | 0 |
| no preprocessing | 311 | 155 / 156 | 1 of 2681 | 0 |
| neither | 311 | 155 / 156 | 1 of 2681 | 0 |

## Sensitivity to the abstention band width (full configuration, N = 50)

FNIR, FPIR and rank-1 depend only on τ_high, which does not change with the band: what moves is τ_low and, with it, how many probes fall into «no estoy seguro» ("I'm not sure") instead of being silently discarded.

| Band | τ_low | τ_high | Abstention (all) | Abstention on impostors | Abstention on genuine | FNIR | FPIR |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.04 | 0.344 | 0.384 | 0.00% | 0.00% | 0.00% | 2.87% | 0.11% |
| 0.08 | 0.304 | 0.384 | 0.74% | 0.88% | 0.00% | 2.87% | 0.11% |
| 0.12 | 0.264 | 0.384 | 4.08% | 4.87% | 0.00% | 2.87% | 0.11% |
