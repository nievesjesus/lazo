"""Latencia de «¿Quién es?» por voz: transcripción local con faster-whisper (mnemo.voice.Transcriber, CPU, int8).

Genera el WAV con la voz del sistema de macOS (igual que web/e2e/make_fixtures.py), lo pasa por el mismo VAD de
energía que usa el listener para recortar la frase y mide cuánto tarda ``Transcriber`` en devolver el texto.
Si el modelo no está en la caché de Hugging Face hay que descargarlo antes (se usa HF_HUB_OFFLINE=1 para no hacerlo aquí).

    HF_HUB_OFFLINE=1 .venv/bin/python scripts/bench_voz.py [--model base] [--reps 10]
"""
import argparse
import json
import os
import platform
import subprocess
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

from mnemo.voice import FRAME, SAMPLE_RATE, Transcriber, _Vad, is_ask

ROOT = Path(__file__).resolve().parents[1]
VOICE = "Eddy (Español (México))"


def synth(text: str, tmp: Path) -> np.ndarray:
    aiff = tmp / "q.aiff"
    wav = tmp / "q.wav"
    subprocess.run(["say", "-v", VOICE, "-o", str(aiff), text], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(wav)], check=True)
    with wave.open(str(wav)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def stats(xs) -> dict:
    a = np.asarray(xs, dtype=np.float64)
    return {"n": int(a.size), "p50": float(np.percentile(a, 50)), "p95": float(np.percentile(a, 95)),
            "media": float(a.mean()), "min": float(a.min()), "max": float(a.max())}


def time_it(tr: Transcriber, audio: np.ndarray, reps: int) -> tuple[list[float], str]:
    text = tr(audio)  # descartada: warm-up de CTranslate2
    xs = []
    for _ in range(reps):
        t0 = time.perf_counter()
        text = tr(audio)
        xs.append((time.perf_counter() - t0) * 1000)
    return xs, text


def main() -> None:
    ap = argparse.ArgumentParser(description="Latencia de la voz local (faster-whisper)")
    ap.add_argument("--model", default="base")
    ap.add_argument("--reps", type=int, default=10)
    ap.add_argument("--text", default="¿Quién es?")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "eval" / "latencia_voz.json")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as d:
        speech = synth(args.text, Path(d))
    silence = lambda s: np.zeros(int(SAMPLE_RATE * s), dtype=np.float32)
    clip = np.concatenate([silence(2), speech, silence(3)])   # mismo audio que quien.wav del e2e

    segs: list[np.ndarray] = []
    vad = _Vad(segs.append)
    for i in range(0, len(clip) - FRAME, FRAME):
        vad.feed(clip[i:i + FRAME])
    assert segs, "el VAD no recortó ninguna frase"
    seg = segs[0]

    t0 = time.perf_counter()
    tr = Transcriber(args.model)
    load_ms = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter()
    first_text = tr(seg)
    first_ms = (time.perf_counter() - t0) * 1000   # primera llamada (en frío, tras cargar el modelo)

    seg_ms, seg_text = time_it(tr, seg, args.reps)
    clip_ms, clip_text = time_it(tr, clip, args.reps)
    rep = {
        "modelo": f"faster-whisper {args.model} (cpu, int8, beam=1, idioma es)",
        "entorno": {"cpu": subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip(),
                    "sistema": platform.platform(), "carga_inicial": os.getloadavg()},
        "voz_sintetica": VOICE, "frase": args.text,
        "carga_modelo_ms": load_ms, "primera_llamada_ms": first_ms, "primera_llamada_texto": first_text,
        "segmento_vad": {"duracion_s": len(seg) / SAMPLE_RATE, "texto": seg_text, "es_pregunta": is_ask(seg_text),
                         "ms": stats(seg_ms), "factor_tiempo_real_p50": stats(seg_ms)["p50"] / 1000 / (len(seg) / SAMPLE_RATE)},
        "wav_completo": {"duracion_s": len(clip) / SAMPLE_RATE, "texto": clip_text, "es_pregunta": is_ask(clip_text),
                         "ms": stats(clip_ms)},
    }
    args.out.write_text(json.dumps(rep, indent=2, ensure_ascii=False))
    print(json.dumps(rep, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
