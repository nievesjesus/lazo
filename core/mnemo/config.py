"""Parámetros del sistema. Los valores por defecto siguen la pre-entrega (secciones 5 y 7).

Los umbrales se derivan sobre el conjunto de validación (``mnemo.eval``) y se congelan
junto con el preprocesamiento: si cambia uno, cambia el otro (sección 7.5).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"


@dataclass(frozen=True)
class QualityConfig:
    min_face_px: int = 80            # CU-02 paso 2: se descartan rostros de menos de 80 px de alto
    min_sharpness: float = 60.0      # Var(∇²I) sobre el recorte 112×112 (ec. 1); umbral empírico
    min_brightness: float = 40.0     # media de gris del recorte
    max_brightness: float = 220.0
    min_det_score: float = 0.5
    max_yaw_ratio: float = 0.35      # asimetría nariz-ojos; > valor ⇒ perfil marcado


@dataclass(frozen=True)
class DecisionConfig:
    tau_low: float = 0.30            # por debajo: descartar el cuadro (RF-09)
    tau_high: float = 0.38           # por encima: afirmar sujeto a confirmación (RF-06)
    weak_template_penalty: float = 0.05  # CU-01 A2: plantilla de baja calidad eleva su umbral
    confirm_window: int = 4          # confirmación temporal: 3 de 4 cuadros
    confirm_hits: int = 3
    dwell_ms: int = 1500             # CU-02: el rostro permanece > 1,5 s antes de avisar
    encounter_gap_ms: int = 8000     # sin rostro durante este lapso ⇒ nuevo encuentro (RN-08)
    max_failed_frames: int = 3       # CU-02 E1: tras 3 cuadros inutilizables se interrumpe


@dataclass(frozen=True)
class EnrollmentConfig:
    shots: tuple[str, ...] = ("frontal", "sonrisa", "perfil izq.", "perfil der.", "luz baja")
    min_valid_shots: int = 3         # CU-01 A2
    consent_months: int = 12         # RF-12 / RN-07
    invite_ttl_hours: int = 24       # RF-01


@dataclass(frozen=True)
class Config:
    det_model: Path = MODELS_DIR / "det_500m.onnx"
    rec_model: Path = MODELS_DIR / "w600k_mbf.onnx"
    det_size: int = 640
    max_gallery: int = 50            # 5.1: hasta 50 identidades
    history_days: int = 7            # RF-14
    quality: QualityConfig = field(default_factory=QualityConfig)
    decision: DecisionConfig = field(default_factory=DecisionConfig)
    enrollment: EnrollmentConfig = field(default_factory=EnrollmentConfig)
