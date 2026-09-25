"""Genera cámaras falsas (.y4m) a partir de la foto grupal de core/tests/data para la prueba e2e.

marta.y4m: rostro que se enrola y luego debe reconocerse.  other.y4m: rostro frontal NO enrolado.
change.y4m: 8 s de Marta y luego 8 s del desconocido (cambio de persona sin salir de cuadro).
quien.wav: «¿Quién es?» con la voz del sistema (macOS `say`), entre silencios.
Uso: ../.venv/bin/python e2e/make_fixtures.py
"""
import subprocess
import wave
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).parent
OUT = HERE / ".tmp"
OUT.mkdir(exist_ok=True)
img = cv2.imread(str(HERE.parents[1] / "core" / "tests" / "data" / "group.jpg"))


def clip(cx: int, cy: int, s: float = 2.2):
    w, h = 640 / s, 480 / s
    return cv2.resize(img[int(cy - h / 2): int(cy + h / 2), int(cx - w / 2): int(cx + w / 2)], (640, 480))


def y4m(name: str, frames: list):
    with open(OUT / f"{name}.y4m", "wb") as f:
        f.write(b"YUV4MPEG2 W640 H480 F10:1 Ip A1:1 C420jpeg\n")
        for fr in frames:
            f.write(b"FRAME\n" + cv2.cvtColor(fr, cv2.COLOR_BGR2YUV_I420).tobytes())


marta, other = clip(518, 341), clip(796, 411)
y4m("marta", [marta] * 20)
y4m("other", [other] * 20)
y4m("change", [marta] * 80 + [other] * 80)

# Audio: 2 s de silencio, «¿Quién es?», 3 s de silencio, a 16 kHz mono.
aiff = OUT / "quien.aiff"
subprocess.run(["say", "-v", "Eddy (Español (México))", "-o", str(aiff), "¿Quién es?"], check=True)
subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(OUT / "q.wav")], check=True)
with wave.open(str(OUT / "q.wav")) as w:
    speech = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
silence = lambda s: np.zeros(int(16000 * s), dtype=np.int16)
with wave.open(str(OUT / "quien.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(np.concatenate([silence(2), speech, silence(3)]).tobytes())
print(f"Fixtures en {OUT}")
