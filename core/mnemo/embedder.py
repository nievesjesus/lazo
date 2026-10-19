"""Stage 05 · Embedding with a MobileFaceNet trained with ArcFace (w600k_mbf, WebFace600K).

Output: a 512-dimensional vector normalized onto the hypersphere, so that cosine
similarity reduces to an inner product.
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
        """Takes one or several aligned 112×112 crops and returns (N, 512) normalized vectors."""
        if isinstance(crops_bgr, np.ndarray) and crops_bgr.ndim == 3:
            crops_bgr = [crops_bgr]
        blob = cv2.dnn.blobFromImages(list(crops_bgr), 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        return l2_normalize(self.session.run(None, {self.input_name: blob})[0])


def cosine(q: np.ndarray, t: np.ndarray) -> np.ndarray:
    """s(q, t) = qᵀt / (‖q‖‖t‖) ∈ [−1, 1]."""
    return l2_normalize(t) @ l2_normalize(q)


def template_from_shots(embeddings: np.ndarray) -> np.ndarray:
    """The template is the normalized centroid of the valid shots."""
    return l2_normalize(l2_normalize(embeddings).mean(axis=0))
