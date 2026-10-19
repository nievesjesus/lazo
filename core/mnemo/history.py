"""Encounter log and anonymous discard counter.

Only time, identity and similarity are stored; never images or location. 7-day retention.
Faces with no match only increment a daily counter with no identifier.
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

DAY = 24 * 3600


@dataclass
class Encounter:
    ts: float
    kind: str                # "aviso" (announced) | "abstencion" (abstained) | "desconocido" (unknown)
    identity_id: str | None
    similarity: float
    latency_ms: float
    reported_error: bool = False


class History:
    def __init__(self, db_path: Path, retention_days: int = 7):
        self.db = sqlite3.connect(str(db_path))
        self.retention = retention_days * DAY
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS encounters (
                ts REAL, kind TEXT, identity_id TEXT, similarity REAL, latency_ms REAL, reported_error INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS discards (day TEXT PRIMARY KEY, count INTEGER);
            """
        )

    def purge(self) -> None:
        with self.db:
            self.db.execute("DELETE FROM encounters WHERE ts < ?", (time.time() - self.retention,))

    def log(self, e: Encounter) -> None:
        """If the person did not consent to logging, the caller passes ``identity_id=None``."""
        with self.db:
            self.db.execute(
                "INSERT INTO encounters VALUES (?, ?, ?, ?, ?, ?)",
                (e.ts, e.kind, e.identity_id, e.similarity, e.latency_ms, int(e.reported_error)),
            )
        self.purge()

    def count_discard(self) -> None:
        day = time.strftime("%Y-%m-%d")
        with self.db:
            self.db.execute(
                "INSERT INTO discards VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1", (day,)
            )

    def forget_identity(self, identity_id: str) -> None:
        """Revocation also deletes the associated records."""
        with self.db:
            self.db.execute("DELETE FROM encounters WHERE identity_id = ?", (identity_id,))

    def report_error(self, ts: float) -> None:
        with self.db:
            self.db.execute("UPDATE encounters SET reported_error = 1 WHERE ts = ?", (ts,))

    def recent(self) -> list[Encounter]:
        self.purge()
        rows = self.db.execute("SELECT * FROM encounters ORDER BY ts DESC").fetchall()
        return [Encounter(r[0], r[1], r[2], r[3], r[4], bool(r[5])) for r in rows]
