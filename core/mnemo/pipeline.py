"""Pipeline de ocho etapas (figura 7): adquisición → preprocesamiento → detección → alineación
→ embedding → búsqueda 1:N → decisión con rechazo → salida.

El cuadro se descarta al terminar ``process``: nada de la imagen sobrevive a la llamada (RN-02).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from .align import align
from .config import Config
from .decision import Announcement, DecisionEngine, Observation, State, Zone, classify
from .detector import Face, FaceDetector
from .embedder import FaceEmbedder
from .gallery import Gallery, Identity
from .preprocess import enhance
from .quality import QualityReport, assess

ABSTAIN_PHRASE = "Hay alguien, pero no lo reconozco."


@dataclass
class FrameResult:
    t_ms: float
    face: Face | None = None
    quality: QualityReport | None = None
    candidate: Identity | None = None
    s_max: float = -1.0
    zone: Zone | None = None
    state: State = State.IDLE
    announcement: Announcement | None = None
    phrase: str | None = None
    timings_ms: dict[str, float] = field(default_factory=dict)


class Pipeline:
    def __init__(self, cfg: Config, gallery: Gallery, providers: list[str] | None = None):
        self.cfg = cfg
        self.gallery = gallery
        self.detector = FaceDetector(cfg.det_model, cfg.det_size, providers)
        self.embedder = FaceEmbedder(cfg.rec_model, providers)
        self.engine = DecisionEngine(cfg.decision)

    # -- utilidades compartidas con el enrolamiento ----------------------------
    def best_face(self, img: np.ndarray) -> tuple[Face | None, np.ndarray | None]:
        faces = self.detector.detect(img, score_thresh=self.cfg.quality.min_det_score, max_faces=1)
        if not faces:
            return None, None
        return faces[0], align(img, faces[0].kps)

    def enroll_shot(self, img_bgr: np.ndarray, allow_profile: bool) -> tuple[np.ndarray | None, QualityReport | None]:
        """Una toma guiada (RF-03/RF-04): devuelve el vector o None si se rechaza. La imagen se descarta."""
        face, crop = self.best_face(enhance(img_bgr))
        if face is None:
            return None, None
        q = assess(face, crop, self.cfg.quality, allow_profile=allow_profile)
        if not q.ok:
            return None, q
        return self.embedder.embed(crop)[0], q

    # -- ciclo de reconocimiento -------------------------------------------------
    def process(self, img_bgr: np.ndarray, t_ms: float) -> FrameResult:
        res = FrameResult(t_ms=t_ms)
        tick = time.perf_counter()

        def lap(name: str) -> None:
            nonlocal tick
            now = time.perf_counter()
            res.timings_ms[name] = (now - tick) * 1000
            tick = now

        img = enhance(img_bgr)
        lap("preproceso")
        face, crop = self.best_face(img)
        lap("deteccion+alineacion")

        if face is None:
            self.engine.step(Observation(t_ms, face_present=False, usable=False))
            res.state = self.engine.state
            return res

        res.face = face
        res.quality = assess(face, crop, self.cfg.quality)
        if not res.quality.ok:
            self.engine.step(Observation(t_ms, face_present=True, usable=False))
            res.state = self.engine.state
            return res

        emb = self.embedder.embed(crop)[0]
        lap("embedding")
        cand, s_max, _ = self.gallery.search(emb)
        lap("busqueda")
        res.candidate, res.s_max = cand, s_max
        weak = bool(cand and cand.low_quality)
        tau_low, tau_high = self.engine.thresholds(weak)
        res.zone = classify(s_max, tau_low, tau_high)
        ann = self.engine.step(
            Observation(t_ms, True, True, cand.id if cand else None, s_max, weak_template=weak)
        )
        lap("decision")
        res.state = self.engine.state
        res.announcement = ann
        if ann is not None:
            if ann.kind == Zone.MATCH:
                res.phrase = next(i.phrase for i in self.gallery.active() if i.id == ann.identity_id)
            else:
                res.phrase = ABSTAIN_PHRASE
        return res
