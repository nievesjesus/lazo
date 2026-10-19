"""Open-set 1:N identification metrics.

- FPIR (false positive identification rate): fraction of impostor searches (people NOT
  enrolled) in which the system asserts an identity.
- FNIR (false negative identification rate): fraction of genuine searches in which the
  system does not assert the correct identity (it abstains, discards or names someone else).
- Rank-1 accuracy (closed gallery), abstention rate and DET curve.

The threshold is derived on validation by fixing the target FPIR and is frozen before testing.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Searches:
    """Result of searching each probe against the gallery.

    ``s_max``/``top_id``: maximum similarity and winning identity per probe.
    ``true_id``: the probe's true identity, or None if it is an impostor (not enrolled).
    """
    s_max: np.ndarray
    top_id: np.ndarray
    true_id: np.ndarray

    @property
    def genuine(self) -> np.ndarray:
        return np.array([t is not None for t in self.true_id])


def search_all(probes: np.ndarray, probe_ids: list, gallery: np.ndarray, gallery_ids: list) -> Searches:
    sims = probes @ gallery.T
    top = sims.argmax(axis=1)
    return Searches(
        s_max=sims[np.arange(len(probes)), top],
        top_id=np.array([gallery_ids[k] for k in top], dtype=object),
        true_id=np.array(probe_ids, dtype=object),
    )


def fpir(s: Searches, tau: float) -> float:
    imp = ~s.genuine
    return float((s.s_max[imp] >= tau).mean()) if imp.any() else float("nan")


def fnir(s: Searches, tau: float) -> float:
    gen = s.genuine
    if not gen.any():
        return float("nan")
    hit = (s.s_max[gen] >= tau) & (s.top_id[gen] == s.true_id[gen])
    return float(1.0 - hit.mean())


def rank1(s: Searches) -> float:
    gen = s.genuine
    return float((s.top_id[gen] == s.true_id[gen]).mean())


def abstention_rate(s: Searches, tau_low: float, tau_high: float) -> float:
    band = (s.s_max >= tau_low) & (s.s_max < tau_high)
    return float(band.mean())


def det_curve(s: Searches, taus: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    taus = np.linspace(-0.2, 1.0, 241) if taus is None else taus
    return taus, np.array([fpir(s, t) for t in taus]), np.array([fnir(s, t) for t in taus])


def threshold_at_fpir(s: Searches, target: float = 0.01) -> float:
    """Smallest τ such that FPIR(τ) ≤ target, derived from the impostor distribution."""
    imp = np.sort(s.s_max[~s.genuine])[::-1]
    if len(imp) == 0:
        raise ValueError("Impostors are needed to calibrate the FPIR")
    k = int(np.floor(target * len(imp)))
    return float(np.nextafter(imp[k], np.inf)) if k < len(imp) else float(imp[-1])


def report(s: Searches, tau_low: float, tau_high: float) -> dict[str, float]:
    return {
        "FPIR@tau_high": fpir(s, tau_high),
        "FNIR@tau_high": fnir(s, tau_high),
        "rank1": rank1(s),
        "abstencion": abstention_rate(s, tau_low, tau_high),
        "n_genuinas": int(s.genuine.sum()),
        "n_impostoras": int((~s.genuine).sum()),
    }


def subgroup_fnir(s: Searches, groups: np.ndarray, tau: float) -> dict[str, float]:
    """FNIR per subgroup at a fixed FPIR. ``groups`` labels each genuine probe."""
    out = {}
    for g in np.unique(groups[s.genuine]):
        mask = s.genuine & (groups == g)
        sub = Searches(s.s_max[mask], s.top_id[mask], s.true_id[mask])
        out[str(g)] = fnir(sub, tau)
    return out
