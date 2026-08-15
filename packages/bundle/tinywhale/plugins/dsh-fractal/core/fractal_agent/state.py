"""Single SQLite owner for scope, journal, closeout and audit state."""

from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import stat
import subprocess
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping

from .contract import ContractError
from .paths import (
    PathBoundaryError,
    file_fingerprint,
    git_changed_fingerprints,
    graph_code_file,
    open_directory_no_symlinks,
    safe_project_path,
)
from .util import (
    atomic_write,
    canonical_json,
    has_unsafe_symlink_component,
    parse_time,
    sha256_json,
    sha256_text,
)

SCHEMA_VERSION = 2
CLOSEOUT_TTL_SECONDS = 900
AUDIT_TTL_SECONDS = 900
DOCUMENT_CAPABILITY_TTL_SECONDS = 900
SCOPE_LEASE_HOURS = 24
BASELINE_RETRIES = 3
_MISSING_FINGERPRINT = hashlib.sha256(b"missing\0").hexdigest()


def _default_clock() -> datetime:
    return datetime.now(timezone.utc)


class StateStore:
    """All SQL and transactional state transitions live here."""

    def __init__(
        self,
        state_root: Path,
        *,
        busy_timeout_ms: int = 2_000,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.state_root = state_root.expanduser()
        self.busy_timeout_ms = busy_timeout_ms
        self.clock = clock or _default_clock
        self._prepare_state_root()
        self.database = self.state_root / "state.sqlite3"
        if self.database.is_symlink():
            raise ContractError("path_outside_root", "state database is a symlink")
        self.key_path = self.state_root / ".token-key"
        self._key = self._load_or_create_key()
        self._initialize_schema()

    def _prepare_state_root(self) -> None:
        if has_unsafe_symlink_component(self.state_root):
            raise ContractError("path_outside_root", "state ancestor is a symlink")
        current = self.state_root
        while not current.exists() and current.parent != current:
            current = current.parent
        # Reject a caller-controlled nearest ancestor without treating macOS'
        # stable /var -> /private/var system alias as an invalid state path.
        if current.is_symlink():
            raise ContractError("path_outside_root", "state ancestor is a symlink")
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.state_root.is_symlink() or not self.state_root.is_dir():
            raise ContractError("path_outside_root", "invalid state root")
        os.chmod(self.state_root, 0o700)

    def _load_or_create_key(self) -> bytes:
        try:
            descriptor = os.open(
                self.key_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            descriptor = -1
        if descriptor >= 0:
            try:
                value = secrets.token_bytes(32)
                os.write(descriptor, value)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        if self.key_path.is_symlink():
            raise ContractError("path_outside_root", "token key is a symlink")
        metadata = self.key_path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ContractError("path_outside_root", "token key is non-regular")
        os.chmod(self.key_path, 0o600)
        value = self.key_path.read_bytes()
        if len(value) != 32:
            raise ContractError("state_internal_error", "invalid token key", exit_code=70)
        return value

    def _now(self) -> str:
        return self.clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    def _expires(self, seconds: int) -> str:
        return (
            self.clock().astimezone(timezone.utc) + timedelta(seconds=seconds)
        ).isoformat().replace("+00:00", "Z")

    def _connect(self) -> sqlite3.Connection:
        try:
            connection = sqlite3.connect(
                self.database,
                timeout=self.busy_timeout_ms / 1000,
                isolation_level=None,
            )
            connection.row_factory = sqlite3.Row
            connection.execute(f"PRAGMA busy_timeout={self.busy_timeout_ms}")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            return connection
        except sqlite3.Error as exc:
            raise ContractError(
                "state_internal_error",
                "state database unavailable",
                exit_code=70,
            ) from exc

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except sqlite3.OperationalError as exc:
            connection.rollback()
            if "locked" in str(exc).lower() or "busy" in str(exc).lower():
                raise ContractError(
                    "state_lock_timeout",
                    "state lock timeout",
                    exit_code=75,
                    retryable=True,
                ) from exc
            raise
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @contextmanager
    def read_connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def _initialize_schema(self) -> None:
        connection = self._connect()
        try:
            current_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if current_version > SCHEMA_VERSION:
                raise ContractError(
                    "state_internal_error",
                    "state schema is newer than this runtime",
                    exit_code=70,
                )
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta(
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS projects(
                    id INTEGER PRIMARY KEY,
                    root TEXT NOT NULL UNIQUE,
                    root_hash TEXT NOT NULL UNIQUE,
                    mutation_epoch INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS sessions(
                    id INTEGER PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    runtime_id TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    acknowledged_watermark INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(project_id, runtime_id, session_key)
                );
                CREATE TABLE IF NOT EXISTS scopes(
                    id TEXT PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    session_id INTEGER NOT NULL REFERENCES sessions(id),
                    generation INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    baseline_json TEXT,
                    baseline_digest TEXT,
                    baseline_epoch INTEGER NOT NULL,
                    concurrency_group_id TEXT,
                    created_at TEXT NOT NULL,
                    last_activity_at TEXT NOT NULL,
                    terminal_outcome TEXT,
                    UNIQUE(session_id, generation)
                );
                CREATE TABLE IF NOT EXISTS scope_files(
                    scope_id TEXT NOT NULL REFERENCES scopes(id),
                    path TEXT NOT NULL,
                    before_fingerprint TEXT NOT NULL,
                    last_fingerprint TEXT NOT NULL,
                    PRIMARY KEY(scope_id, path)
                );
                CREATE TABLE IF NOT EXISTS constraint_deliveries(
                    id TEXT PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    session_id INTEGER NOT NULL REFERENCES sessions(id),
                    directory_hash TEXT NOT NULL,
                    rule_fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    delivered_at TEXT,
                    UNIQUE(session_id, directory_hash, rule_fingerprint)
                );
                CREATE TABLE IF NOT EXISTS host_proofs(
                    token_hash TEXT PRIMARY KEY,
                    delivery_id TEXT NOT NULL REFERENCES constraint_deliveries(id),
                    runtime_id TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    proof_type TEXT NOT NULL,
                    native_correlation_hash TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    consumed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS seen_rules(
                    session_id INTEGER NOT NULL REFERENCES sessions(id),
                    directory_hash TEXT NOT NULL,
                    rule_fingerprint TEXT NOT NULL,
                    delivered_at TEXT NOT NULL,
                    PRIMARY KEY(session_id, directory_hash, rule_fingerprint)
                );
                CREATE TABLE IF NOT EXISTS change_events(
                    watermark INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    scope_id TEXT NOT NULL REFERENCES scopes(id),
                    path TEXT NOT NULL,
                    after_fingerprint TEXT NOT NULL,
                    evidence_type TEXT NOT NULL,
                    graph_sync_state TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS unowned_events(
                    id TEXT PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    concurrency_group_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    after_fingerprint TEXT NOT NULL,
                    evidence_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    graph_sync_state TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_decision_id TEXT,
                    occurrence INTEGER NOT NULL,
                    UNIQUE(project_id, concurrency_group_id, path, occurrence)
                );
                CREATE TABLE IF NOT EXISTS closeout_requests(
                    id TEXT PRIMARY KEY,
                    scope_id TEXT NOT NULL REFERENCES scopes(id),
                    session_id INTEGER NOT NULL REFERENCES sessions(id),
                    changed_set_id TEXT NOT NULL,
                    watermark INTEGER NOT NULL,
                    generation INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    files_json TEXT NOT NULL,
                    evidence_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    reminder_count INTEGER NOT NULL DEFAULT 1,
                    receipt_hash TEXT,
                    acknowledged_watermark INTEGER
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_live_closeout
                    ON closeout_requests(scope_id, changed_set_id)
                    WHERE status='live';
                CREATE TABLE IF NOT EXISTS audit_tokens(
                    id TEXT PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    bundle_hash TEXT NOT NULL,
                    bundle_json TEXT NOT NULL,
                    evidence_hash TEXT NOT NULL,
                    skill_version TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    consumed_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_live_audit
                    ON audit_tokens(project_id, bundle_hash)
                    WHERE status='live';
                CREATE TABLE IF NOT EXISTS audit_decisions(
                    id TEXT PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    audit_token_id TEXT NOT NULL REFERENCES audit_tokens(id),
                    bundle_hash TEXT NOT NULL,
                    evidence_hash TEXT NOT NULL,
                    audit_result TEXT NOT NULL,
                    decision_class TEXT NOT NULL,
                    status TEXT NOT NULL,
                    decision_json TEXT NOT NULL,
                    receipt_hash TEXT,
                    gate_hash TEXT,
                    supersedes TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS remediation_tasks(
                    id TEXT PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    audit_decision_id TEXT NOT NULL REFERENCES audit_decisions(id),
                    task_text TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS probe_evidence(
                    id TEXT PRIMARY KEY,
                    runtime_id TEXT NOT NULL,
                    runtime_version TEXT NOT NULL,
                    adapter_version TEXT NOT NULL,
                    capability TEXT NOT NULL,
                    level TEXT NOT NULL,
                    result TEXT NOT NULL,
                    correlation_hash TEXT NOT NULL,
                    observed_at TEXT NOT NULL,
                    fixture INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recovery_log(
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    subject_hash TEXT NOT NULL,
                    reason_code TEXT NOT NULL,
                    detail_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS operations(
                    runtime_id TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    request_digest TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(runtime_id,session_key,operation_id)
                );
                """
            )
            if current_version == 1:
                self._migrate_v1_to_v2(connection)
            decision_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(audit_decisions)")
            }
            if "receipt_hash" not in decision_columns:
                connection.execute(
                    "ALTER TABLE audit_decisions ADD COLUMN receipt_hash TEXT"
                )
            if "gate_hash" not in decision_columns:
                connection.execute(
                    "ALTER TABLE audit_decisions ADD COLUMN gate_hash TEXT"
                )
            connection.execute(
                "INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version',?)",
                (str(SCHEMA_VERSION),),
            )
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        finally:
            connection.close()
        os.chmod(self.database, 0o600)

    @staticmethod
    def _migrate_v1_to_v2(connection: sqlite3.Connection) -> None:
        """Replace permanent fingerprint uniqueness with occurrence identity."""
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(
                "ALTER TABLE change_events RENAME TO change_events_v1"
            )
            connection.execute(
                """
                CREATE TABLE change_events(
                    watermark INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    scope_id TEXT NOT NULL REFERENCES scopes(id),
                    path TEXT NOT NULL,
                    after_fingerprint TEXT NOT NULL,
                    evidence_type TEXT NOT NULL,
                    graph_sync_state TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                INSERT INTO change_events(
                    watermark,project_id,scope_id,path,after_fingerprint,
                    evidence_type,graph_sync_state,created_at
                )
                SELECT watermark,project_id,scope_id,path,after_fingerprint,
                       evidence_type,graph_sync_state,created_at
                FROM change_events_v1
                ORDER BY watermark
                """
            )
            connection.execute("DROP TABLE change_events_v1")

            old_rows = connection.execute(
                """
                SELECT * FROM unowned_events
                ORDER BY project_id,concurrency_group_id,path,created_at,id
                """
            ).fetchall()
            connection.execute(
                "ALTER TABLE unowned_events RENAME TO unowned_events_v1"
            )
            connection.execute(
                """
                CREATE TABLE unowned_events(
                    id TEXT PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    concurrency_group_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    after_fingerprint TEXT NOT NULL,
                    evidence_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    graph_sync_state TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_decision_id TEXT,
                    occurrence INTEGER NOT NULL,
                    UNIQUE(project_id, concurrency_group_id, path, occurrence)
                )
                """
            )
            occurrences: dict[tuple[int, str, str], int] = {}
            for row in old_rows:
                identity = (
                    int(row["project_id"]),
                    str(row["concurrency_group_id"]),
                    str(row["path"]),
                )
                occurrence = occurrences.get(identity, 0) + 1
                occurrences[identity] = occurrence
                connection.execute(
                    """
                    INSERT INTO unowned_events(
                        id,project_id,concurrency_group_id,path,
                        after_fingerprint,evidence_hash,status,
                        graph_sync_state,created_at,resolved_decision_id,
                        occurrence
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        row["id"],
                        row["project_id"],
                        row["concurrency_group_id"],
                        row["path"],
                        row["after_fingerprint"],
                        row["evidence_hash"],
                        row["status"],
                        row["graph_sync_state"],
                        row["created_at"],
                        row["resolved_decision_id"],
                        occurrence,
                    ),
                )
            connection.execute("DROP TABLE unowned_events_v1")
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    def _token(self, purpose: str, *parts: object) -> str:
        message = canonical_json([purpose, *parts]).encode("utf-8")
        digest = hmac.new(self._key, message, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    @staticmethod
    def _token_hash(token: str) -> str:
        return sha256_text(token)

    @staticmethod
    def _opaque(prefix: str, *parts: object) -> str:
        return prefix + sha256_json([*parts, secrets.token_hex(12)])[:40]

    def receipt_attestation(
        self,
        *,
        purpose: str,
        runtime_id: str,
        session_key: str,
        subject_id: str,
        unsigned_core: Mapping[str, Any],
    ) -> str:
        if purpose not in {"sync", "audit"}:
            raise ValueError("unsupported receipt purpose")
        return self._token(
            "receipt-attestation",
            purpose,
            runtime_id,
            session_key,
            subject_id,
            unsigned_core,
        )

    def mark_graph_bootstrap(self, scope_id: str) -> None:
        if not scope_id.startswith("scope_") or len(scope_id) > 96:
            raise ValueError("invalid scope identity")
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)",
                (f"graph_bootstrap_scope:{scope_id}", "1"),
            )

    def scope_requires_graph_bootstrap_review(self, scope_id: str) -> bool:
        if not scope_id.startswith("scope_") or len(scope_id) > 96:
            return False
        with self.read_connection() as connection:
            row = connection.execute(
                "SELECT value FROM schema_meta WHERE key=?",
                (f"graph_bootstrap_scope:{scope_id}",),
            ).fetchone()
            return row is not None and row["value"] == "1"

    def remember_graph_review(
        self,
        changed_set_id: str,
        review: Mapping[str, Any],
    ) -> None:
        if len(changed_set_id) != 64 or any(
            character not in "0123456789abcdef" for character in changed_set_id
        ):
            raise ValueError("invalid changed set identity")
        decision = review.get("decision")
        reason = review.get("reason")
        targets = review.get("targets")
        if (
            decision != "review"
            or not isinstance(reason, str)
            or not reason
            or not isinstance(targets, list)
            or not all(isinstance(item, str) and item for item in targets)
        ):
            raise ValueError("invalid graph review")
        value = canonical_json(
            {
                "decision": "review",
                "reason": reason,
                "targets": sorted(set(targets)),
            }
        )
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO schema_meta(key,value) VALUES(?,?)",
                (f"graph_review:{changed_set_id}", value),
            )

    def graph_review(self, changed_set_id: str) -> dict[str, Any] | None:
        if len(changed_set_id) != 64:
            return None
        with self.read_connection() as connection:
            row = connection.execute(
                "SELECT value FROM schema_meta WHERE key=?",
                (f"graph_review:{changed_set_id}",),
            ).fetchone()
        if row is None:
            return None
        try:
            value = json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            return None
        if (
            not isinstance(value, dict)
            or value.get("decision") != "review"
            or not isinstance(value.get("reason"), str)
            or not isinstance(value.get("targets"), list)
            or not all(isinstance(item, str) for item in value["targets"])
        ):
            return None
        return value

    def remember_document_requirements(
        self,
        changed_set_id: str,
        *,
        targets: list[str],
        candidates: list[Mapping[str, str]],
    ) -> None:
        sanitized = [
            {
                "file_path": str(item["file_path"]),
                "expected_sha256": str(item["expected_sha256"]),
            }
            for item in candidates
        ]
        value = canonical_json(
            {
                "targets": sorted(set(targets)),
                "candidates": sorted(
                    sanitized,
                    key=lambda item: item["file_path"],
                ),
            }
        )
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO schema_meta(key,value) VALUES(?,?)",
                (f"document_requirements:{changed_set_id}", value),
            )

    def document_review_state(self, changed_set_id: str) -> dict[str, Any] | None:
        with self.read_connection() as connection:
            requirement = connection.execute(
                "SELECT value FROM schema_meta WHERE key=?",
                (f"document_requirements:{changed_set_id}",),
            ).fetchone()
            outcomes = connection.execute(
                "SELECT value FROM schema_meta WHERE key LIKE ? ORDER BY key",
                (f"document_review:{changed_set_id}:%",),
            ).fetchall()
        if requirement is None:
            return None
        try:
            value = json.loads(requirement["value"])
            reviewed = [json.loads(row["value"]) for row in outcomes]
        except (TypeError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict) or not isinstance(reviewed, list):
            return None
        return {**value, "reviewed": reviewed}

    def record_document_review(
        self,
        *,
        closeout_request_id: str,
        file_path: str,
        expected_sha256: str,
        after_sha256: str,
        outcome: str,
    ) -> bool:
        if outcome not in {"no_change", "updated"}:
            return False
        context = self.trusted_closeout_context(closeout_request_id)
        if context is None or context["status"] != "live":
            return False
        state = self.document_review_state(str(context["changed_set_id"]))
        if state is None:
            return False
        candidates = state.get("candidates")
        if not isinstance(candidates, list) or not any(
            isinstance(item, Mapping)
            and item.get("file_path") == file_path
            and item.get("expected_sha256") == expected_sha256
            for item in candidates
        ):
            return False
        value = canonical_json(
            {
                "file_path": file_path,
                "expected_sha256": expected_sha256,
                "after_sha256": after_sha256,
                "outcome": outcome,
            }
        )
        key = (
            f"document_review:{context['changed_set_id']}:"
            f"{sha256_text(file_path)}"
        )
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)",
                (key, value),
            )
        return True

    def mint_document_capability(
        self,
        *,
        closeout_request_id: str,
        root: Path,
        path: str,
        expected_sha256: str,
    ) -> str:
        payload = {
            "version": 1,
            "closeout_request_id": closeout_request_id,
            "root_hash": sha256_text(str(root.resolve(strict=True))),
            "path": path,
            "expected_sha256": expected_sha256,
            "expires_at": self._expires(DOCUMENT_CAPABILITY_TTL_SECONDS),
        }
        encoded = base64.urlsafe_b64encode(
            canonical_json(payload).encode("utf-8")
        ).decode("ascii").rstrip("=")
        signature = self._token("document-capability", payload)
        return encoded + "." + signature

    def verify_document_capability(self, token: str) -> dict[str, Any] | None:
        encoded, separator, signature = token.partition(".")
        if not separator or not encoded or not signature or len(token) > 4096:
            return None
        try:
            padding = "=" * ((4 - len(encoded) % 4) % 4)
            decoded = base64.urlsafe_b64decode(encoded + padding)
            payload = json.loads(decoded.decode("utf-8", errors="strict"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or set(payload) != {
            "version",
            "closeout_request_id",
            "root_hash",
            "path",
            "expected_sha256",
            "expires_at",
        }:
            return None
        if payload.get("version") != 1:
            return None
        if not all(
            isinstance(payload.get(field), str) and payload[field]
            for field in (
                "closeout_request_id",
                "root_hash",
                "path",
                "expected_sha256",
                "expires_at",
            )
        ):
            return None
        if parse_time(payload["expires_at"]) <= self.clock():
            return None
        expected = self._token("document-capability", payload)
        if not hmac.compare_digest(signature, expected):
            return None
        return payload

    def reserve_operation(
        self,
        *,
        runtime_id: str,
        session_key: str,
        operation_id: str,
        action: str,
        request_digest: str,
    ) -> tuple[str, dict[str, Any] | None]:
        """Reserve an idempotency key before an action can perform side effects."""
        pending = canonical_json({"pending": True})
        with self.transaction() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO operations(
                    runtime_id,session_key,operation_id,action,request_digest,
                    response_json,created_at
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (
                    runtime_id,
                    session_key,
                    operation_id,
                    action,
                    request_digest,
                    pending,
                    self._now(),
                ),
            )
            row = connection.execute(
                """
                SELECT * FROM operations
                WHERE runtime_id=? AND session_key=? AND operation_id=?
                """,
                (runtime_id, session_key, operation_id),
            ).fetchone()
            assert row is not None
            if row["action"] != action or row["request_digest"] != request_digest:
                raise ContractError(
                    "contract_field_invalid",
                    "operation id reused with different request",
                )
            if cursor.rowcount == 1:
                return "reserved", None
            response = json.loads(row["response_json"])
            if response == {"pending": True}:
                return "pending", None
            return "completed", response

    def complete_operation(
        self,
        *,
        runtime_id: str,
        session_key: str,
        operation_id: str,
        action: str,
        request_digest: str,
        response: Mapping[str, Any],
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            row = connection.execute(
                """
                SELECT * FROM operations
                WHERE runtime_id=? AND session_key=? AND operation_id=?
                """,
                (runtime_id, session_key, operation_id),
            ).fetchone()
            if (
                row is None
                or row["action"] != action
                or row["request_digest"] != request_digest
            ):
                raise ContractError(
                    "contract_field_invalid",
                    "operation reservation mismatch",
                )
            current = json.loads(row["response_json"])
            if current != {"pending": True}:
                return current
            connection.execute(
                """
                UPDATE operations SET response_json=?
                WHERE runtime_id=? AND session_key=? AND operation_id=?
                """,
                (
                    canonical_json(response),
                    runtime_id,
                    session_key,
                    operation_id,
                ),
            )
            return dict(response)

    def operation_result(
        self,
        *,
        runtime_id: str,
        session_key: str,
        operation_id: str,
        action: str,
        request_digest: str,
    ) -> dict[str, Any] | None:
        with self.read_connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM operations
                WHERE runtime_id=? AND session_key=? AND operation_id=?
                """,
                (runtime_id, session_key, operation_id),
            ).fetchone()
            if row is None:
                return None
            if row["action"] != action or row["request_digest"] != request_digest:
                raise ContractError(
                    "contract_field_invalid",
                    "operation id reused with different request",
                )
            return json.loads(row["response_json"])

    def remember_operation(
        self,
        *,
        runtime_id: str,
        session_key: str,
        operation_id: str,
        action: str,
        request_digest: str,
        response: Mapping[str, Any],
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO operations(
                    runtime_id,session_key,operation_id,action,request_digest,
                    response_json,created_at
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (
                    runtime_id,
                    session_key,
                    operation_id,
                    action,
                    request_digest,
                    canonical_json(response),
                    self._now(),
                ),
            )
            row = connection.execute(
                """
                SELECT * FROM operations
                WHERE runtime_id=? AND session_key=? AND operation_id=?
                """,
                (runtime_id, session_key, operation_id),
            ).fetchone()
            assert row is not None
            if row["action"] != action or row["request_digest"] != request_digest:
                raise ContractError(
                    "contract_field_invalid",
                    "operation id reused with different request",
                )
            return json.loads(row["response_json"])

    def _ensure_project_session(
        self,
        connection: sqlite3.Connection,
        root: Path,
        runtime_id: str,
        session_key: str,
    ) -> tuple[sqlite3.Row, sqlite3.Row]:
        root_value = str(root.resolve(strict=True))
        root_hash = sha256_text(root_value)
        connection.execute(
            "INSERT OR IGNORE INTO projects(root,root_hash) VALUES(?,?)",
            (root_value, root_hash),
        )
        project = connection.execute(
            "SELECT * FROM projects WHERE root=?",
            (root_value,),
        ).fetchone()
        assert project is not None
        connection.execute(
            """
            INSERT OR IGNORE INTO sessions(project_id,runtime_id,session_key)
            VALUES(?,?,?)
            """,
            (project["id"], runtime_id, session_key),
        )
        session = connection.execute(
            """
            SELECT * FROM sessions
            WHERE project_id=? AND runtime_id=? AND session_key=?
            """,
            (project["id"], runtime_id, session_key),
        ).fetchone()
        assert session is not None
        return project, session

    def _scope_row(
        self,
        connection: sqlite3.Connection,
        scope_id: str,
        runtime_id: str,
        session_key: str,
    ) -> sqlite3.Row:
        row = connection.execute(
            """
            SELECT sc.*,p.root,p.root_hash,p.mutation_epoch,
                   s.runtime_id,s.session_key,s.acknowledged_watermark,
                   s.id AS session_row_id
            FROM scopes sc
            JOIN projects p ON p.id=sc.project_id
            JOIN sessions s ON s.id=sc.session_id
            WHERE sc.id=?
            """,
            (scope_id,),
        ).fetchone()
        if (
            row is None
            or row["runtime_id"] != runtime_id
            or row["session_key"] != session_key
        ):
            raise ContractError("contract_field_invalid", "scope binding mismatch")
        return row

    def begin_scope(
        self,
        root: Path,
        runtime_id: str,
        session_key: str,
        mode: str,
    ) -> dict[str, Any]:
        now = self._now()
        with self.transaction() as connection:
            project, session = self._ensure_project_session(
                connection,
                root,
                runtime_id,
                session_key,
            )
            lease_cutoff = (
                self.clock().astimezone(timezone.utc)
                - timedelta(hours=SCOPE_LEASE_HOURS)
            ).isoformat().replace("+00:00", "Z")
            connection.execute(
                """
                UPDATE scopes SET status='orphaned',terminal_outcome='lease_expired'
                WHERE project_id=? AND status IN ('initializing','active')
                  AND last_activity_at<?
                """,
                (project["id"], lease_cutoff),
            )
            existing = connection.execute(
                """
                SELECT * FROM scopes
                WHERE session_id=? AND status IN ('initializing','active')
                ORDER BY generation DESC LIMIT 1
                """,
                (session["id"],),
            ).fetchone()
            if existing is not None:
                value = self._scope_result(
                    existing,
                    project,
                    session,
                    status=(
                        "existing"
                        if existing["status"] == "active"
                        else "initializing"
                    ),
                )
                if existing["status"] == "initializing":
                    value.update(
                        reason_code="state_scope_initializing",
                        retryable=True,
                    )
                return value
            generation = int(
                connection.execute(
                    "SELECT COALESCE(MAX(generation),0)+1 FROM scopes WHERE session_id=?",
                    (session["id"],),
                ).fetchone()[0]
            )
            scope_id = self._opaque(
                "scope_",
                project["root_hash"],
                runtime_id,
                session_key,
                generation,
            )
            connection.execute(
                """
                INSERT INTO scopes(
                    id,project_id,session_id,generation,status,mode,
                    baseline_epoch,created_at,last_activity_at
                ) VALUES(?,?,?,?,'initializing',?,?,?,?)
                """,
                (
                    scope_id,
                    project["id"],
                    session["id"],
                    generation,
                    mode,
                    project["mutation_epoch"],
                    now,
                    now,
                ),
            )
            overlaps = connection.execute(
                """
                SELECT * FROM scopes
                WHERE project_id=? AND id<>? AND status IN ('initializing','active')
                ORDER BY created_at
                """,
                (project["id"], scope_id),
            ).fetchall()
            if overlaps:
                group_id = next(
                    (
                        row["concurrency_group_id"]
                        for row in overlaps
                        if row["concurrency_group_id"]
                    ),
                    None,
                ) or self._opaque("group_", project["root_hash"], now)
                connection.execute(
                    """
                    UPDATE scopes SET concurrency_group_id=?
                    WHERE project_id=? AND status IN ('initializing','active')
                      AND (concurrency_group_id IS NULL OR concurrency_group_id='')
                    """,
                    (group_id, project["id"]),
                )
            baseline_epoch = int(project["mutation_epoch"])

        baseline: dict[str, str] = {}
        for attempt in range(BASELINE_RETRIES):
            baseline = git_changed_fingerprints(root)
            baseline_digest = sha256_json(baseline)
            with self.transaction() as connection:
                scope = self._scope_row(
                    connection,
                    scope_id,
                    runtime_id,
                    session_key,
                )
                project = connection.execute(
                    "SELECT * FROM projects WHERE id=?",
                    (scope["project_id"],),
                ).fetchone()
                session = connection.execute(
                    "SELECT * FROM sessions WHERE id=?",
                    (scope["session_id"],),
                ).fetchone()
                assert project is not None and session is not None
                raced = int(project["mutation_epoch"]) != baseline_epoch
                if raced:
                    group_id = scope["concurrency_group_id"] or self._opaque(
                        "group_",
                        project["root_hash"],
                        now,
                    )
                    connection.execute(
                        """
                        UPDATE scopes SET concurrency_group_id=?
                        WHERE project_id=? AND status IN ('initializing','active')
                          AND (concurrency_group_id IS NULL OR concurrency_group_id='')
                        """,
                        (group_id, project["id"]),
                    )
                    baseline_epoch = int(project["mutation_epoch"])
                    if attempt + 1 < BASELINE_RETRIES:
                        continue
                connection.execute(
                    """
                    UPDATE scopes
                    SET status='active',baseline_json=?,baseline_digest=?,
                        baseline_epoch=?,last_activity_at=?
                    WHERE id=?
                    """,
                    (
                        canonical_json(baseline),
                        baseline_digest,
                        baseline_epoch,
                        self._now(),
                        scope_id,
                    ),
                )
                activated = connection.execute(
                    "SELECT * FROM scopes WHERE id=?",
                    (scope_id,),
                ).fetchone()
                assert activated is not None
                return self._scope_result(
                    activated,
                    project,
                    session,
                    status="created",
                )
        raise AssertionError("bounded baseline loop did not activate scope")

    @staticmethod
    def _scope_result(
        scope: Mapping[str, Any],
        project: Mapping[str, Any],
        session: Mapping[str, Any],
        *,
        status: str,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "reason_code": "state_scope_active",
            "scope_id": scope["id"],
            "project_hash": project["root_hash"],
            "baseline_watermark": session["acknowledged_watermark"],
            "baseline_digest": scope["baseline_digest"],
            "concurrent": bool(scope["concurrency_group_id"]),
            "concurrency_group_id": scope["concurrency_group_id"],
        }

    def scope_info(
        self,
        scope_id: str,
        runtime_id: str,
        session_key: str,
        *,
        require_active: bool = True,
    ) -> dict[str, Any]:
        with self.read_connection() as connection:
            row = self._scope_row(connection, scope_id, runtime_id, session_key)
            if require_active and row["status"] == "initializing":
                raise ContractError(
                    "state_scope_initializing",
                    "scope baseline is incomplete",
                    exit_code=75,
                    retryable=True,
                )
            if require_active and row["status"] != "active":
                raise ContractError("contract_field_invalid", "scope is not active")
            return {
                **dict(row),
                "baseline": json.loads(row["baseline_json"] or "{}"),
            }

    @staticmethod
    def _head_fingerprint(root: Path, relative_path: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(root), "show", f"HEAD:{relative_path}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode != 0:
            return _MISSING_FINGERPRINT
        digest = hashlib.sha256()
        digest.update(b"file\0")
        digest.update(result.stdout)
        return digest.hexdigest()

    @staticmethod
    def _head_fingerprints(
        root: Path,
        relative_paths: set[str],
    ) -> dict[str, str]:
        """Read multiple HEAD blobs through one NUL-delimited Git process."""
        paths = sorted(relative_paths)
        if not paths:
            return {}
        payload = b"".join(
            b"HEAD:"
            + path.encode("utf-8", errors="surrogateescape")
            + b"\0"
            for path in paths
        )
        try:
            result = subprocess.run(
                ["git", "-C", str(root), "cat-file", "--batch", "-Z"],
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ContractError(
                "state_internal_error",
                "git HEAD batch unavailable",
                exit_code=75,
                retryable=True,
            ) from exc
        if result.returncode != 0:
            raise ContractError(
                "state_internal_error",
                "git HEAD batch failed",
                exit_code=75,
                retryable=True,
            )
        output = result.stdout
        offset = 0
        fingerprints: dict[str, str] = {}
        for path in paths:
            header_end = output.find(b"\0", offset)
            if header_end < 0:
                raise ContractError(
                    "state_internal_error",
                    "malformed Git HEAD batch",
                    exit_code=75,
                    retryable=True,
                )
            header = output[offset:header_end]
            offset = header_end + 1
            if header.endswith(b" missing"):
                fingerprints[path] = _MISSING_FINGERPRINT
                continue
            parts = header.rsplit(b" ", 2)
            if len(parts) != 3 or parts[1] != b"blob":
                raise ContractError(
                    "state_internal_error",
                    "unexpected Git HEAD object",
                    exit_code=75,
                    retryable=True,
                )
            try:
                size = int(parts[2])
            except ValueError as exc:
                raise ContractError(
                    "state_internal_error",
                    "malformed Git HEAD object size",
                    exit_code=75,
                    retryable=True,
                ) from exc
            content_end = offset + size
            if content_end >= len(output) or output[content_end] != 0:
                raise ContractError(
                    "state_internal_error",
                    "truncated Git HEAD object",
                    exit_code=75,
                    retryable=True,
                )
            digest = hashlib.sha256()
            digest.update(b"file\0")
            digest.update(output[offset:content_end])
            fingerprints[path] = digest.hexdigest()
            offset = content_end + 1
        if offset != len(output):
            raise ContractError(
                "state_internal_error",
                "unexpected Git HEAD batch output",
                exit_code=75,
                retryable=True,
            )
        return fingerprints

    def reconcile_scope(
        self,
        *,
        scope_id: str,
        runtime_id: str,
        session_key: str,
    ) -> list[dict[str, Any]]:
        """Journal every detectable scope-relative Git diff before closeout."""
        scope = self.scope_info(scope_id, runtime_id, session_key)
        root = Path(scope["root"]).resolve(strict=True)
        current = git_changed_fingerprints(root)
        with self.read_connection() as connection:
            observed = {
                str(row["path"]): {
                    "before_fingerprint": str(row["before_fingerprint"]),
                    "last_fingerprint": str(row["last_fingerprint"]),
                }
                for row in connection.execute(
                    """
                    SELECT path,before_fingerprint,last_fingerprint
                    FROM scope_files WHERE scope_id=?
                    """,
                    (scope_id,),
                )
            }
            group_latest: dict[str, str] = {}
            if scope["concurrency_group_id"]:
                group_latest = {
                    str(row["path"]): str(row["after_fingerprint"])
                    for row in connection.execute(
                        """
                        SELECT event.path,event.after_fingerprint
                        FROM unowned_events event
                        JOIN (
                            SELECT path,MAX(occurrence) AS occurrence
                            FROM unowned_events
                            WHERE project_id=? AND concurrency_group_id=?
                            GROUP BY path
                        ) latest
                          ON latest.path=event.path
                         AND latest.occurrence=event.occurrence
                        WHERE event.project_id=?
                          AND event.concurrency_group_id=?
                        """,
                        (
                            scope["project_id"],
                            scope["concurrency_group_id"],
                            scope["project_id"],
                            scope["concurrency_group_id"],
                        ),
                    )
                }
        all_paths = set(scope["baseline"]) | set(current) | set(observed)
        head_paths = {
            path
            for path in all_paths
            if path not in current
            or (path not in scope["baseline"] and path not in observed)
        }
        head = self._head_fingerprints(root, head_paths)
        results: list[dict[str, Any]] = []
        for path in sorted(all_paths):
            after = current.get(path, head.get(path, _MISSING_FINGERPRINT))
            latest = (
                group_latest.get(path)
                if scope["concurrency_group_id"]
                else observed.get(path, {}).get("last_fingerprint")
            )
            if latest == after:
                continue
            before = scope["baseline"].get(path)
            if before is None:
                before = observed.get(path, {}).get("last_fingerprint")
            if before is None:
                before = head[path]
            if before == after:
                continue
            result = self.record_change(
                scope_id=scope_id,
                runtime_id=runtime_id,
                session_key=session_key,
                path=path,
                before_fingerprint=before,
                after_fingerprint=after,
                evidence_type="observed_final_diff",
                graph_relevant=graph_code_file(Path(path)),
            )
            results.append(result)
        return results

    def active_scope_contexts(self) -> list[dict[str, Any]]:
        with self.read_connection() as connection:
            rows = connection.execute(
                """
                SELECT sc.id AS scope_id,p.root,s.runtime_id,s.session_key
                FROM scopes sc
                JOIN projects p ON p.id=sc.project_id
                JOIN sessions s ON s.id=sc.session_id
                WHERE sc.status='active'
                ORDER BY sc.created_at
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def remember_before(
        self,
        scope_id: str,
        runtime_id: str,
        session_key: str,
        path: str,
        fingerprint: str,
    ) -> None:
        with self.transaction() as connection:
            self._scope_row(connection, scope_id, runtime_id, session_key)
            connection.execute(
                """
                INSERT OR IGNORE INTO scope_files(
                    scope_id,path,before_fingerprint,last_fingerprint
                ) VALUES(?,?,?,?)
                """,
                (scope_id, path, fingerprint, fingerprint),
            )

    def known_fingerprint(self, scope_id: str, path: str) -> str | None:
        with self.read_connection() as connection:
            row = connection.execute(
                "SELECT last_fingerprint FROM scope_files WHERE scope_id=? AND path=?",
                (scope_id, path),
            ).fetchone()
            return None if row is None else str(row["last_fingerprint"])

    def prepare_delivery(
        self,
        *,
        scope_id: str,
        runtime_id: str,
        session_key: str,
        directory_hash: str,
        rule_fingerprint: str,
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            scope = self._scope_row(connection, scope_id, runtime_id, session_key)
            if scope["status"] != "active":
                raise ContractError("contract_field_invalid", "scope is not active")
            seen = connection.execute(
                """
                SELECT 1 FROM seen_rules
                WHERE session_id=? AND directory_hash=? AND rule_fingerprint=?
                """,
                (scope["session_id"], directory_hash, rule_fingerprint),
            ).fetchone()
            if seen is not None:
                return {
                    "status": "already_applied",
                    "reason_code": "rule_already_applied",
                    "rule_fingerprint": rule_fingerprint,
                }
            delivery = connection.execute(
                """
                SELECT * FROM constraint_deliveries
                WHERE session_id=? AND directory_hash=? AND rule_fingerprint=?
                """,
                (scope["session_id"], directory_hash, rule_fingerprint),
            ).fetchone()
            generation = 1
            delivery_id = "delivery_" + sha256_json(
                [scope["session_id"], directory_hash, rule_fingerprint]
            )[:40]
            if delivery is not None:
                generation = int(delivery["generation"])
                if delivery["status"] == "delivered":
                    return {
                        "status": "already_applied",
                        "reason_code": "rule_already_applied",
                        "rule_fingerprint": rule_fingerprint,
                    }
                if parse_time(delivery["expires_at"]) <= self.clock():
                    generation += 1
            token = self._token(
                "delivery",
                delivery_id,
                generation,
                runtime_id,
                session_key,
            )
            now = self._now()
            connection.execute(
                """
                INSERT INTO constraint_deliveries(
                    id,project_id,session_id,directory_hash,rule_fingerprint,
                    status,generation,token_hash,created_at,expires_at
                ) VALUES(?,?,?,?,?,'pending',?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    status='pending',generation=excluded.generation,
                    token_hash=excluded.token_hash,created_at=excluded.created_at,
                    expires_at=excluded.expires_at
                """,
                (
                    delivery_id,
                    scope["project_id"],
                    scope["session_id"],
                    directory_hash,
                    rule_fingerprint,
                    generation,
                    self._token_hash(token),
                    now,
                    self._expires(CLOSEOUT_TTL_SECONDS),
                ),
            )
            return {
                "status": "applied",
                "reason_code": "rule_delivery_pending",
                "delivery_token": token,
                "rule_fingerprint": rule_fingerprint,
            }

    def confirm_delivery(
        self,
        *,
        runtime_id: str,
        session_key: str,
        token: str,
        proof_type: str,
        proof_correlation: str,
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            delivery = connection.execute(
                """
                SELECT d.*,s.runtime_id,s.session_key
                FROM constraint_deliveries d
                JOIN sessions s ON s.id=d.session_id
                WHERE d.token_hash=?
                """,
                (self._token_hash(token),),
            ).fetchone()
            if (
                delivery is None
                or delivery["runtime_id"] != runtime_id
                or delivery["session_key"] != session_key
            ):
                return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
            if parse_time(delivery["expires_at"]) <= self.clock():
                return {"status": "stale", "reason_code": "audit_evidence_stale"}
            proof = connection.execute(
                """
                SELECT * FROM host_proofs
                WHERE token_hash=? AND delivery_id=?
                """,
                (self._token_hash(proof_correlation), delivery["id"]),
            ).fetchone()
            if (
                proof is None
                or proof["runtime_id"] != runtime_id
                or proof["session_key"] != session_key
                or proof["proof_type"] != proof_type
                or parse_time(proof["expires_at"]) <= self.clock()
            ):
                return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
            if delivery["status"] == "delivered" and proof["consumed_at"]:
                return {
                    "status": "duplicate",
                    "reason_code": "event_duplicate",
                    "rule_fingerprint": delivery["rule_fingerprint"],
                }
            if delivery["status"] != "pending" or proof["consumed_at"]:
                return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
            now = self._now()
            connection.execute(
                """
                UPDATE constraint_deliveries
                SET status='delivered',delivered_at=? WHERE id=?
                """,
                (now, delivery["id"]),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO seen_rules(
                    session_id,directory_hash,rule_fingerprint,delivered_at
                ) VALUES(?,?,?,?)
                """,
                (
                    delivery["session_id"],
                    delivery["directory_hash"],
                    delivery["rule_fingerprint"],
                    now,
                ),
            )
            connection.execute(
                "UPDATE host_proofs SET consumed_at=? WHERE token_hash=?",
                (now, proof["token_hash"]),
            )
            return {
                "status": "confirmed",
                "reason_code": "rule_delivery_confirmed",
                "rule_fingerprint": delivery["rule_fingerprint"],
            }

    def issue_host_proof(
        self,
        *,
        runtime_id: str,
        session_key: str,
        delivery_token: str,
        proof_type: str,
        native_correlation_id: str,
    ) -> str:
        """Mint a state-owned proof after a host bridge reports native acceptance."""
        if (
            proof_type
            not in {"host_acceptance_callback", "causal_retry_event"}
            or not isinstance(native_correlation_id, str)
            or not native_correlation_id.strip()
            or hmac.compare_digest(native_correlation_id, delivery_token)
        ):
            raise ContractError(
                "contract_field_invalid",
                "invalid host proof evidence",
            )
        with self.transaction() as connection:
            delivery = connection.execute(
                """
                SELECT d.*,s.runtime_id,s.session_key
                FROM constraint_deliveries d
                JOIN sessions s ON s.id=d.session_id
                WHERE d.token_hash=?
                """,
                (self._token_hash(delivery_token),),
            ).fetchone()
            if (
                delivery is None
                or delivery["runtime_id"] != runtime_id
                or delivery["session_key"] != session_key
                or delivery["status"] != "pending"
                or parse_time(delivery["expires_at"]) <= self.clock()
            ):
                raise ContractError(
                    "audit_receipt_invalid",
                    "delivery cannot receive host proof",
                )
            native_hash = sha256_text(native_correlation_id)
            proof = self._token(
                "host-proof",
                delivery["id"],
                delivery["generation"],
                runtime_id,
                session_key,
                proof_type,
                native_hash,
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO host_proofs(
                    token_hash,delivery_id,runtime_id,session_key,proof_type,
                    native_correlation_hash,expires_at
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (
                    self._token_hash(proof),
                    delivery["id"],
                    runtime_id,
                    session_key,
                    proof_type,
                    native_hash,
                    delivery["expires_at"],
                ),
            )
            return proof

    def record_change(
        self,
        *,
        scope_id: str,
        runtime_id: str,
        session_key: str,
        path: str,
        before_fingerprint: str,
        after_fingerprint: str,
        evidence_type: str,
        graph_relevant: bool,
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            scope = self._scope_row(connection, scope_id, runtime_id, session_key)
            if scope["status"] == "initializing":
                raise ContractError(
                    "state_scope_initializing",
                    "scope baseline is incomplete",
                    exit_code=75,
                    retryable=True,
                )
            if scope["status"] != "active":
                raise ContractError("contract_field_invalid", "scope is not active")
            known = connection.execute(
                "SELECT last_fingerprint FROM scope_files "
                "WHERE scope_id=? AND path=?",
                (scope_id, path),
            ).fetchone()
            if (
                known is not None
                and known["last_fingerprint"] == after_fingerprint
                and not scope["concurrency_group_id"]
            ):
                return {"status": "duplicate", "reason_code": "event_duplicate"}
            connection.execute(
                """
                INSERT INTO scope_files(
                    scope_id,path,before_fingerprint,last_fingerprint
                ) VALUES(?,?,?,?)
                ON CONFLICT(scope_id,path) DO UPDATE SET
                    last_fingerprint=excluded.last_fingerprint
                """,
                (scope_id, path, before_fingerprint, after_fingerprint),
            )
            if scope["concurrency_group_id"]:
                latest = connection.execute(
                    """
                    SELECT id,occurrence,after_fingerprint,resolved_decision_id
                    FROM unowned_events
                    WHERE project_id=? AND concurrency_group_id=? AND path=?
                    ORDER BY occurrence DESC LIMIT 1
                    """,
                    (
                        scope["project_id"],
                        scope["concurrency_group_id"],
                        path,
                    ),
                ).fetchone()
                if (
                    latest is not None
                    and latest["after_fingerprint"] == after_fingerprint
                ):
                    return {
                        "status": "duplicate",
                        "reason_code": "event_duplicate",
                    }
                occurrence = (
                    1 if latest is None else int(latest["occurrence"]) + 1
                )
                event_id = "unowned_" + sha256_json(
                    [
                        scope["project_id"],
                        scope["concurrency_group_id"],
                        path,
                        occurrence,
                        after_fingerprint,
                    ]
                )[:40]
                superseded_decision = (
                    None if latest is None else latest["resolved_decision_id"]
                )
                if latest is not None:
                    connection.execute(
                        """
                        UPDATE unowned_events SET status='superseded'
                        WHERE id=? AND status='unresolved'
                        """,
                        (latest["id"],),
                    )
                connection.execute(
                    """
                    INSERT INTO unowned_events(
                        id,project_id,concurrency_group_id,path,after_fingerprint,
                        evidence_hash,status,graph_sync_state,created_at,
                        resolved_decision_id,occurrence
                    ) VALUES(?,?,?,?,?,?,'unresolved',?,?,?,?)
                    """,
                    (
                        event_id,
                        scope["project_id"],
                        scope["concurrency_group_id"],
                        path,
                        after_fingerprint,
                        sha256_json([path, after_fingerprint, evidence_type]),
                        "pending" if graph_relevant else "not_applicable",
                        self._now(),
                        superseded_decision,
                        occurrence,
                    ),
                )
                connection.execute(
                    "UPDATE projects SET mutation_epoch=mutation_epoch+1 WHERE id=?",
                    (scope["project_id"],),
                )
                return {
                    "status": "recorded_unowned",
                    "reason_code": "capability_fallback",
                    "event_kind": "unowned",
                    "event_id": event_id,
                    "project_root": scope["root"],
                }
            cursor = connection.execute(
                """
                INSERT INTO change_events(
                    project_id,scope_id,path,after_fingerprint,evidence_type,
                    graph_sync_state,created_at
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (
                    scope["project_id"],
                    scope_id,
                    path,
                    after_fingerprint,
                    evidence_type,
                    "pending" if graph_relevant else "not_applicable",
                    self._now(),
                ),
            )
            watermark = int(cursor.lastrowid)
            connection.execute(
                "UPDATE projects SET mutation_epoch=mutation_epoch+1 WHERE id=?",
                (scope["project_id"],),
            )
            return {
                "status": "recorded",
                "reason_code": "event_recorded",
                "event_kind": "owned",
                "event_id": str(watermark),
                "watermark": watermark,
                "project_root": scope["root"],
            }

    def mark_graph_applied(self, event_kind: str, event_id: str) -> None:
        with self.transaction() as connection:
            if event_kind == "owned":
                connection.execute(
                    """
                    UPDATE change_events SET graph_sync_state='applied'
                    WHERE watermark=?
                    """,
                    (int(event_id),),
                )
            else:
                connection.execute(
                    """
                    UPDATE unowned_events SET graph_sync_state='applied'
                    WHERE id=?
                    """,
                    (event_id,),
                )

    def mark_session_graph_paths_applied(
        self,
        *,
        session_id: int,
        watermark: int,
        paths: list[str],
    ) -> None:
        normalized = sorted(set(paths))
        if not normalized:
            return
        placeholders = ",".join("?" for _item in normalized)
        with self.transaction() as connection:
            connection.execute(
                f"""
                UPDATE change_events SET graph_sync_state='applied'
                WHERE scope_id IN (
                    SELECT id FROM scopes WHERE session_id=?
                )
                  AND watermark<=?
                  AND graph_sync_state='pending'
                  AND path IN ({placeholders})
                """,
                (session_id, watermark, *normalized),
            )

    def pending_graph_events(self) -> list[dict[str, Any]]:
        with self.read_connection() as connection:
            owned = connection.execute(
                """
                SELECT 'owned' AS event_kind,CAST(c.watermark AS TEXT) AS event_id,
                       c.path,p.root
                FROM change_events c JOIN projects p ON p.id=c.project_id
                WHERE c.graph_sync_state='pending'
                """
            ).fetchall()
            unowned = connection.execute(
                """
                SELECT 'unowned' AS event_kind,u.id AS event_id,u.path,p.root
                FROM unowned_events u JOIN projects p ON p.id=u.project_id
                WHERE u.graph_sync_state='pending'
                """
            ).fetchall()
            return [dict(row) for row in (*owned, *unowned)]

    def _changed_rows(
        self,
        connection: sqlite3.Connection,
        session_id: int,
        acknowledged: int,
    ) -> list[dict[str, Any]]:
        rows = connection.execute(
            """
            SELECT c.path,c.after_fingerprint,c.watermark
            FROM change_events c JOIN scopes sc ON sc.id=c.scope_id
            WHERE sc.session_id=? AND c.watermark>?
              AND c.watermark=(
                  SELECT MAX(newest.watermark)
                  FROM change_events newest
                  JOIN scopes newest_scope ON newest_scope.id=newest.scope_id
                  WHERE newest_scope.session_id=sc.session_id
                    AND newest.path=c.path
                    AND newest.watermark>?
              )
            ORDER BY c.path
            """,
            (session_id, acknowledged, acknowledged),
        ).fetchall()
        return [
            {
                "path": row["path"],
                "after_fingerprint": row["after_fingerprint"],
                "watermark": int(row["watermark"]),
            }
            for row in rows
        ]

    def current_changed_set(
        self,
        session_id: int,
        runtime_id: str,
        session_key: str,
    ) -> dict[str, Any]:
        with self.read_connection() as connection:
            session = connection.execute(
                "SELECT * FROM sessions WHERE id=?",
                (session_id,),
            ).fetchone()
            if (
                session is None
                or session["runtime_id"] != runtime_id
                or session["session_key"] != session_key
            ):
                raise ContractError("contract_field_invalid", "session mismatch")
            rows = self._changed_rows(
                connection,
                session_id,
                int(session["acknowledged_watermark"]),
            )
            watermark = max(
                [int(session["acknowledged_watermark"])]
                + [int(row["watermark"]) for row in rows]
            )
            files = [
                {
                    "path": row["path"],
                    "after_fingerprint": row["after_fingerprint"],
                }
                for row in rows
            ]
            changed_set_id = sha256_json(
                [
                    runtime_id,
                    session_key,
                    int(session["acknowledged_watermark"]),
                    watermark,
                    files,
                ]
            )
            return {
                "files": files,
                "watermark": watermark,
                "changed_set_id": changed_set_id,
                "acknowledged_watermark": int(session["acknowledged_watermark"]),
            }

    def create_closeout_request(
        self,
        *,
        scope_id: str,
        runtime_id: str,
        session_key: str,
        changed_set: Mapping[str, Any],
        evidence_hash: str,
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            scope = self._scope_row(connection, scope_id, runtime_id, session_key)
            unowned_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM unowned_events
                    WHERE project_id=? AND status='unresolved'
                    """,
                    (scope["project_id"],),
                ).fetchone()[0]
            )
            if not changed_set["files"]:
                return {
                    "status": (
                        "needs_unowned_audit"
                        if unowned_count
                        else "clean"
                    ),
                    "reason_code": (
                        "capability_fallback"
                        if unowned_count
                        else "rule_none"
                    ),
                    "changed_files": [],
                    "unowned_count": unowned_count,
                }
            completed = connection.execute(
                """
                SELECT * FROM closeout_requests
                WHERE scope_id=? AND changed_set_id=? AND status='completed'
                ORDER BY generation DESC LIMIT 1
                """,
                (scope_id, changed_set["changed_set_id"]),
            ).fetchone()
            if completed is not None:
                return {
                    "status": "duplicate",
                    "reason_code": "event_duplicate",
                    "closeout_request_id": completed["id"],
                    "changed_set_id": completed["changed_set_id"],
                    "watermark": completed["watermark"],
                    "changed_files": json.loads(completed["files_json"]),
                    "evidence_hash": completed["evidence_hash"],
                    "acknowledged_watermark": completed["acknowledged_watermark"],
                    "unowned_count": unowned_count,
                }
            live = connection.execute(
                """
                SELECT * FROM closeout_requests
                WHERE scope_id=? AND changed_set_id=? AND status='live'
                """,
                (scope_id, changed_set["changed_set_id"]),
            ).fetchone()
            if live is not None and parse_time(live["expires_at"]) > self.clock():
                connection.execute(
                    """
                    UPDATE closeout_requests
                    SET reminder_count=reminder_count+1 WHERE id=?
                    """,
                    (live["id"],),
                )
                return {
                    "status": "already_reminded",
                    "reason_code": "event_duplicate",
                    "closeout_request_id": live["id"],
                    "changed_set_id": live["changed_set_id"],
                    "watermark": live["watermark"],
                    "changed_files": json.loads(live["files_json"]),
                    "evidence_hash": live["evidence_hash"],
                    "unowned_count": unowned_count,
                }
            if live is not None:
                connection.execute(
                    "UPDATE closeout_requests SET status='expired' WHERE id=?",
                    (live["id"],),
                )
            generation = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(generation),0)+1 FROM closeout_requests
                    WHERE scope_id=? AND changed_set_id=?
                    """,
                    (scope_id, changed_set["changed_set_id"]),
                ).fetchone()[0]
            )
            request_id = "closeout_" + sha256_json(
                [scope_id, changed_set["changed_set_id"], generation]
            )[:40]
            connection.execute(
                """
                INSERT INTO closeout_requests(
                    id,scope_id,session_id,changed_set_id,watermark,generation,
                    status,files_json,evidence_hash,created_at,expires_at
                ) VALUES(?,?,?,?,?,?,'live',?,?,?,?)
                """,
                (
                    request_id,
                    scope_id,
                    scope["session_id"],
                    changed_set["changed_set_id"],
                    changed_set["watermark"],
                    generation,
                    canonical_json(changed_set["files"]),
                    evidence_hash,
                    self._now(),
                    self._expires(CLOSEOUT_TTL_SECONDS),
                ),
            )
            return {
                "status": "needs_closeout",
                "reason_code": "event_closeout_required",
                "closeout_request_id": request_id,
                "changed_set_id": changed_set["changed_set_id"],
                "watermark": changed_set["watermark"],
                "changed_files": changed_set["files"],
                "evidence_hash": evidence_hash,
                "unowned_count": unowned_count,
            }

    def closeout_context(
        self,
        request_id: str,
        runtime_id: str,
        session_key: str,
    ) -> dict[str, Any] | None:
        with self.read_connection() as connection:
            row = connection.execute(
                """
                SELECT r.*,p.root,p.root_hash,s.runtime_id,s.session_key
                FROM closeout_requests r
                JOIN scopes sc ON sc.id=r.scope_id
                JOIN projects p ON p.id=sc.project_id
                JOIN sessions s ON s.id=r.session_id
                WHERE r.id=?
                """,
                (request_id,),
            ).fetchone()
            if (
                row is None
                or row["runtime_id"] != runtime_id
                or row["session_key"] != session_key
            ):
                return None
            return {**dict(row), "files": json.loads(row["files_json"])}

    def trusted_closeout_context(self, request_id: str) -> dict[str, Any] | None:
        """Return one local closeout context for a core-owned capability."""
        if not request_id.startswith("closeout_") or len(request_id) > 96:
            return None
        with self.read_connection() as connection:
            row = connection.execute(
                """
                SELECT r.*,p.root,p.root_hash,s.runtime_id,s.session_key
                FROM closeout_requests r
                JOIN scopes sc ON sc.id=r.scope_id
                JOIN projects p ON p.id=sc.project_id
                JOIN sessions s ON s.id=r.session_id
                WHERE r.id=?
                """,
                (request_id,),
            ).fetchone()
            if row is None:
                return None
            return {**dict(row), "files": json.loads(row["files_json"])}

    def complete_closeout(
        self,
        *,
        request_id: str,
        runtime_id: str,
        session_key: str,
        changed_set_id: str,
        watermark: int,
        receipt_hash: str,
        final_validator: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            row = connection.execute(
                """
                SELECT r.*,s.runtime_id,s.session_key,
                       s.acknowledged_watermark AS session_acknowledged_watermark
                FROM closeout_requests r
                JOIN sessions s ON s.id=r.session_id
                WHERE r.id=?
                """,
                (request_id,),
            ).fetchone()
            if (
                row is None
                or row["runtime_id"] != runtime_id
                or row["session_key"] != session_key
            ):
                return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
            if row["status"] == "completed":
                return {
                    "status": "duplicate",
                    "reason_code": "event_duplicate",
                    "acknowledged_watermark": row["session_acknowledged_watermark"],
                }
            current_rows = self._changed_rows(
                connection,
                int(row["session_id"]),
                int(row["session_acknowledged_watermark"]),
            )
            current_watermark = max(
                [int(row["session_acknowledged_watermark"])]
                + [item["watermark"] for item in current_rows]
            )
            if (
                row["status"] != "live"
                or parse_time(row["expires_at"]) <= self.clock()
                or row["changed_set_id"] != changed_set_id
                or int(row["watermark"]) != watermark
                or current_watermark != watermark
            ):
                return {"status": "stale", "reason_code": "state_watermark_stale"}
            if final_validator is not None and not final_validator():
                return {"status": "stale", "reason_code": "state_watermark_stale"}
            connection.execute(
                """
                UPDATE sessions SET acknowledged_watermark=?
                WHERE id=?
                """,
                (watermark, row["session_id"]),
            )
            connection.execute(
                """
                UPDATE closeout_requests
                SET status='completed',receipt_hash=?,acknowledged_watermark=?
                WHERE id=?
                """,
                (receipt_hash, watermark, request_id),
            )
            connection.execute(
                "DELETE FROM schema_meta WHERE key=?",
                (f"graph_review:{row['changed_set_id']}",),
            )
            connection.execute(
                "DELETE FROM schema_meta WHERE key=? OR key LIKE ?",
                (
                    f"document_requirements:{row['changed_set_id']}",
                    f"document_review:{row['changed_set_id']}:%",
                ),
            )
            return {
                "status": "acknowledged",
                "reason_code": "event_closeout_acknowledged",
                "acknowledged_watermark": watermark,
            }

    def end_scope(
        self,
        *,
        scope_id: str,
        runtime_id: str,
        session_key: str,
        terminal_outcome: str,
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            scope = self._scope_row(connection, scope_id, runtime_id, session_key)
            if scope["status"] in {"ended", "orphaned"}:
                return {
                    "status": "duplicate",
                    "reason_code": "event_duplicate",
                    "pending_changed_set_count": 0,
                    "unowned_count": 0,
                }
            session = connection.execute(
                "SELECT * FROM sessions WHERE id=?",
                (scope["session_id"],),
            ).fetchone()
            assert session is not None
            changed = self._changed_rows(
                connection,
                int(scope["session_id"]),
                int(session["acknowledged_watermark"]),
            )
            unowned_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM unowned_events
                    WHERE project_id=? AND status='unresolved'
                      AND concurrency_group_id=?
                    """,
                    (scope["project_id"], scope["concurrency_group_id"]),
                ).fetchone()[0]
                if scope["concurrency_group_id"]
                else 0
            )
            connection.execute(
                """
                UPDATE scopes SET status='ended',terminal_outcome=?,
                    last_activity_at=? WHERE id=?
                """,
                (terminal_outcome, self._now(), scope_id),
            )
            connection.execute(
                "DELETE FROM schema_meta WHERE key=?",
                (f"graph_bootstrap_scope:{scope_id}",),
            )
            if changed:
                status = "ended_pending"
            elif unowned_count:
                status = "ended_unowned"
            elif terminal_outcome in {"failed", "cancelled", "replaced"}:
                status = "ended_failed"
            else:
                status = "ended_clean"
            return {
                "status": status,
                "reason_code": "event_scope_ended",
                "pending_changed_set_count": len(changed),
                "unowned_count": unowned_count,
            }

    def unresolved_unowned(
        self,
        *,
        root: Path,
        event_ids: list[str] | None,
        limit: int,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        root_value = str(root.resolve(strict=True))
        with self.read_connection() as connection:
            project = connection.execute(
                "SELECT * FROM projects WHERE root=?",
                (root_value,),
            ).fetchone()
            if project is None:
                raise ContractError("contract_field_invalid", "unknown project")
            if event_ids:
                placeholders = ",".join("?" for _ in event_ids)
                rows = connection.execute(
                    f"""
                    SELECT * FROM unowned_events
                    WHERE project_id=? AND status='unresolved'
                      AND id IN ({placeholders})
                    ORDER BY id
                    """,
                    (project["id"], *event_ids),
                ).fetchall()
                if len(rows) != len(set(event_ids)):
                    raise ContractError("audit_evidence_stale", "event set changed")
            else:
                rows = connection.execute(
                    """
                    SELECT * FROM unowned_events
                    WHERE project_id=? AND status='unresolved'
                    ORDER BY id LIMIT ?
                    """,
                    (project["id"], limit),
                ).fetchall()
            return dict(project), [dict(row) for row in rows]

    def mint_audit_token(
        self,
        *,
        project_id: int,
        bundle_hash: str,
        bundle: Mapping[str, Any],
        evidence_hash: str,
        skill_version: str,
    ) -> tuple[str, str, str]:
        with self.transaction() as connection:
            live = connection.execute(
                """
                SELECT * FROM audit_tokens
                WHERE project_id=? AND bundle_hash=? AND status='live'
                """,
                (project_id, bundle_hash),
            ).fetchone()
            if live is not None and parse_time(live["expires_at"]) > self.clock():
                token = self._token(
                    "audit",
                    live["id"],
                    live["generation"],
                    bundle_hash,
                    skill_version,
                )
                return token, live["expires_at"], "duplicate"
            if live is not None:
                connection.execute(
                    "UPDATE audit_tokens SET status='expired' WHERE id=?",
                    (live["id"],),
                )
            generation = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(generation),0)+1 FROM audit_tokens
                    WHERE project_id=? AND bundle_hash=?
                    """,
                    (project_id, bundle_hash),
                ).fetchone()[0]
            )
            token_id = "audit_" + sha256_json(
                [project_id, bundle_hash, generation]
            )[:40]
            token = self._token(
                "audit",
                token_id,
                generation,
                bundle_hash,
                skill_version,
            )
            expires_at = self._expires(AUDIT_TTL_SECONDS)
            connection.execute(
                """
                INSERT INTO audit_tokens(
                    id,project_id,bundle_hash,bundle_json,evidence_hash,
                    skill_version,generation,token_hash,status,created_at,expires_at
                ) VALUES(?,?,?,?,?,?,?,?, 'live',?,?)
                """,
                (
                    token_id,
                    project_id,
                    bundle_hash,
                    canonical_json(bundle),
                    evidence_hash,
                    skill_version,
                    generation,
                    self._token_hash(token),
                    self._now(),
                    expires_at,
                ),
            )
            return token, expires_at, "prepared"

    def audit_context(self, token: str) -> dict[str, Any] | None:
        with self.read_connection() as connection:
            row = connection.execute(
                """
                SELECT a.*,p.root,p.root_hash
                FROM audit_tokens a JOIN projects p ON p.id=a.project_id
                WHERE a.token_hash=?
                """,
                (self._token_hash(token),),
            ).fetchone()
            if row is None:
                return None
            return {**dict(row), "bundle": json.loads(row["bundle_json"])}

    def complete_audit(
        self,
        *,
        token: str,
        audit_result: str,
        decision_class: str,
        receipt_hash: str,
        gate_hash: str,
        remediation: list[str],
        final_validator: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        with self.transaction() as connection:
            audit = connection.execute(
                "SELECT * FROM audit_tokens WHERE token_hash=?",
                (self._token_hash(token),),
            ).fetchone()
            if audit is None:
                return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
            if audit["status"] == "consumed":
                decision = connection.execute(
                    """
                    SELECT audit_result,decision_class,decision_json
                    FROM audit_decisions
                    WHERE audit_token_id=? ORDER BY created_at DESC LIMIT 1
                    """,
                    (audit["id"],),
                ).fetchone()
                if decision is not None:
                    if (
                        decision["audit_result"] != audit_result
                        or decision["decision_class"] != decision_class
                    ):
                        return {
                            "status": "invalid",
                            "reason_code": "audit_receipt_invalid",
                        }
                    value = json.loads(decision["decision_json"])
                    return {**value, "status": "duplicate", "reason_code": "event_duplicate"}
            if (
                audit["status"] != "live"
                or parse_time(audit["expires_at"]) <= self.clock()
            ):
                return {"status": "stale", "reason_code": "audit_evidence_stale"}
            bundle = json.loads(audit["bundle_json"])
            event_ids = bundle["event_ids"]
            placeholders = ",".join("?" for _ in event_ids)
            rows = connection.execute(
                f"""
                SELECT * FROM unowned_events
                WHERE project_id=? AND status='unresolved'
                  AND id IN ({placeholders})
                """,
                (audit["project_id"], *event_ids),
            ).fetchall()
            if len(rows) != len(event_ids):
                return {"status": "stale", "reason_code": "audit_evidence_stale"}
            if final_validator is not None and not final_validator():
                return {"status": "stale", "reason_code": "audit_evidence_stale"}
            if audit_result == "verified":
                status = "resolved"
                decision_status = "resolved"
            elif audit_result == "inconclusive":
                status = "inconclusive"
                decision_status = "inconclusive"
            else:
                status = "failed"
                decision_status = "failed"
            decision_id = "decision_" + sha256_json(
                [audit["id"], receipt_hash, audit_result, decision_class]
            )[:40]
            result = {
                "status": status,
                "reason_code": "audit_resolved"
                if status == "resolved"
                else "audit_evidence_stale",
                "resolved_event_count": len(event_ids) if status == "resolved" else 0,
            }
            supersedes = next(
                (
                    str(row["resolved_decision_id"])
                    for row in rows
                    if row["resolved_decision_id"]
                ),
                None,
            )
            connection.execute(
                """
                INSERT INTO audit_decisions(
                    id,project_id,audit_token_id,bundle_hash,evidence_hash,
                    audit_result,decision_class,status,decision_json,
                    receipt_hash,gate_hash,supersedes,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    decision_id,
                    audit["project_id"],
                    audit["id"],
                    audit["bundle_hash"],
                    audit["evidence_hash"],
                    audit_result,
                    decision_class,
                    decision_status,
                    canonical_json(result),
                    receipt_hash,
                    gate_hash,
                    supersedes,
                    self._now(),
                ),
            )
            if status == "resolved":
                connection.execute(
                    f"""
                    UPDATE unowned_events SET status='resolved',
                        resolved_decision_id=?
                    WHERE project_id=? AND id IN ({placeholders})
                    """,
                    (decision_id, audit["project_id"], *event_ids),
                )
            else:
                for item in remediation[:10]:
                    task_id = "remediation_" + sha256_json([decision_id, item])[:40]
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO remediation_tasks(
                            id,project_id,audit_decision_id,task_text,status,created_at
                        ) VALUES(?,?,?,?,'open',?)
                        """,
                        (
                            task_id,
                            audit["project_id"],
                            decision_id,
                            item,
                            self._now(),
                        ),
                    )
            connection.execute(
                """
                UPDATE audit_tokens SET status='consumed',consumed_at=?
                WHERE id=?
                """,
                (self._now(), audit["id"]),
            )
            remaining = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM unowned_events
                    WHERE project_id=? AND status='unresolved'
                    """,
                    (audit["project_id"],),
                ).fetchone()[0]
            )
            return {**result, "remaining_unowned": remaining}

    def record_probe(
        self,
        *,
        runtime_id: str,
        runtime_version: str,
        adapter_version: str,
        capability: str,
        level: str,
        result: str,
        correlation_hash: str,
        fixture: bool,
    ) -> str:
        return self._insert_probe(
            runtime_id=runtime_id,
            runtime_version=runtime_version,
            adapter_version=adapter_version,
            capability=capability,
            level=level,
            result=result,
            correlation_hash=correlation_hash,
            observed_at=self._now(),
            fixture=fixture,
        )

    def _insert_probe(
        self,
        *,
        runtime_id: str,
        runtime_version: str,
        adapter_version: str,
        capability: str,
        level: str,
        result: str,
        correlation_hash: str,
        observed_at: str,
        fixture: bool,
    ) -> str:
        probe_id = "probe_" + sha256_json(
            [
                runtime_id,
                runtime_version,
                adapter_version,
                capability,
                level,
                correlation_hash,
            ]
        )[:40]
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO probe_evidence(
                    id,runtime_id,runtime_version,adapter_version,capability,
                    level,result,correlation_hash,observed_at,fixture
                ) VALUES(?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    probe_id,
                    runtime_id,
                    runtime_version,
                    adapter_version,
                    capability,
                    level,
                    result,
                    correlation_hash,
                    observed_at,
                    int(fixture),
                ),
            )
        return probe_id

    def _probe_signature(
        self,
        *,
        runtime_id: str,
        runtime_version: str,
        adapter_version: str,
        capability: str,
        level: str,
        result: str,
        observed_at: str,
    ) -> str:
        message = canonical_json(
            [
                "native-probe-v1",
                runtime_id,
                runtime_version,
                adapter_version,
                capability,
                level,
                result,
                observed_at,
            ]
        ).encode("utf-8")
        return hmac.new(self._key, message, hashlib.sha256).hexdigest()

    def record_trusted_probe(
        self,
        *,
        runtime_id: str,
        runtime_version: str,
        adapter_version: str,
        capability: str,
        level: str,
        result: str,
    ) -> str:
        """Record host-bridge evidence signed by this state owner."""
        observed_at = self._now()
        correlation_hash = self._probe_signature(
            runtime_id=runtime_id,
            runtime_version=runtime_version,
            adapter_version=adapter_version,
            capability=capability,
            level=level,
            result=result,
            observed_at=observed_at,
        )
        return self._insert_probe(
            runtime_id=runtime_id,
            runtime_version=runtime_version,
            adapter_version=adapter_version,
            capability=capability,
            level=level,
            result=result,
            correlation_hash=correlation_hash,
            observed_at=observed_at,
            fixture=False,
        )

    def verify_trusted_probe(self, probe: Mapping[str, Any]) -> bool:
        """Verify that a native probe was minted by this state owner."""
        required = (
            "runtime_id",
            "runtime_version",
            "adapter_version",
            "capability",
            "level",
            "result",
            "observed_at",
            "correlation_hash",
        )
        if bool(probe.get("fixture")) or any(
            not isinstance(probe.get(field), str) or not probe[field]
            for field in required
        ):
            return False
        expected = self._probe_signature(
            runtime_id=str(probe["runtime_id"]),
            runtime_version=str(probe["runtime_version"]),
            adapter_version=str(probe["adapter_version"]),
            capability=str(probe["capability"]),
            level=str(probe["level"]),
            result=str(probe["result"]),
            observed_at=str(probe["observed_at"]),
        )
        return hmac.compare_digest(expected, str(probe["correlation_hash"]))

    def latest_probe(
        self,
        *,
        runtime_id: str,
        adapter_version: str,
        capability: str | None = None,
        level: str,
    ) -> dict[str, Any] | None:
        capability = capability or level
        with self.read_connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM probe_evidence
                WHERE runtime_id=? AND adapter_version=?
                  AND capability=? AND level=?
                ORDER BY observed_at DESC LIMIT 1
                """,
                (runtime_id, adapter_version, capability, level),
            ).fetchone()
            return None if row is None else dict(row)

    def resolved_audit_contexts(self) -> list[dict[str, Any]]:
        with self.read_connection() as connection:
            rows = connection.execute(
                """
                SELECT d.id AS decision_id,d.evidence_hash,d.gate_hash,
                       d.receipt_hash,d.status,
                       t.bundle_json,p.root
                FROM audit_decisions d
                JOIN audit_tokens t ON t.id=d.audit_token_id
                JOIN projects p ON p.id=d.project_id
                WHERE d.status='resolved'
                ORDER BY d.created_at
                """
            ).fetchall()
            return [
                {
                    **dict(row),
                    "bundle": json.loads(row["bundle_json"]),
                }
                for row in rows
            ]

    def reopen_stale_audit(
        self,
        *,
        decision_id: str,
        fingerprints: Mapping[str, str],
        evidence_hash: str,
        gate_hash: str,
    ) -> bool:
        with self.transaction() as connection:
            row = connection.execute(
                """
                SELECT d.*,t.bundle_json
                FROM audit_decisions d
                JOIN audit_tokens t ON t.id=d.audit_token_id
                WHERE d.id=?
                """,
                (decision_id,),
            ).fetchone()
            if row is None or row["status"] != "resolved":
                return False
            bundle = json.loads(row["bundle_json"])
            for event_id in bundle["event_ids"]:
                event = connection.execute(
                    """
                    SELECT * FROM unowned_events
                    WHERE id=? AND project_id=?
                    """,
                    (event_id, row["project_id"]),
                ).fetchone()
                if event is None:
                    continue
                fingerprint = fingerprints.get(event["path"])
                if fingerprint is None:
                    continue
                if fingerprint == event["after_fingerprint"]:
                    if (
                        event["status"] == "resolved"
                        and event["resolved_decision_id"]
                        and event["resolved_decision_id"] != decision_id
                    ):
                        continue
                    connection.execute(
                        """
                        UPDATE unowned_events
                        SET status='unresolved',resolved_decision_id=?
                        WHERE id=?
                        """,
                        (decision_id, event_id),
                    )
                    continue
                latest = connection.execute(
                    """
                    SELECT id,status,resolved_decision_id,after_fingerprint,
                           occurrence
                    FROM unowned_events
                    WHERE project_id=? AND concurrency_group_id=? AND path=?
                    ORDER BY occurrence DESC LIMIT 1
                    """,
                    (
                        event["project_id"],
                        event["concurrency_group_id"],
                        event["path"],
                    ),
                ).fetchone()
                if (
                    latest is not None
                    and latest["after_fingerprint"] == fingerprint
                    and latest["status"] == "resolved"
                    and latest["resolved_decision_id"]
                    and latest["resolved_decision_id"] != decision_id
                ):
                    continue
                if latest is not None and latest["after_fingerprint"] == fingerprint:
                    current_id = str(latest["id"])
                else:
                    occurrence = (
                        1 if latest is None else int(latest["occurrence"]) + 1
                    )
                    current_id = "unowned_" + sha256_json(
                        [
                            event["project_id"],
                            event["concurrency_group_id"],
                            event["path"],
                            occurrence,
                            fingerprint,
                        ]
                    )[:40]
                    connection.execute(
                        """
                        INSERT INTO unowned_events(
                            id,project_id,concurrency_group_id,path,
                            after_fingerprint,evidence_hash,status,
                            graph_sync_state,created_at,resolved_decision_id,
                            occurrence
                        ) VALUES(?,?,?,?,?,?,'unresolved','not_applicable',?,?,?)
                        """,
                        (
                            current_id,
                            event["project_id"],
                            event["concurrency_group_id"],
                            event["path"],
                            fingerprint,
                            sha256_json(
                                [event["path"], fingerprint, evidence_hash]
                            ),
                            self._now(),
                            decision_id,
                            occurrence,
                        ),
                    )
                connection.execute(
                    """
                    UPDATE unowned_events
                    SET status='unresolved',resolved_decision_id=?
                    WHERE id=?
                    """,
                    (decision_id, current_id),
                )
            connection.execute(
                "UPDATE audit_decisions SET status='stale' WHERE id=?",
                (decision_id,),
            )
            connection.execute(
                "UPDATE projects SET mutation_epoch=mutation_epoch+1 WHERE id=?",
                (row["project_id"],),
            )
            recovery_id = "recovery_" + sha256_json(
                [decision_id, evidence_hash, gate_hash, self._now()]
            )[:40]
            connection.execute(
                """
                INSERT INTO recovery_log(
                    id,category,subject_hash,reason_code,detail_json,created_at
                ) VALUES(?,?,?,?,?,?)
                """,
                (
                    recovery_id,
                    "audit_reopen",
                    sha256_text(decision_id),
                    "audit_evidence_stale",
                    canonical_json({"event_count": len(bundle["event_ids"])}),
                    self._now(),
                ),
            )
            return True

    def health_counts(self) -> dict[str, int]:
        tables = (
            "projects",
            "sessions",
            "scopes",
            "change_events",
            "unowned_events",
            "constraint_deliveries",
            "closeout_requests",
            "audit_tokens",
            "audit_decisions",
            "probe_evidence",
            "recovery_log",
            "operations",
        )
        with self.read_connection() as connection:
            return {
                table: int(
                    connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                )
                for table in tables
            }

    def import_emergency_record(
        self,
        *,
        record_hash: str,
        category: str,
        subject_hash: str,
        reason_code: str,
        detail: Mapping[str, Any],
    ) -> bool:
        record_id = "emergency_" + record_hash[:40]
        safe_category = (
            category
            if category in {"post_write_failure", "state_error"}
            else "state_error"
        )
        safe_reason = (
            reason_code
            if reason_code in {"state_internal_error", "state_lock_timeout"}
            else "state_internal_error"
        )
        safe_subject_hash = (
            subject_hash
            if len(subject_hash) == 64
            and all(character in "0123456789abcdef" for character in subject_hash)
            else sha256_text(subject_hash)
        )
        with self.transaction() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO recovery_log(
                    id,category,subject_hash,reason_code,detail_json,created_at
                ) VALUES(?,?,?,?,?,?)
                """,
                (
                    record_id,
                    safe_category,
                    safe_subject_hash,
                    safe_reason,
                    canonical_json(
                        {
                            key: value
                            for key, value in detail.items()
                            if isinstance(value, bool | int | float)
                            or value is None
                        }
                    ),
                    self._now(),
                ),
            )
            return cursor.rowcount == 1


def sync_dirty_queue(root: Path, relative_path: str) -> None:
    """Append one committed record to the graph queue under an advisory lock."""
    root = Path(os.path.abspath(root.expanduser()))
    target = safe_project_path(root, relative_path)
    root_resolved = root.resolve(strict=True)
    relative_path = target.relative_to(root_resolved).as_posix()
    context = root / ".context"
    if (
        has_unsafe_symlink_component(context)
        or context.is_symlink()
        or (context.exists() and not context.is_dir())
    ):
        raise ValueError("unsafe graph queue context")
    queue = context / ".dirty-graph-files"
    lock = context / ".dirty-graph-files.lock"
    if queue.is_symlink() or lock.is_symlink():
        raise ValueError("unsafe graph queue path")
    context_descriptor = open_directory_no_symlinks(
        context,
        create=True,
        mode=0o700,
        opener=os.open,
        mkdirer=os.mkdir,
    )
    try:
        descriptor = os.open(
            lock.name,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
            dir_fd=context_descriptor,
        )
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            queue_descriptor = os.open(
                queue.name,
                os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
                0o600,
                dir_fd=context_descriptor,
            )
            try:
                metadata = os.fstat(queue_descriptor)
                if not stat.S_ISREG(metadata.st_mode):
                    raise ValueError("unsafe graph queue file")
                data = (relative_path + "\n").encode("utf-8")
                if os.write(queue_descriptor, data) != len(data):
                    raise OSError("short graph queue append")
                os.fsync(queue_descriptor)
                os.fchmod(queue_descriptor, 0o600)
            finally:
                os.close(queue_descriptor)
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)
    finally:
        os.close(context_descriptor)
