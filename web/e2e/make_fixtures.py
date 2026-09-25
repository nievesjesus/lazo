"""Genera cámaras falsas (.y4m) a partir de la foto grupal de core/tests/data para la prueba e2e.

marta.y4m: rostro que se enrola y luego debe reconocerse.  other.y4m: rostro frontal NO enrolado.
Uso: ../.venv/bin/python e2e/make_fixtures.py
"""
from pathlib import Path

import cv2

HERE = Path(__file__).parent
OUT = HERE / ".tmp"
OUT.mkdir(exist_ok=True)
img = cv2.imread(str(HERE.parents[1] / "core" / "tests" / "data" / "group.jpg"))


def clip(cx: int, cy: int, s: float = 2.2):
    w, h = 640 / s, 480 / s
    return cv2.resize(img[int(cy - h / 2): int(cy + h / 2), int(cx - w / 2): int(cx + w / 2)], (640, 480))


for name, (cx, cy) in {"marta": (518, 341), "other": (796, 411)}.items():
    frame = cv2.cvtColor(clip(cx, cy), cv2.COLOR_BGR2YUV_I420).tobytes()
    with open(OUT / f"{name}.y4m", "wb") as f:
        f.write(b"YUV4MPEG2 W640 H480 F10:1 Ip A1:1 C420jpeg\n")
        for _ in range(20):
            f.write(b"FRAME\n" + frame)
print(f"Fixtures en {OUT}")
