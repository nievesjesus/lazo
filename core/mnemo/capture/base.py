"""Abstract capture interface (platform-risk fallback plan: the glasses can be swapped for a
phone or webcam without touching the pipeline).

The pipeline does not know where frames come from. Implementations:

- ``WebcamSource``      — webcam or phone camera through OpenCV (test bench).
- ``VideoFileSource``   — recorded video; replays the same experiment deterministically.
- ``GlassesBridgeSource`` — frames from the Ray-Ban Meta glasses forwarded by the Android app
  (Meta Wearables Device Access Toolkit) over a local socket. In production the app runs the
  pipeline on the phone; the bridge only exists for measuring on the test bench.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Iterator

import numpy as np


@dataclass
class Frame:
    image: np.ndarray        # BGR uint8
    t_ms: float              # monotonic acquisition timestamp
    source: str


class CaptureSource(ABC):
    name: str = "abstract"

    @abstractmethod
    def open(self) -> None: ...

    @abstractmethod
    def read(self) -> Frame | None:
        """Returns the next frame, or None if the source has ended."""

    @abstractmethod
    def close(self) -> None: ...

    def __enter__(self) -> "CaptureSource":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def frames(self) -> Iterator[Frame]:
        while (f := self.read()) is not None:
            yield f

    @staticmethod
    def now_ms() -> float:
        return time.monotonic() * 1000.0
