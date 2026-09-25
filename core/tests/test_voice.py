import numpy as np
import pytest

from mnemo.voice import FRAME, SAMPLE_RATE, _Vad, is_ask


@pytest.mark.parametrize("t", ["¿Quién es?", "quien es", "¿Quién está ahí?", "¿Cómo se llama?", "¿Qué es?"])
def test_ask_phrases(t):
    assert is_ask(t)


@pytest.mark.parametrize("t", ["Es Marta, tu hija.", "¿Qué es eso?", "hola, ¿cómo estás?", "¿Que soy?"])
def test_not_ask(t):
    assert not is_ask(t)


def test_vad_cuts_one_segment_between_silences():
    rng = np.random.default_rng(0)
    silence = rng.normal(0, 0.002, SAMPLE_RATE * 2).astype(np.float32)
    t = np.arange(SAMPLE_RATE) / SAMPLE_RATE
    speech = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    audio = np.concatenate([silence, speech, silence])
    segs = []
    vad = _Vad(segs.append)
    for i in range(0, len(audio) - FRAME, FRAME):
        vad.feed(audio[i:i + FRAME])
    assert len(segs) == 1
    assert 0.9 * SAMPLE_RATE < len(segs[0]) < 2.2 * SAMPLE_RATE
