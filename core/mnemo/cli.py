"""Banco de pruebas de escritorio.

    python -m mnemo.cli enroll --name Marta --relation "tu hija"   # alta guiada con la webcam
    python -m mnemo.cli live                                        # reconocimiento en vivo
    python -m mnemo.cli live --source http://192.168.0.10:8080/video   # cámara del teléfono (IP-cam)
    python -m mnemo.cli live --source glasses                       # puente desde la app Android
    python -m mnemo.cli list | revoke <id>
"""
from __future__ import annotations

import argparse
import platform
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np

from .capture import CaptureSource, GlassesBridgeSource, WebcamSource
from .config import Config
from .decision import State, Zone
from .embedder import template_from_shots
from .gallery import Consent, FileKeyProvider, Gallery
from .history import Encounter, History
from .pipeline import Pipeline

DATA_DIR = Path.home() / ".mnemo"

COLORS = {Zone.MATCH: (80, 200, 80), Zone.ABSTAIN: (0, 190, 255), Zone.REJECT: (160, 160, 160)}


def open_source(spec: str) -> CaptureSource:
    if spec == "glasses":
        return GlassesBridgeSource()
    return WebcamSource(int(spec) if spec.isdigit() else spec)


def speak(text: str) -> None:
    """TTS local del sistema operativo (tabla 7): sin servicios en la nube."""
    if platform.system() == "Darwin":
        subprocess.Popen(["say", "-v", "Paulina", text])
    else:
        print(f"[aviso al oído] {text}")


def open_stores(cfg: Config) -> tuple[Gallery, History]:
    DATA_DIR.mkdir(exist_ok=True)
    gallery = Gallery(DATA_DIR / "gallery.db", FileKeyProvider(DATA_DIR / "gallery.key"), cfg.max_gallery)
    return gallery, History(DATA_DIR / "history.db", cfg.history_days)


def draw(img: np.ndarray, res, cfg: Config) -> None:
    status = "Procesando en el dispositivo · sin conexion"
    cv2.putText(img, status, (16, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(img, f"estado: {res.state.value}", (16, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
    if res.face is None:
        return
    x1, y1, x2, y2 = res.face.bbox.astype(int)
    color = COLORS.get(res.zone, (200, 200, 200))
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    for x, y in res.face.kps.astype(int):
        cv2.circle(img, (x, y), 3, color, -1)
    label = f"rostro {res.face.score:.2f}"
    if res.quality and not res.quality.ok:
        label += f" · {res.quality.reason}"
    elif res.s_max > -1:
        label += f" · s={res.s_max:.2f}"
        if res.zone == Zone.MATCH and res.candidate:
            label += f" ({res.candidate.name})"
    cv2.putText(img, label, (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)


def cmd_live(args) -> None:
    cfg = Config()
    gallery, history = open_stores(cfg)
    pipe = Pipeline(cfg, gallery)
    print(f"Galería: {len(gallery.active())} identidades activas. 'q' sale, 'p' modo privacidad.")
    privacy = False
    first_seen = None
    discard_counted = False
    with open_source(args.source) as src:
        for frame in src.frames():
            if privacy:
                img = np.zeros_like(frame.image)
                cv2.putText(img, "MODO PRIVACIDAD", (40, 80), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
            else:
                res = pipe.process(frame.image, frame.t_ms)
                if res.face is not None and first_seen is None:
                    first_seen = frame.t_ms
                if res.state == State.IDLE:
                    first_seen, discard_counted = None, False
                if res.state == State.DISCARDING and not discard_counted:
                    history.count_discard()  # RN-04: sólo un evento anónimo en el contador del día
                    discard_counted = True
                if res.phrase:
                    speak(res.phrase)
                    ann = res.announcement
                    kind = "aviso" if ann.kind == Zone.MATCH else "abstencion"
                    ident = next((i for i in gallery.active() if i.id == ann.identity_id), None)
                    history.log(
                        Encounter(time.time(), kind, ann.identity_id, ann.s_max, frame.t_ms - (first_seen or frame.t_ms)),
                        consented=ident.consent.encounter_log if ident else True,
                    )
                    print(f"[{kind}] {res.phrase}  s={ann.s_max:.3f}  {ann.hits}/{ann.window}  {res.timings_ms}")
                img = frame.image.copy()
                draw(img, res, cfg)
            cv2.imshow("MNEMO · vista del portador", img)
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("p"):
                privacy = not privacy
                pipe.engine.reset()
            del frame  # RN-02: el cuadro no sobrevive al ciclo
    cv2.destroyAllWindows()


def cmd_enroll(args) -> None:
    cfg = Config()
    gallery, _ = open_stores(cfg)
    pipe = Pipeline(cfg, gallery)
    print(
        "\nCONSENTIMIENTO (P-04)\n"
        f"Finalidad: ayudar al portador a recordar quién es {args.name} cuando se encuentran.\n"
        "Qué se guarda: un vector numérico de 512 valores, cifrado. No se guardan fotos ni video.\n"
        "Dónde: sólo en este dispositivo. Plazo: 12 meses. Revocable en cualquier momento.\n"
    )
    if input("¿Acepta el titular del dato? [s/N] ").strip().lower() != "s":
        print("Rechazado: no se capturó ninguna imagen (CU-01 A1).")
        return
    notes = input("¿Autoriza notas de conversación? [s/N] ").strip().lower() == "s"
    log = input("¿Autoriza el registro de encuentros (7 días)? [s/N] ").strip().lower() == "s"

    vecs = []
    with open_source(args.source) as src:
        for shot in cfg.enrollment.shots:
            allow_profile = "perfil" in shot
            print(f"Toma «{shot}»: posicionate y presioná ESPACIO (ESC para omitir).")
            while True:
                frame = src.read()
                if frame is None:
                    return
                preview = frame.image.copy()
                cv2.putText(preview, f"Toma: {shot}", (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
                cv2.imshow("MNEMO · captura guiada", preview)
                key = cv2.waitKey(1) & 0xFF
                if key == 27:
                    break
                if key == 32:
                    vec, q = pipe.enroll_shot(frame.image, allow_profile)
                    del frame
                    if vec is None:
                        print(f"  rechazada: {q.reason if q else 'sin rostro'}")
                        continue
                    vecs.append(vec)
                    print(f"  ok (nitidez {q.sharpness:.0f}, {q.face_px:.0f}px)")
                    break
    cv2.destroyAllWindows()
    if not vecs:
        print("Sin tomas válidas: no se creó plantilla.")
        return
    ident = gallery.enroll(
        args.name, args.relation, template_from_shots(np.stack(vecs)),
        Consent(identification=True, notes=notes, encounter_log=log), valid_shots=len(vecs),
        context=args.context or "",
    )
    flag = " (baja calidad: umbral elevado)" if ident.low_quality else ""
    print(f"Plantilla activa para {ident.name} · {len(vecs)} tomas{flag} · id {ident.id[:8]}")


def cmd_list(_args) -> None:
    gallery, _ = open_stores(Config())
    for i in gallery.all():
        state = "vencida" if i.expired else "activa"
        print(f"{i.id[:8]}  {i.name:<16} {i.relation:<14} tomas={i.valid_shots}  {state}  «{i.phrase}»")


def cmd_revoke(args) -> None:
    gallery, history = open_stores(Config())
    match = [i for i in gallery.all() if i.id.startswith(args.id)]
    if len(match) != 1:
        raise SystemExit("Id ambiguo o inexistente")
    gallery.revoke(match[0].id)
    history.forget_identity(match[0].id)
    print(f"Plantilla de {match[0].name} borrada de forma irreversible.")


def main() -> None:
    ap = argparse.ArgumentParser(prog="mnemo")
    sub = ap.add_subparsers(required=True)
    p = sub.add_parser("live")
    p.add_argument("--source", default="0", help="índice de cámara, URL de IP-cam o 'glasses'")
    p.set_defaults(fn=cmd_live)
    p = sub.add_parser("enroll")
    p.add_argument("--name", required=True)
    p.add_argument("--relation", required=True)
    p.add_argument("--context")
    p.add_argument("--source", default="0")
    p.set_defaults(fn=cmd_enroll)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    p = sub.add_parser("revoke")
    p.add_argument("id")
    p.set_defaults(fn=cmd_revoke)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
