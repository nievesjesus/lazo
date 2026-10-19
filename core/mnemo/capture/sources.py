from __future__ import annotations

import socket
import struct

import cv2
import numpy as np

from .base import CaptureSource, Frame


class WebcamSource(CaptureSource):
    """Local webcam, or a phone camera exposed as a continuity camera / IP cam.

    ``device`` accepts an index (0, 1…) or a URL (e.g. ``http://192.168.0.10:8080/video``
    from an IP Webcam-style app mounted at eye level).
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
            raise RuntimeError(f"Could not open camera {self.device!r}")

    def read(self) -> Frame | None:
        assert self.cap is not None
        ok, img = self.cap.read()
        return Frame(img, self.now_ms(), self.name) if ok else None

    def close(self) -> None:
        if self.cap is not None:
            self.cap.release()


class VideoFileSource(WebcamSource):
    """Same as the webcam but with the video's own timestamps (reproducible)."""

    name = "video"

    def read(self) -> Frame | None:
        assert self.cap is not None
        ok, img = self.cap.read()
        return Frame(img, self.cap.get(cv2.CAP_PROP_POS_MSEC), self.name) if ok else None


class GlassesBridgeSource(CaptureSource):
    """Receives JPEG frames from the Android app (``android/``, "bridge" mode) over local TCP.

    Minimal protocol: for each frame, 8 bytes little-endian (uint32 length, uint32 t_ms) + JPEG.
    Meant for ``adb forward tcp:5555 tcp:5555``; it never leaves the test bench's local network.
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
