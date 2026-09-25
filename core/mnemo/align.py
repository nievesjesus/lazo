"""Etapa 04 · Alineación como transformación de similitud (ec. 3, Módulo 4).

Se estiman por mínimos cuadrados (Umeyama, 1991) los 4 grados de libertad — escala
isotrópica, rotación y traslación — que llevan los cinco puntos detectados a la
plantilla canónica de ArcFace sobre un recorte de 112×112.
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
    """Devuelve la matriz 2×3 [sR | t] que minimiza Σ‖dst − (sR·src + t)‖²."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    var_s = (xs ** 2).sum() / len(src)
    cov = xd.T @ xs / len(src)
    u, sig, vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[-1] = -1  # evita una reflexión
    r = u @ np.diag(d) @ vt
    s = (sig * d).sum() / var_s
    t = mu_d - s * r @ mu_s
    return np.hstack([s * r, t[:, None]]).astype(np.float32)


def align(img_bgr: np.ndarray, kps: np.ndarray) -> np.ndarray:
    m = similarity_transform(kps)
    return cv2.warpAffine(img_bgr, m, (CROP_SIZE, CROP_SIZE), borderValue=0.0)


def roll_degrees(kps: np.ndarray) -> float:
    """Rotación en el plano estimada a partir de la línea entre los ojos."""
    (lx, ly), (rx, ry) = kps[0], kps[1]
    return float(np.degrees(np.arctan2(ry - ly, rx - lx)))


def yaw_ratio(kps: np.ndarray) -> float:
    """Proxy de giro fuera del plano: desplazamiento de la nariz respecto del centro de los ojos,
    normalizado por la distancia interocular. 0 ≈ frontal; ±0,5 ≈ perfil."""
    eyes_mid = (kps[0] + kps[1]) / 2
    iod = np.linalg.norm(kps[1] - kps[0]) + 1e-6
    return float((kps[2, 0] - eyes_mid[0]) / iod)
