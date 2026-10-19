"""End-to-end tests on a group photo (InsightFace, t1.jpg) and unit tests of the rules."""
from pathlib import Path

import cv2
import numpy as np
import pytest

from mnemo.align import ARCFACE_TEMPLATE, align, similarity_transform
from mnemo.config import Config, DecisionConfig
from mnemo.decision import DecisionEngine, Observation, State, Zone
from mnemo.detector import FaceDetector
from mnemo.embedder import FaceEmbedder, l2_normalize, template_from_shots
from mnemo.eval import metrics
from mnemo.eval.run import box_crop
from mnemo.gallery import Consent, FileKeyProvider, Gallery
from mnemo.pipeline import Pipeline
from mnemo.preprocess import sharpness

DATA = Path(__file__).parent / "data"
CFG = Config()
models_present = CFG.det_model.exists() and CFG.rec_model.exists()
needs_models = pytest.mark.skipif(not models_present, reason="run scripts/download_models.sh")


# -- geometry and preprocessing ---------------------------------------------------
def test_similarity_recovers_known_transform():
    theta, s, t = np.radians(15), 1.7, np.array([20.0, -5.0])
    r = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    src = ARCFACE_TEMPLATE.astype(np.float64)
    dst = (s * src @ r.T) + t
    m = similarity_transform(src, dst)
    np.testing.assert_allclose(m[:, :2], s * r, atol=1e-4)
    np.testing.assert_allclose(m[:, 2], t, atol=1e-3)


def test_box_crop_maps_the_box_to_the_whole_crop():
    """Ablation baseline without alignment: a uniform 100×60 box ends up as a 112×112 square."""
    img = np.zeros((300, 400, 3), np.uint8)
    img[110:170, 150:250] = 255
    crop = box_crop(img, np.array([150, 110, 250, 170], dtype=np.float32))
    assert crop.shape == (112, 112, 3)
    assert crop[30:80, 2:-2].min() == 255                               # the longer side (width) fills the crop
    assert crop[:15].max() == 0 and crop[-15:].max() == 0               # above and below remains the margin of the shorter box


def test_sharpness_drops_with_blur():
    rng = np.random.default_rng(0)
    img = (rng.random((112, 112)) * 255).astype(np.uint8)
    assert sharpness(cv2.GaussianBlur(img, (9, 9), 3)) < sharpness(img) / 10


# -- decision -----------------------------------------------------------------------
def run(engine, sims, ident="a", dt=100):
    out = None
    for k, s in enumerate(sims):
        out = engine.step(Observation(k * dt, True, True, ident, s)) or out
    return out


def test_affirms_after_3_of_4_and_dwell():
    e = DecisionEngine(DecisionConfig(dwell_ms=0))
    ann = run(e, [0.6, 0.2, 0.6, 0.6])
    assert ann and ann.kind == Zone.MATCH and ann.hits == 3 and e.state == State.AFFIRMING


def test_dwell_delays_announcement():
    e = DecisionEngine(DecisionConfig(dwell_ms=1500))
    assert run(e, [0.6] * 4) is None          # 300 ms: still observing
    assert run(e, [0.6] * 20) is not None


def test_abstains_in_band_and_never_names():
    e = DecisionEngine(DecisionConfig(dwell_ms=0))
    ann = run(e, [0.33, 0.35, 0.31, 0.34])
    assert ann and ann.kind == Zone.ABSTAIN and ann.identity_id is None


def test_one_phrase_per_encounter_then_new_encounter():
    e = DecisionEngine(DecisionConfig(dwell_ms=0, encounter_gap_ms=1000))
    assert run(e, [0.6] * 4) is not None
    assert run(e, [0.6] * 8) is None                         # same encounter: silence
    e.step(Observation(10_000, False, False))                # leaves for more than 1 s
    assert run(e, [0.6] * 4) is not None


def test_weak_template_raises_threshold():
    e = DecisionEngine(DecisionConfig(dwell_ms=0))
    for k in range(4):
        ann = e.step(Observation(k * 100, True, True, "a", 0.40, weak_template=True)) or None
    assert ann is not None and ann.kind == Zone.ABSTAIN      # 0.40 < 0.38 + 0.05


def face(k):
    v = np.zeros(512, np.float32)
    v[k] = 1
    return v


def see(engine, t0, n, ident, s, emb):
    out = None
    for k in range(n):
        out = engine.step(Observation(t0 + k * 100, True, True, ident, s, embedding=emb)) or out
    return out


def test_face_change_announces_again():
    e = DecisionEngine(DecisionConfig(dwell_ms=0))
    assert see(e, 0, 4, "marta", 0.7, face(0)).identity_id == "marta"
    assert see(e, 400, 6, "marta", 0.7, face(0)) is None          # same person: silence
    b = see(e, 1000, 8, "tomas", 0.7, face(1))
    assert b.identity_id == "tomas" and b.reason == "cambio"


def test_change_silent_until_asked():
    e = DecisionEngine(DecisionConfig(dwell_ms=0, announce_on_change=False))
    see(e, 0, 4, "marta", 0.7, face(0))
    assert see(e, 400, 8, "tomas", 0.7, face(1)) is None
    e.request()
    a = see(e, 1300, 4, "tomas", 0.7, face(1))
    assert a.identity_id == "tomas" and a.reason == "pedido"


def test_unknown_is_announced_and_then_known_person():
    e = DecisionEngine(DecisionConfig(dwell_ms=0))
    assert see(e, 0, 4, None, 0.05, face(2)).kind == Zone.REJECT
    assert see(e, 400, 8, "marta", 0.7, face(0)).identity_id == "marta"


def test_unknown_quiet_unless_asked():
    e = DecisionEngine(DecisionConfig(dwell_ms=0, announce_unknown=False))
    assert see(e, 0, 6, None, 0.05, face(2)) is None
    e.request()
    assert see(e, 700, 4, None, 0.05, face(2)).kind == Zone.REJECT


# -- metrics ------------------------------------------------------------------------
def test_threshold_at_fpir():
    s = metrics.Searches(
        s_max=np.array([0.9, 0.8, 0.1, 0.2, 0.3, 0.35]),
        top_id=np.array(["a", "b", "a", "b", "a", "b"], dtype=object),
        true_id=np.array(["a", "b", None, None, None, None], dtype=object),
    )
    tau = metrics.threshold_at_fpir(s, 0.0)
    assert metrics.fpir(s, tau) == 0.0 and metrics.fnir(s, tau) == 0.0


# -- gallery ------------------------------------------------------------------------
def test_gallery_encrypted_and_revocable(tmp_path):
    g = Gallery(tmp_path / "g.db", FileKeyProvider(tmp_path / "k"))
    v = l2_normalize(np.random.default_rng(1).standard_normal(512).astype(np.float32))
    ident = g.enroll("Marta", "tu hija", v, Consent(), valid_shots=5)
    raw = (tmp_path / "g.db").read_bytes()
    assert b"Marta" not in raw and v.tobytes()[:16] not in raw
    g2 = Gallery(tmp_path / "g.db", FileKeyProvider(tmp_path / "k"))
    best, s, _ = g2.search(v)
    assert best.name == "Marta" and s > 0.99
    g2.revoke(ident.id)
    assert g2.search(v)[0] is None
    assert [op for _, op, _, _ in g2.audit_log()] == ["enroll", "revoke"]
    with pytest.raises(PermissionError):
        g2.enroll("X", "y", v, Consent(identification=False), 5)


# -- real models --------------------------------------------------------------------
@needs_models
def test_detects_group_and_embeddings_discriminate():
    img = cv2.imread(str(DATA / "group.jpg"))
    det, emb = FaceDetector(CFG.det_model), FaceEmbedder(CFG.rec_model)
    faces = det.detect(img)
    assert len(faces) >= 5
    crops = [align(img, f.kps) for f in faces]
    e = emb.embed(crops)
    assert e.shape == (len(faces), 512)
    np.testing.assert_allclose(np.linalg.norm(e, axis=1), 1, atol=1e-5)
    sims = e @ e.T
    off = sims[~np.eye(len(faces), dtype=bool)]
    assert off.max() < 0.30          # different people: below τ_low
    # Same person, perturbed frame (mirror + noise + brightness): well above τ_high.
    rng = np.random.default_rng(0)
    alt = np.clip(cv2.flip(img, 1).astype(np.int16) + rng.integers(-12, 12, img.shape) + 20, 0, 255).astype(np.uint8)
    faces2 = det.detect(alt)
    f0 = faces[0]
    cx = img.shape[1] - (f0.bbox[0] + f0.bbox[2]) / 2
    twin = min(faces2, key=lambda f: abs((f.bbox[0] + f.bbox[2]) / 2 - cx))
    s = float(emb.embed(align(alt, twin.kps))[0] @ e[0])
    assert s > 0.6


@needs_models
def test_pipeline_end_to_end(tmp_path):
    img = cv2.imread(str(DATA / "group.jpg"))
    gallery = Gallery(tmp_path / "g.db", FileKeyProvider(tmp_path / "k"))
    cfg = Config(decision=DecisionConfig(dwell_ms=0))
    pipe = Pipeline(cfg, gallery)
    face = pipe.detector.detect(img, max_faces=1)[0]
    x1, y1, x2, y2 = face.bbox.astype(int)
    h, w = y2 - y1, x2 - x1
    crop = img[max(0, y1 - h): y2 + h, max(0, x1 - w): x2 + w]
    crop = cv2.resize(crop, None, fx=2, fy=2)   # face > 80 px
    vec, q = pipe.enroll_shot(crop, allow_profile=False)
    assert vec is not None, q
    gallery.enroll("Marta", "tu hija", template_from_shots(vec[None]), Consent(), valid_shots=5)
    phrases = [pipe.process(crop, t * 100).phrase for t in range(5)]
    assert "Es Marta, tu hija." in phrases
