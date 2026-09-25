"""Etapa 05 · Embedding con MobileFaceNet entrenada con ArcFace (w600k_mbf, WebFace600K).

Salida: vector de 512 dimensiones normalizado sobre la hiperesfera, de modo que la
similitud coseno de la ec. (5) se reduce a un producto interno.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

EMBEDDING_DIM = 512


def l2_normalize(v: np.ndarray, axis: int = -1) -> np.ndarray:
    return v / (np.linalg.norm(v, axis=axis, keepdims=True) + 1e-12)


class FaceEmbedder:
    def __init__(self, model_path: Path, providers: list[str] | None = None):
        self.session = ort.InferenceSession(str(model_path), providers=providers or ["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def embed(self, crops_bgr: list[np.ndarray] | np.ndarray) -> np.ndarray:
        """Recibe uno o varios recortes alineados de 112×112 y devuelve (N, 512) normalizados."""
        if isinstance(crops_bgr, np.ndarray) and crops_bgr.ndim == 3:
            crops_bgr = [crops_bgr]
        blob = cv2.dnn.blobFromImages(list(crops_bgr), 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        return l2_normalize(self.session.run(None, {self.input_name: blob})[0])


def cosine(q: np.ndarray, t: np.ndarray) -> np.ndarray:
    """s(q, t) = qᵀt / (‖q‖‖t‖) ∈ [−1, 1]  (ec. 5)."""
    return l2_normalize(t) @ l2_normalize(q)


def template_from_shots(embeddings: np.ndarray) -> np.ndarray:
    """RF-04: la plantilla es el centroide normalizado de las tomas válidas."""
    return l2_normalize(l2_normalize(embeddings).mean(axis=0))
