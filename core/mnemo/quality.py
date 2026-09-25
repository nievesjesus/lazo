"""Evaluación de calidad del cuadro/rostro (CU-02 pasos 1-2, RF-03)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .align import yaw_ratio
from .config import QualityConfig
from .detector import Face
from .preprocess import brightness, sharpness


@dataclass
class QualityReport:
    ok: bool
    reason: str | None
    sharpness: float
    brightness: float
    face_px: float
    yaw: float


def assess(face: Face, crop112: np.ndarray, cfg: QualityConfig, allow_profile: bool = False) -> QualityReport:
    sh = sharpness(crop112)
    br = brightness(crop112)
    yaw = yaw_ratio(face.kps)
    reason = None
    if face.score < cfg.min_det_score:
        reason = "detección débil"
    elif face.height < cfg.min_face_px:
        reason = "rostro demasiado pequeño"
    elif sh < cfg.min_sharpness:
        reason = "borroso"
    elif br < cfg.min_brightness:
        reason = "poca luz"
    elif br > cfg.max_brightness:
        reason = "sobreexpuesto"
    elif not allow_profile and abs(yaw) > cfg.max_yaw_ratio:
        reason = "de perfil"
    return QualityReport(reason is None, reason, sh, br, face.height, yaw)
