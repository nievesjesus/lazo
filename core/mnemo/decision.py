"""Etapa 07 · Decisión con rechazo (sección 7.4; Bishop y Bishop, 2024, §5.2.3).

Regla de tres zonas sobre s_máx:
    s_máx ≥ τ_alta          → afirmar, sujeto a confirmación temporal 3 de 4
    τ_baja ≤ s_máx < τ_alta → abstenerse: «no estoy seguro», sin nombrar
    s_máx < τ_baja          → descartar el cuadro sin registrar nada

Máquina de estados de la tabla 6: En reposo → Observando → Afirmando / Absteniéndose / Descartando.
Un encuentro produce a lo sumo una frase (RN-08).
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import Enum

from .config import DecisionConfig


class State(str, Enum):
    IDLE = "en_reposo"
    OBSERVING = "observando"
    AFFIRMING = "afirmando"
    ABSTAINING = "absteniendose"
    DISCARDING = "descartando"


class Zone(str, Enum):
    MATCH = "match"
    ABSTAIN = "abstain"
    REJECT = "reject"


def classify(s_max: float, tau_low: float, tau_high: float) -> Zone:
    if s_max >= tau_high:
        return Zone.MATCH
    if s_max >= tau_low:
        return Zone.ABSTAIN
    return Zone.REJECT


@dataclass
class Observation:
    """Resultado de un cuadro ya procesado. ``identity_id`` es None si no hubo rostro útil."""
    t_ms: float
    face_present: bool
    usable: bool
    identity_id: str | None = None
    s_max: float = -1.0
    weak_template: bool = False


@dataclass
class Announcement:
    kind: Zone                       # MATCH ⇒ nombrar; ABSTAIN ⇒ «Hay alguien, pero no lo reconozco.»
    identity_id: str | None
    s_max: float
    hits: int
    window: int


class DecisionEngine:
    def __init__(self, cfg: DecisionConfig):
        self.cfg = cfg
        self.state = State.IDLE
        self.window: deque[tuple[Zone, str | None, float]] = deque(maxlen=cfg.confirm_window)
        self.first_seen_ms: float | None = None
        self.last_seen_ms: float | None = None
        self.failed = 0
        self.announced = False       # RN-08: una frase por encuentro

    def reset(self) -> None:
        self.state = State.IDLE
        self.window.clear()
        self.first_seen_ms = self.last_seen_ms = None
        self.failed = 0
        self.announced = False

    def thresholds(self, weak: bool) -> tuple[float, float]:
        bump = self.cfg.weak_template_penalty if weak else 0.0
        return self.cfg.tau_low, self.cfg.tau_high + bump

    def step(self, obs: Observation) -> Announcement | None:
        cfg = self.cfg
        if not obs.face_present:
            if self.last_seen_ms is not None and obs.t_ms - self.last_seen_ms > cfg.encounter_gap_ms:
                self.reset()
            elif not self.announced:
                self.state = State.IDLE
            return None

        if self.first_seen_ms is None:
            self.first_seen_ms = obs.t_ms
        self.last_seen_ms = obs.t_ms

        if self.announced:
            return None  # mismo encuentro: silencio

        if not obs.usable:
            self.failed += 1
            if self.failed >= cfg.max_failed_frames:
                # CU-02 E1: se interrumpe el ciclo sin avisar; se reintenta desde cero.
                self.window.clear()
                self.failed = 0
                self.first_seen_ms = obs.t_ms
            return None
        self.failed = 0

        tau_low, tau_high = self.thresholds(obs.weak_template)
        zone = classify(obs.s_max, tau_low, tau_high)
        self.window.append((zone, obs.identity_id if zone == Zone.MATCH else None, obs.s_max))

        if zone == Zone.REJECT and all(z == Zone.REJECT for z, _, _ in self.window):
            self.state = State.DISCARDING
        else:
            self.state = State.OBSERVING

        dwell_ok = obs.t_ms - self.first_seen_ms >= cfg.dwell_ms
        if len(self.window) < cfg.confirm_hits or not dwell_ok:
            return None

        # Confirmación temporal: misma identidad ganadora en ≥ 3 de los últimos 4 cuadros.
        votes: dict[str, int] = {}
        for z, ident, _ in self.window:
            if z == Zone.MATCH and ident:
                votes[ident] = votes.get(ident, 0) + 1
        if votes:
            best, hits = max(votes.items(), key=lambda kv: kv[1])
            if hits >= cfg.confirm_hits:
                self.state = State.AFFIRMING
                self.announced = True
                s = max(sm for z, i, sm in self.window if i == best)
                return Announcement(Zone.MATCH, best, s, hits, len(self.window))

        abstains = sum(1 for z, _, _ in self.window if z != Zone.REJECT)
        if len(self.window) == cfg.confirm_window and abstains >= cfg.confirm_hits:
            # La mayoría del encuentro cae en la banda intermedia (o hay candidatos inestables).
            self.state = State.ABSTAINING
            self.announced = True
            s = max(sm for _, _, sm in self.window)
            return Announcement(Zone.ABSTAIN, None, s, abstains, len(self.window))
        return None
