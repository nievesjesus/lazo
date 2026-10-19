"""Listens for «¿quién es?» through the microphone, transcribing on-device with faster-whisper.

An energy-based voice activity detector cuts each utterance; only those fragments are
transcribed. Audio lives in memory and is discarded. The model is downloaded once
(`WhisperModel("base")` caches it in ~/.cache/huggingface) and after that there is no network traffic.

Optional dependencies:  uv pip install -e "core[voice]"
"""
from __future__ import annotations

import queue
import re
import threading
import unicodedata
from typing import Callable

import numpy as np

SAMPLE_RATE = 16000
FRAME = 1024                 # 64 ms
PREROLL_FRAMES = 5
END_SILENCE_MS = 700
MAX_SEGMENT_MS = 4000
MIN_SPEECH_MS = 300

_ASK = re.compile(r"(?<!\w)(qui[eé]n\s+(es|est[aá]|era|ser[aá]|me\s+habla|viene)|c[oó]mo\s+se\s+llama)(?!\w)", re.I)
# Whisper often hears «¿Qué es?» when «¿Quién es?» is said: accepted only as a complete phrase.
_ASK_SHORT = re.compile(r"^[\s¿¡]*(qu[eé]|qui[eé]n)(\s+es)?[\s?!.]*$", re.I)


def is_ask(text: str) -> bool:
    t = unicodedata.normalize("NFC", text)
    return bool(_ASK.search(t) or _ASK_SHORT.match(t))


class Transcriber:
    def __init__(self, model: str = "base", device: str = "cpu", compute_type: str = "int8"):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model, device=device, compute_type=compute_type)

    def __call__(self, audio16k: np.ndarray) -> str:
        segments, _ = self.model.transcribe(audio16k.astype(np.float32), language="es", beam_size=1, vad_filter=False,
            initial_prompt="¿Quién es? ¿Cómo se llama?",  # biases toward the expected question
        )
        return " ".join(s.text for s in segments).strip()


class VoiceListener:
    """Opens the microphone in a thread and calls ``on_ask(text)`` when it hears the question."""

    def __init__(self, on_ask: Callable[[str], None], muted: Callable[[], bool] = lambda: False,
                 transcriber: Transcriber | None = None, on_text: Callable[[str], None] | None = None):
        self.on_ask, self.muted, self.on_text = on_ask, muted, on_text
        self.transcriber = transcriber or Transcriber()
        self._segments: queue.Queue[np.ndarray | None] = queue.Queue()
        self._stream = None
        self._worker = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        import sounddevice as sd

        self._worker.start()
        vad = _Vad(self._segments.put)
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, blocksize=FRAME, dtype="float32",
            callback=lambda data, *_: None if self.muted() else vad.feed(data[:, 0].copy()),
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
        self._segments.put(None)

    def _run(self) -> None:
        while (seg := self._segments.get()) is not None:
            text = self.transcriber(seg)
            if self.on_text:
                self.on_text(text)
            if is_ask(text):
                self.on_ask(text)


class _Vad:
    """Energy-based VAD with an adaptive noise floor (same logic as web/src/voice/listener.ts)."""

    def __init__(self, emit: Callable[[np.ndarray], None]):
        self.emit = emit
        self.pre: list[np.ndarray] = []
        self.seg: list[np.ndarray] | None = None
        self.floor = 0.005
        self.silent_ms = self.speech_ms = 0.0
        self.frame_ms = FRAME / SAMPLE_RATE * 1000

    def feed(self, x: np.ndarray) -> None:
        rms = float(np.sqrt(np.mean(x * x)))
        speaking = rms > max(0.012, self.floor * 3)
        if not speaking:
            self.floor = 0.95 * self.floor + 0.05 * rms
        if self.seg is None:
            self.pre = (self.pre + [x])[-PREROLL_FRAMES:]
            if speaking:
                self.seg, self.silent_ms, self.speech_ms = list(self.pre), 0.0, self.frame_ms
            return
        self.seg.append(x)
        if speaking:
            self.silent_ms, self.speech_ms = 0.0, self.speech_ms + self.frame_ms
        else:
            self.silent_ms += self.frame_ms
        if self.silent_ms >= END_SILENCE_MS or len(self.seg) * self.frame_ms >= MAX_SEGMENT_MS:
            done, self.seg, self.pre = self.seg, None, []
            if self.speech_ms >= MIN_SPEECH_MS:
                self.emit(np.concatenate(done))
