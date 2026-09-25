from __future__ import annotations

import socket
import struct

import cv2
import numpy as np

from .base import CaptureSource, Frame


class WebcamSource(CaptureSource):
    """Webcam local, o la cámara de un teléfono expuesta como cámara de continuidad / IP-cam.

    ``device`` acepta un índice (0, 1…) o una URL (p. ej. ``http://192.168.0.10:8080/video``
    de una app tipo IP Webcam montada a la altura de los ojos, como propone la sección 7.3).
    """

    name = "webcam"

    def __init__(self, device: int | str = 0, width: int = 1280, height: int = 720):
        self.device, self.width, self.height = device, width, height
        self.cap: cv2.VideoCapture | None = None

    def open(self) -> None:
        self.cap = cv2.VideoCapture(self.device)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        if not self.cap.isOpened():
            raise RuntimeError(f"No se pudo abrir la cámara {self.device!r}")

    def read(self) -> Frame | None:
        assert self.cap is not None
        ok, img = self.cap.read()
        return Frame(img, self.now_ms(), self.name) if ok else None

    def close(self) -> None:
        if self.cap is not None:
            self.cap.release()


class VideoFileSource(WebcamSource):
    """Igual que la webcam pero con marcas de tiempo del propio video (reproducible)."""

    name = "video"

    def read(self) -> Frame | None:
        assert self.cap is not None
        ok, img = self.cap.read()
        return Frame(img, self.cap.get(cv2.CAP_PROP_POS_MSEC), self.name) if ok else None


class GlassesBridgeSource(CaptureSource):
    """Recibe cuadros JPEG de la app Android (``android/``, modo «puente») por TCP local.

    Protocolo mínimo: por cada cuadro, 8 bytes little-endian (uint32 largo, uint32 t_ms) + JPEG.
    Pensado para ``adb forward tcp:5555 tcp:5555``; nunca sale de la red local del banco.
    """

    name = "rayban-meta"

    def __init__(self, host: str = "127.0.0.1", port: int = 5555):
        self.host, self.port = host, port
        self.sock: socket.socket | None = None

    def open(self) -> None:
        self.sock = socket.create_connection((self.host, self.port), timeout=10)

    def _recv(self, n: int) -> bytes | None:
        assert self.sock is not None
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def read(self) -> Frame | None:
        header = self._recv(8)
        if header is None:
            return None
        length, t_ms = struct.unpack("<II", header)
        payload = self._recv(length)
        if payload is None:
            return None
        img = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
        return Frame(img, float(t_ms), self.name)

    def close(self) -> None:
        if self.sock is not None:
            self.sock.close()
