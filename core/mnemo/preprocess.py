"""Stage 02 · Preprocessing (Gonzalez and Woods, ch. 3 and 5).

Intensity correction + CLAHE on luminance, edge-preserving smoothing (bilateral filter)
and a sharpness metric based on the variance of the Laplacian.
"""
from __future__ import annotations

import cv2
import numpy as np

# Laplacian mask. cv2.filter2D computes correlation (convolution with the kernel flipped);
# since the kernel is symmetric, correlation and convolution coincide.
LAPLACIAN_KERNEL = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)

_clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))


def sharpness(img: np.ndarray) -> float:
    """V = Var(∇²I). Low values indicate blur (from motion or focus)."""
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    lap = cv2.filter2D(gray.astype(np.float32), -1, LAPLACIAN_KERNEL)
    return float(lap.var())


def brightness(img: np.ndarray) -> float:
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(gray.mean())


def gamma_correct(img: np.ndarray, target_mean: float = 120.0) -> np.ndarray:
    """Power-law intensity correction (s = c·r^γ), with γ chosen to bring the mean to the target."""
    mean = max(brightness(img), 1.0) / 255.0
    gamma = np.log(target_mean / 255.0) / np.log(mean)
    gamma = float(np.clip(gamma, 0.4, 2.5))
    lut = np.clip(((np.arange(256) / 255.0) ** gamma) * 255.0, 0, 255).astype(np.uint8)
    return cv2.LUT(img, lut)


def enhance(frame_bgr: np.ndarray, bilateral: bool = True) -> np.ndarray:
    """Normalizes the frame before detection. Works on L* so the color is not altered."""
    img = gamma_correct(frame_bgr)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = _clahe.apply(l)
    img = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
    if bilateral:
        img = cv2.bilateralFilter(img, d=5, sigmaColor=40, sigmaSpace=5)
    return img
