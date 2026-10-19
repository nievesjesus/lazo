"""Stage 07 · Decision with rejection (Bishop and Bishop, 2024, §5.2.3).

Three-zone rule over s_max:
    s_max ≥ τ_high            → assert, subject to temporal confirmation (3 of 4)
    τ_low ≤ s_max < τ_high    → abstain: "not sure", without naming anyone
    s_max < τ_low             → nobody in the circle: nothing biometric is recorded

State machine: an encounter produces at most one phrase and ends when there is no face for
``encounter_gap_ms`` or when THE PERSON CHANGES: the frame's embedding stops resembling that
of the already announced face (the "anchor") for ``change_frames`` consecutive frames. The
change is detected by face continuity, not by identity.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import Enum

import numpy as np

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
    """Result of an already processed frame. ``identity_id`` is None if there was no usable face."""
    t_ms: float
    face_present: bool
    usable: bool
    identity_id: str | None = None
    s_max: float = -1.0
    weak_template: bool = False
    embedding: np.ndarray | None = None  # in memory only, to detect a change of person


@dataclass
class Announcement:
    kind: Zone      # MATCH ⇒ name the person · ABSTAIN ⇒ "someone is there, not recognized" · REJECT ⇒ "nobody known"
    identity_id: str | None
    s_max: float
    hits: int
    window: int
    reason: str = "encuentro"  # "encuentro" (encounter) | "cambio" (change) | "pedido" (request)
    latency_ms: float = 0.0


class DecisionEngine:
    def __init__(self, cfg: DecisionConfig):
        self.cfg = cfg
        self.window: deque[tuple[Zone, str | None, float]] = deque(maxlen=cfg.confirm_window)
        self.reset()

    def reset(self) -> None:
        self.state = State.IDLE
        self.window.clear()
        self.first_seen_ms: float | None = None
        self.last_seen_ms: float | None = None
        self.failed = 0
        self.announced = False
        self.anchor: np.ndarray | None = None
        self.change_count = 0
        self.skip_dwell = False
        self.reason = "encuentro"
        self.silent = False

    def request(self) -> None:
        """The wearer asked "who is it?": new encounter right away, no minimum dwell, and it always answers."""
        self.reset()
        self.skip_dwell = True
        self.reason = "pedido"

    def thresholds(self, weak: bool) -> tuple[float, float]:
        bump = self.cfg.weak_template_penalty if weak else 0.0
        return self.cfg.tau_low, self.cfg.tau_high + bump

    def _new_encounter(self, t_ms: float) -> None:
        self.window.clear()
        self.failed = 0
        self.first_seen_ms = t_ms
        self.announced = False
        self.anchor = None
        self.change_count = 0
        self.skip_dwell = True  # the person is already in front of the wearer
        self.reason = "cambio"
        self.silent = not self.cfg.announce_on_change
        self.state = State.OBSERVING

    def _tracks_change(self, emb: np.ndarray) -> bool:
        if self.anchor is None:
            self.anchor = emb.copy()
            return False
        if float(self.anchor @ emb) >= self.cfg.change_threshold:
            self.change_count = 0
            a = 0.85 * self.anchor + 0.15 * emb  # the anchor follows pose and lighting changes
            self.anchor = a / np.linalg.norm(a)
            return False
        self.change_count += 1
        return self.change_count >= self.cfg.change_frames

    def _emit(self, ann: Announcement, obs: Observation) -> Announcement | None:
        self.announced = True
        self.anchor = None if obs.embedding is None else obs.embedding.copy()
        self.change_count = 0
        ann.reason = self.reason
        quiet = self.reason != "pedido" and (
            self.silent or (ann.kind == Zone.REJECT and not self.cfg.announce_unknown)
        )
        return None if quiet else ann

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
            # Stay silent while it is the same person; a change opens a new encounter.
            if obs.usable and obs.embedding is not None and self._tracks_change(obs.embedding):
                self._new_encounter(obs.t_ms)
            else:
                return None

        if not obs.usable:
            self.failed += 1
            if self.failed >= cfg.max_failed_frames:
                # Too many unusable frames: interrupt the cycle silently and retry from scratch.
                self.window.clear()
                self.failed = 0
                self.first_seen_ms = obs.t_ms
            return None
        self.failed = 0

        tau_low, tau_high = self.thresholds(obs.weak_template)
        zone = classify(obs.s_max, tau_low, tau_high)
        self.window.append((zone, obs.identity_id if zone == Zone.MATCH else None, obs.s_max))
        self.state = State.DISCARDING if all(z == Zone.REJECT for z, _, _ in self.window) else State.OBSERVING

        dwell_ok = self.skip_dwell or obs.t_ms - self.first_seen_ms >= cfg.dwell_ms
        if len(self.window) < cfg.confirm_hits or not dwell_ok:
            return None
        latency = obs.t_ms - self.first_seen_ms

        # Temporal confirmation: same winning identity in ≥ 3 of the last 4 frames.
        votes: dict[str, int] = {}
        for z, ident, _ in self.window:
            if z == Zone.MATCH and ident:
                votes[ident] = votes.get(ident, 0) + 1
        if votes:
            best, hits = max(votes.items(), key=lambda kv: kv[1])
            if hits >= cfg.confirm_hits:
                self.state = State.AFFIRMING
                s = max(sm for z, i, sm in self.window if i == best)
                return self._emit(Announcement(Zone.MATCH, best, s, hits, len(self.window), latency_ms=latency), obs)

        if len(self.window) < cfg.confirm_window:
            return None
        rejects = sum(1 for z, _, _ in self.window if z == Zone.REJECT)
        s = max(sm for _, _, sm in self.window)
        if len(self.window) - rejects >= cfg.confirm_hits:
            self.state = State.ABSTAINING
            return self._emit(Announcement(Zone.ABSTAIN, None, s, len(self.window) - rejects, len(self.window), latency_ms=latency), obs)
        if rejects >= cfg.confirm_hits:
            self.state = State.DISCARDING
            return self._emit(Announcement(Zone.REJECT, None, s, rejects, len(self.window), latency_ms=latency), obs)
        return None
