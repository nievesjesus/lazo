"""Stage 04 · Alignment as a similarity transform.

Least squares (Umeyama, 1991) estimates the 4 degrees of freedom — isotropic scale,
rotation and translation — that map the five detected landmarks onto the canonical
ArcFace template on a 112×112 crop.
"""
from __future__ import annotations

import cv2
import numpy as np

ARCFACE_TEMPLATE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)
CROP_SIZE = 112


def similarity_transform(src: np.ndarray, dst: np.ndarray = ARCFACE_TEMPLATE) -> np.ndarray:
    """Returns the 2×3 matrix [sR | t] that minimizes Σ‖dst − (sR·src + t)‖²."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    var_s = (xs ** 2).sum() / len(src)
    cov = xd.T @ xs / len(src)
    u, sig, vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[-1] = -1  # avoid a reflection
    r = u @ np.diag(d) @ vt
    s = (sig * d).sum() / var_s
    t = mu_d - s * r @ mu_s
    return np.hstack([s * r, t[:, None]]).astype(np.float32)


def align(img_bgr: np.ndarray, kps: np.ndarray) -> np.ndarray:
    m = similarity_transform(kps)
    return cv2.warpAffine(img_bgr, m, (CROP_SIZE, CROP_SIZE), borderValue=0.0)


def roll_degrees(kps: np.ndarray) -> float:
    """In-plane rotation estimated from the line between the eyes."""
    (lx, ly), (rx, ry) = kps[0], kps[1]
    return float(np.degrees(np.arctan2(ry - ly, rx - lx)))


def yaw_ratio(kps: np.ndarray) -> float:
    """Proxy for out-of-plane turn: nose offset from the eye midpoint, normalized by the
    interocular distance. 0 ≈ frontal; ±0.5 ≈ profile."""
    eyes_mid = (kps[0] + kps[1]) / 2
    iod = np.linalg.norm(kps[1] - kps[0]) + 1e-6
    return float((kps[2, 0] - eyes_mid[0]) / iod)
