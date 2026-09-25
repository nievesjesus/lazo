"""Galería cerrada y cifrada (RF-05, RF-10 a RF-12, RN-01, RN-06, RN-07).

- Cada identidad se guarda como un único registro cifrado con AES-256-GCM: plantilla de
  512 floats + metadatos de consentimiento. Nunca se guarda una imagen (RN-02).
- La clave vive fuera de la base. En el prototipo de escritorio es un archivo 0600; en
  Android corresponde a una clave no exportable del Android Keystore (ver ``KeyProvider``).
- Revocar borra la fila; no existe archivo de plantillas revocadas (RN-06). La operación
  queda en la tabla de auditoría, sin datos biométricos.
- Búsqueda exhaustiva: con N ≤ 50 cuesta microsegundos (tabla 7).
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .embedder import EMBEDDING_DIM, l2_normalize

SECONDS_PER_MONTH = 30 * 24 * 3600


class KeyProvider(Protocol):
    def get_key(self) -> bytes: ...


class FileKeyProvider:
    """Clave AES de 256 bits en un archivo con permisos 0600. Sustituto de escritorio del almacén seguro."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def get_key(self) -> bytes:
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(AESGCM.generate_key(bit_length=256))
        return self.path.read_bytes()


@dataclass
class Consent:
    identification: bool = True      # autoriza que el portador reciba nombre y vínculo
    notes: bool = False              # autoriza notas de conversación
    encounter_log: bool = False      # autoriza el registro de encuentros (7 días)


@dataclass
class Identity:
    id: str
    name: str
    relation: str                    # «tu hija», «vecino»…
    phrase: str                      # «Es Marta, tu hija.» (6-9 palabras, RF-07)
    template: np.ndarray             # (512,) normalizado
    consent: Consent
    enrolled_at: float
    expires_at: float
    valid_shots: int
    notes: list[str] = field(default_factory=list)
    context: str = ""                # dato de contexto opcional («vive en Rosario»)

    @property
    def low_quality(self) -> bool:
        return self.valid_shots < 3

    @property
    def expired(self) -> bool:
        return time.time() >= self.expires_at

    def to_payload(self) -> bytes:
        meta = asdict(self)
        meta.pop("template")
        meta["template"] = self.template.astype(np.float32).tobytes().hex()
        return json.dumps(meta).encode()

    @classmethod
    def from_payload(cls, raw: bytes) -> "Identity":
        meta = json.loads(raw)
        meta["template"] = np.frombuffer(bytes.fromhex(meta["template"]), dtype=np.float32).copy()
        meta["consent"] = Consent(**meta["consent"])
        return cls(**meta)


class GalleryFull(Exception):
    pass


class Gallery:
    def __init__(self, db_path: Path, key_provider: KeyProvider, max_size: int = 50):
        self.db = sqlite3.connect(str(db_path))
        self.aead = AESGCM(key_provider.get_key())
        self.max_size = max_size
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, nonce BLOB NOT NULL, blob BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS audit (ts REAL NOT NULL, op TEXT NOT NULL, ref TEXT NOT NULL, detail TEXT);
            """
        )
        self._cache: dict[str, Identity] | None = None

    # -- persistencia ---------------------------------------------------------
    def _encrypt(self, ident: Identity) -> tuple[bytes, bytes]:
        nonce = os.urandom(12)
        return nonce, self.aead.encrypt(nonce, ident.to_payload(), ident.id.encode())

    def _audit(self, op: str, ref: str, detail: str = "") -> None:
        self.db.execute("INSERT INTO audit VALUES (?, ?, ?, ?)", (time.time(), op, ref, detail))

    def _load(self) -> dict[str, Identity]:
        if self._cache is None:
            self._cache = {}
            for id_, nonce, blob in self.db.execute("SELECT id, nonce, blob FROM identities"):
                self._cache[id_] = Identity.from_payload(self.aead.decrypt(nonce, blob, id_.encode()))
        return self._cache

    def _save(self, ident: Identity) -> None:
        nonce, blob = self._encrypt(ident)
        self.db.execute("INSERT OR REPLACE INTO identities VALUES (?, ?, ?)", (ident.id, nonce, blob))
        self._load()[ident.id] = ident

    # -- API ------------------------------------------------------------------
    def enroll(
        self,
        name: str,
        relation: str,
        template: np.ndarray,
        consent: Consent,
        valid_shots: int,
        phrase: str | None = None,
        context: str = "",
        consent_months: int = 12,
    ) -> Identity:
        """RN-01: sólo se invoca desde el flujo de alta con consentimiento del titular."""
        if not consent.identification:
            raise PermissionError("Sin consentimiento de identificación no se crea plantilla (CU-01 A1)")
        if len(self._load()) >= self.max_size:
            raise GalleryFull(f"La galería admite hasta {self.max_size} identidades")
        assert template.shape == (EMBEDDING_DIM,)
        now = time.time()
        ident = Identity(
            id=uuid.uuid4().hex,
            name=name,
            relation=relation,
            phrase=phrase or f"Es {name}, {relation}.",
            template=l2_normalize(template.astype(np.float32)),
            consent=consent,
            enrolled_at=now,
            expires_at=now + consent_months * SECONDS_PER_MONTH,
            valid_shots=valid_shots,
            context=context if consent.notes else "",
        )
        with self.db:
            self._save(ident)
            self._audit("enroll", ident.id, f"shots={valid_shots}")
        return ident

    def update(self, ident_id: str, **changes) -> Identity:
        """RF-10: el cuidador edita vínculo, frase y notas; nunca la plantilla."""
        ident = self._load()[ident_id]
        for k in ("relation", "phrase", "notes", "context"):
            if k in changes:
                if k in ("notes", "context") and not ident.consent.notes:
                    continue  # CU-01 A3: sin consentimiento de notas, la ficha queda sin notas
                setattr(ident, k, changes[k])
        with self.db:
            self._save(ident)
            self._audit("update", ident_id, ",".join(sorted(changes)))
        return ident

    def revoke(self, ident_id: str, by: str = "titular") -> None:
        """RF-11 / RN-06: borrado inmediato, irreversible y auditable."""
        with self.db:
            self.db.execute("DELETE FROM identities WHERE id = ?", (ident_id,))
            self._audit("revoke", ident_id, by)
        self._load().pop(ident_id, None)
        self.db.execute("VACUUM")  # no dejar páginas libres con el blob cifrado

    def active(self) -> list[Identity]:
        """RF-12: las plantillas vencidas quedan desactivadas hasta una nueva aceptación."""
        return [i for i in self._load().values() if not i.expired and i.consent.identification]

    def all(self) -> list[Identity]:
        return list(self._load().values())

    def matrix(self) -> tuple[list[Identity], np.ndarray]:
        ids = self.active()
        if not ids:
            return [], np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
        return ids, np.stack([i.template for i in ids])

    def search(self, query: np.ndarray) -> tuple[Identity | None, float, float]:
        """Etapa 06 · búsqueda 1:N exhaustiva. Devuelve (mejor, s_máx, segunda similitud)."""
        ids, mat = self.matrix()
        if not ids:
            return None, -1.0, -1.0
        sims = mat @ l2_normalize(query)
        order = np.argsort(sims)[::-1]
        second = float(sims[order[1]]) if len(order) > 1 else -1.0
        return ids[int(order[0])], float(sims[order[0]]), second

    def audit_log(self) -> list[tuple[float, str, str, str]]:
        return list(self.db.execute("SELECT ts, op, ref, detail FROM audit ORDER BY ts"))
