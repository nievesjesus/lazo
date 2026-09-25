"""Métricas de identificación 1:N en conjunto abierto (sección 7.6).

- FPIR (false positive identification rate): fracción de búsquedas de impostores (personas
  NO enroladas) en las que el sistema afirma una identidad.
- FNIR (false negative identification rate): fracción de búsquedas genuinas en las que el
  sistema no afirma la identidad correcta (se abstiene, descarta o nombra a otra persona).
- Exactitud de rango 1 (galería cerrada), tasa de abstención y curva DET.

El umbral se deriva sobre validación fijando el FPIR objetivo y se congela antes de prueba.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Searches:
    """Resultado de buscar cada sonda contra la galería.

    ``s_max``/``top_id``: similitud máxima e identidad ganadora por sonda.
    ``true_id``: identidad real de la sonda, o None si es un impostor (no enrolado).
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
    """Menor τ tal que FPIR(τ) ≤ objetivo, derivado de la distribución de impostores."""
    imp = np.sort(s.s_max[~s.genuine])[::-1]
    if len(imp) == 0:
        raise ValueError("Se necesitan impostores para calibrar el FPIR")
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
    """Sección 7.7: FNIR por subgrupo a FPIR fijo. ``groups`` etiqueta cada sonda genuina."""
    out = {}
    for g in np.unique(groups[s.genuine]):
        mask = s.genuine & (groups == g)
        sub = Searches(s.s_max[mask], s.top_id[mask], s.true_id[mask])
        out[str(g)] = fnir(sub, tau)
    return out
