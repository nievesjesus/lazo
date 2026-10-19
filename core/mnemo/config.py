"""System parameters.

Thresholds are derived on the validation set (``mnemo.eval``) and frozen together with the
preprocessing: if one changes, so does the other.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"


@dataclass(frozen=True)
class QualityConfig:
    min_face_px: int = 80            # faces shorter than 80 px are discarded
    min_sharpness: float = 60.0      # Var(∇²I) over the 112×112 crop; empirical threshold
    min_brightness: float = 40.0     # mean gray level of the crop
    max_brightness: float = 220.0
    min_det_score: float = 0.5
    max_yaw_ratio: float = 0.35      # nose-eye asymmetry; above this value ⇒ marked profile


@dataclass(frozen=True)
class DecisionConfig:
    tau_low: float = 0.30            # below: discard the frame
    tau_high: float = 0.38           # at or above: assert, subject to confirmation
    weak_template_penalty: float = 0.05  # a low-quality template raises its threshold
    confirm_window: int = 4          # temporal confirmation: 3 of 4 frames
    confirm_hits: int = 3
    dwell_ms: int = 1500             # the face must stay > 1.5 s before announcing
    encounter_gap_ms: int = 8000     # no face for this long ⇒ new encounter
    max_failed_frames: int = 3       # after 3 unusable frames the cycle is interrupted
    change_threshold: float = 0.45   # minimum cosine with the announced face to remain "the same person"
    change_frames: int = 3           # consecutive frames below it ⇒ person changed ⇒ new encounter
    announce_on_change: bool = True  # when the person changes, announce without being asked
    announce_unknown: bool = True    # say "no es nadie conocido" unprompted (when asked, always)


@dataclass(frozen=True)
class EnrollmentConfig:
    shots: tuple[str, ...] = ("frontal", "sonrisa", "perfil izq.", "perfil der.", "luz baja")
    min_valid_shots: int = 3         # fewer valid shots ⇒ low-quality template
    consent_months: int = 12         # consent validity period
    invite_ttl_hours: int = 24       # enrollment invitation lifetime


@dataclass(frozen=True)
class Config:
    det_model: Path = MODELS_DIR / "det_500m.onnx"
    rec_model: Path = MODELS_DIR / "w600k_mbf.onnx"
    det_size: int = 640
    max_gallery: int = 50            # up to 50 identities
    history_days: int = 7            # encounter-log retention
    quality: QualityConfig = field(default_factory=QualityConfig)
    decision: DecisionConfig = field(default_factory=DecisionConfig)
    enrollment: EnrollmentConfig = field(default_factory=EnrollmentConfig)
