"""Etapa 03 · Detección con RetinaFace-500MF (SCRFD, paquete buffalo_sc de InsightFace).

Una sola pasada entrega cajas, puntaje y cinco puntos de referencia. Decodificación de
anclas por stride (8/16/32, dos anclas por celda) y supresión de no máximos por IoU.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

STRIDES = (8, 16, 32)
NUM_ANCHORS = 2


@dataclass
class Face:
    bbox: np.ndarray   # (4,) x1, y1, x2, y2 en coordenadas del cuadro original
    score: float
    kps: np.ndarray    # (5, 2): ojo izq., ojo der., nariz, comisura izq., comisura der.

    @property
    def height(self) -> float:
        return float(self.bbox[3] - self.bbox[1])

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])


def iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """IoU entre una caja ``a`` (4,) y un conjunto ``b`` (N, 4)."""
    x1 = np.maximum(a[0], b[:, 0])
    y1 = np.maximum(a[1], b[:, 1])
    x2 = np.minimum(a[2], b[:, 2])
    y2 = np.minimum(a[3], b[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / (area_a + area_b - inter + 1e-9)


def nms(boxes: np.ndarray, scores: np.ndarray, thresh: float = 0.4) -> list[int]:
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        order = rest[iou(boxes[i], boxes[rest]) <= thresh]
    return keep


class FaceDetector:
    def __init__(self, model_path: Path, input_size: int = 640, providers: list[str] | None = None):
        self.session = ort.InferenceSession(str(model_path), providers=providers or ["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.size = input_size
        self._centers: dict[tuple[int, int], np.ndarray] = {}

    def _anchor_centers(self, h: int, w: int, stride: int) -> np.ndarray:
        key = (h, stride)
        if key not in self._centers:
            ys, xs = np.mgrid[:h, :w]
            centers = (np.stack([xs, ys], axis=-1).astype(np.float32) * stride).reshape(-1, 2)
            self._centers[key] = np.repeat(centers, NUM_ANCHORS, axis=0)
        return self._centers[key]

    def detect(self, img_bgr: np.ndarray, score_thresh: float = 0.5, max_faces: int = 0) -> list[Face]:
        # Letterbox: reescala conservando proporción y rellena a size×size.
        h0, w0 = img_bgr.shape[:2]
        scale = self.size / max(h0, w0)
        nh, nw = int(round(h0 * scale)), int(round(w0 * scale))
        canvas = np.zeros((self.size, self.size, 3), dtype=np.uint8)
        canvas[:nh, :nw] = cv2.resize(img_bgr, (nw, nh))
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128.0, (self.size, self.size), (127.5, 127.5, 127.5), swapRB=True)

        outs = self.session.run(None, {self.input_name: blob})
        n = len(STRIDES)
        all_scores, all_boxes, all_kps = [], [], []
        for i, stride in enumerate(STRIDES):
            scores = outs[i].reshape(-1)
            deltas = outs[i + n] * stride
            kdeltas = outs[i + 2 * n] * stride
            fh = fw = self.size // stride
            centers = self._anchor_centers(fh, fw, stride)
            pos = np.where(scores >= score_thresh)[0]
            if pos.size == 0:
                continue
            c = centers[pos]
            d = deltas[pos]
            boxes = np.stack([c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]], axis=-1)
            kps = c[:, None, :] + kdeltas[pos].reshape(-1, 5, 2)
            all_scores.append(scores[pos])
            all_boxes.append(boxes)
            all_kps.append(kps)

        if not all_scores:
            return []
        scores = np.concatenate(all_scores)
        boxes = np.concatenate(all_boxes) / scale
        kps = np.concatenate(all_kps) / scale
        keep = nms(boxes, scores)
        faces = [Face(bbox=boxes[k], score=float(scores[k]), kps=kps[k]) for k in keep]
        faces.sort(key=lambda f: f.height, reverse=True)  # CU-02 A3: el más cercano primero
        return faces[:max_faces] if max_faces else faces
