"""Interfaz de captura abstracta (sección 7.3, «riesgo de plataforma y plan alternativo»).

El pipeline no sabe de dónde vienen los cuadros. Implementaciones:

- ``WebcamSource``      — webcam o cámara del teléfono vía OpenCV (banco de pruebas).
- ``VideoFileSource``   — video grabado; reproduce el mismo experimento de forma determinista.
- ``GlassesBridgeSource`` — cuadros de las Ray-Ban Meta reenviados por la app Android
  (Meta Wearables Device Access Toolkit) por un socket local. En producción la app
  ejecuta el pipeline en el teléfono; el puente sólo existe para medir en el banco de pruebas.
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
    t_ms: float              # marca de tiempo monotónica de adquisición
    source: str


class CaptureSource(ABC):
    name: str = "abstract"

    @abstractmethod
    def open(self) -> None: ...

    @abstractmethod
    def read(self) -> Frame | None:
        """Devuelve el próximo cuadro o None si la fuente terminó."""

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
