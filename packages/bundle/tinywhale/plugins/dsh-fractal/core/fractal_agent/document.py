"""Capability-scoped, compare-and-swap writes for semantic folder documents."""

from __future__ import annotations

import fcntl
import ctypes
import errno
import hashlib
import os
import secrets
import stat
import sys
import subprocess
from pathlib import Path
from typing import Any, Iterable

from .paths import open_directory_no_symlinks, safe_project_path
from .state import StateStore
from .util import sha256_text

MAX_DOCUMENT_BYTES = 131_072
MISSING_DOCUMENT = "missing"
_RENAME_EXCHANGE = 0x00000002


def _rename_exchange(directory_descriptor: int, left: str, right: str) -> None:
    """Atomically exchange two bound directory entries or fail closed."""
    library = ctypes.CDLL(None, use_errno=True)
    function = None
    if sys.platform == "darwin":
        function = getattr(library, "renameatx_np", None)
    elif sys.platform.startswith("linux"):
        function = getattr(library, "renameat2", None)
    if function is None:
        raise OSError(errno.ENOTSUP, "atomic exchange is unavailable")
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    function.restype = ctypes.c_int
    result = function(
        directory_descriptor,
        os.fsencode(left),
        directory_descriptor,
        os.fsencode(right),
        _RENAME_EXCHANGE,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _content_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _allowed_document(root: Path, target: Path) -> bool:
    return target.name == ".folder.md" or target == root / "README.md"


def _directory_identity(descriptor: int) -> tuple[int, int]:
    metadata = os.fstat(descriptor)
    return metadata.st_dev, metadata.st_ino


def _path_directory_identity(path: Path) -> tuple[int, int] | None:
    try:
        metadata = path.stat(follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        return None
    return metadata.st_dev, metadata.st_ino


def _read_bound_document(
    directory_descriptor: int,
    name: str,
) -> tuple[bytes, int] | None:
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=directory_descriptor,
        )
    except FileNotFoundError:
        return None
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError("unsafe semantic document")
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65_536, MAX_DOCUMENT_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_DOCUMENT_BYTES:
                raise ValueError("semantic document is too large")
        return b"".join(chunks), stat.S_IMODE(metadata.st_mode)
    finally:
        os.close(descriptor)


def _write_all(descriptor: int, content: bytes) -> None:
    written = 0
    while written < len(content):
        count = os.write(descriptor, content[written:])
        if count <= 0:
            raise OSError("short semantic document write")
        written += count


def _bound_hash(directory_descriptor: int, name: str) -> str | None:
    bound = _read_bound_document(directory_descriptor, name)
    if bound is None:
        return None
    return hashlib.sha256(bound[0]).hexdigest()


def _rollback_exchange_if_unchanged(
    directory_descriptor: int,
    *,
    temporary: str,
    name: str,
    published_sha256: str,
    original_sha256: str,
) -> bool:
    """Restore the old entry only while our published bytes still own target."""
    if (
        _bound_hash(directory_descriptor, name) != published_sha256
        or _bound_hash(directory_descriptor, temporary) != original_sha256
    ):
        return False
    _rename_exchange(directory_descriptor, temporary, name)
    os.fsync(directory_descriptor)
    return True


def _restore_bound_document(
    directory_descriptor: int,
    *,
    name: str,
    original: bytes | None,
    mode: int,
) -> None:
    if original is None:
        try:
            os.unlink(name, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass
        os.fsync(directory_descriptor)
        return
    temporary = f".{name}.{secrets.token_hex(12)}.restore"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
        dir_fd=directory_descriptor,
    )
    try:
        _write_all(descriptor, original)
        os.fsync(descriptor)
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)
    try:
        os.replace(
            temporary,
            name,
            src_dir_fd=directory_descriptor,
            dst_dir_fd=directory_descriptor,
        )
        os.fsync(directory_descriptor)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass


def _tracked_and_clean(root: Path, relative: str) -> bool:
    try:
        tracked = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--error-unmatch", "--", relative],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if tracked.returncode != 0:
        return False
    try:
        status = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--",
                relative,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return status.returncode == 0 and not status.stdout


def document_candidate(root: Path, relative: str) -> dict[str, str] | None:
    root = root.resolve(strict=True)
    target = safe_project_path(root, relative)
    relative = target.relative_to(root).as_posix()
    if not _allowed_document(root, target) or not target.parent.is_dir():
        return None
    try:
        metadata = target.lstat()
    except FileNotFoundError:
        if target.name != ".folder.md" or target.is_symlink():
            return None
        return {"file_path": relative, "expected_sha256": MISSING_DOCUMENT}
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_size > MAX_DOCUMENT_BYTES
        or not _tracked_and_clean(root, relative)
    ):
        return None
    return {"file_path": relative, "expected_sha256": _content_sha256(target)}


def mint_document_candidates(
    store: StateStore,
    *,
    root: Path,
    closeout_request_id: str,
    targets: Iterable[str],
) -> list[dict[str, str]]:
    result = []
    for relative in sorted(set(targets)):
        candidate = document_candidate(root, relative)
        if candidate is None:
            continue
        token = store.mint_document_capability(
            closeout_request_id=closeout_request_id,
            root=root,
            path=candidate["file_path"],
            expected_sha256=candidate["expected_sha256"],
        )
        result.append({**candidate, "candidate_token": token})
    return result


def apply_semantic_document(
    store: StateStore,
    *,
    candidate_token: str,
    content: str,
) -> dict[str, Any]:
    capability = store.verify_document_capability(candidate_token)
    if capability is None:
        return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
    context = store.trusted_closeout_context(capability["closeout_request_id"])
    if context is None or context["status"] != "live":
        return {"status": "stale", "reason_code": "state_watermark_stale"}
    root = Path(context["root"]).resolve(strict=True)
    if capability["root_hash"] != sha256_text(str(root)):
        return {"status": "stale", "reason_code": "state_watermark_stale"}
    if not isinstance(content, str) or "\x00" in content:
        return {"status": "invalid", "reason_code": "contract_field_invalid"}
    encoded = content.encode("utf-8", errors="strict")
    if not encoded or len(encoded) > MAX_DOCUMENT_BYTES:
        return {"status": "invalid", "reason_code": "contract_field_invalid"}
    relative = str(capability["path"])
    target = safe_project_path(root, relative)
    if not _allowed_document(root, target):
        return {"status": "invalid", "reason_code": "path_outside_root"}
    expected_directory_identity = _path_directory_identity(target.parent)
    if expected_directory_identity is None:
        return {"status": "stale", "reason_code": "state_watermark_stale"}
    directory_descriptor = open_directory_no_symlinks(target.parent)
    state_descriptor = open_directory_no_symlinks(store.state_root)
    lock_descriptor = -1
    temporary = f".{target.name}.{secrets.token_hex(12)}.tmp"
    temporary_created = False
    exchanged = False
    try:
        lock_descriptor = os.open(
            "document-write.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
            dir_fd=state_descriptor,
        )
        if not stat.S_ISREG(os.fstat(lock_descriptor).st_mode):
            raise ValueError("unsafe document lock")
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
        if (
            _directory_identity(directory_descriptor)
            != expected_directory_identity
            or _path_directory_identity(target.parent)
            != expected_directory_identity
        ):
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        bound = _read_bound_document(directory_descriptor, target.name)
        if bound is None:
            current_hash = MISSING_DOCUMENT
            original = None
            mode = 0o644
        else:
            original, mode = bound
            current_hash = hashlib.sha256(original).hexdigest()
        if current_hash != capability["expected_sha256"]:
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        if current_hash != MISSING_DOCUMENT:
            if not _tracked_and_clean(root, relative):
                return {"status": "stale", "reason_code": "state_watermark_stale"}
            if current_hash == hashlib.sha256(encoded).hexdigest():
                recorded = store.record_document_review(
                    closeout_request_id=capability["closeout_request_id"],
                    file_path=relative,
                    expected_sha256=current_hash,
                    after_sha256=current_hash,
                    outcome="no_change",
                )
                if not recorded:
                    return {"status": "error", "reason_code": "state_internal_error"}
                return {
                    "status": "no_change",
                    "reason_code": "rule_none",
                    "file_path": relative,
                    "before_sha256": current_hash,
                    "after_sha256": current_hash,
                }
        temporary_descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
            dir_fd=directory_descriptor,
        )
        temporary_created = True
        try:
            _write_all(temporary_descriptor, encoded)
            os.fsync(temporary_descriptor)
            os.fchmod(temporary_descriptor, mode)
        finally:
            os.close(temporary_descriptor)
        if (
            _path_directory_identity(target.parent)
            != expected_directory_identity
        ):
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        rebound = _read_bound_document(directory_descriptor, target.name)
        rebound_hash = (
            MISSING_DOCUMENT
            if rebound is None
            else hashlib.sha256(rebound[0]).hexdigest()
        )
        if rebound_hash != current_hash:
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        if current_hash == MISSING_DOCUMENT:
            try:
                os.link(
                    temporary,
                    target.name,
                    src_dir_fd=directory_descriptor,
                    dst_dir_fd=directory_descriptor,
                    follow_symlinks=False,
                )
            except FileExistsError:
                return {"status": "stale", "reason_code": "state_watermark_stale"}
            os.unlink(temporary, dir_fd=directory_descriptor)
            temporary_created = False
        else:
            _rename_exchange(directory_descriptor, temporary, target.name)
            exchanged = True
            exchanged_original = _read_bound_document(
                directory_descriptor,
                temporary,
            )
            if (
                exchanged_original is None
                or hashlib.sha256(exchanged_original[0]).hexdigest()
                != current_hash
            ):
                if not _rollback_exchange_if_unchanged(
                    directory_descriptor,
                    temporary=temporary,
                    name=target.name,
                    published_sha256=hashlib.sha256(encoded).hexdigest(),
                    original_sha256=(
                        hashlib.sha256(exchanged_original[0]).hexdigest()
                        if exchanged_original is not None
                        else MISSING_DOCUMENT
                    ),
                ):
                    raise OSError("semantic document exchange could not be restored")
                exchanged = False
                return {"status": "stale", "reason_code": "state_watermark_stale"}
        os.fsync(directory_descriptor)
        if (
            _path_directory_identity(target.parent)
            != expected_directory_identity
        ):
            if exchanged:
                if not _rollback_exchange_if_unchanged(
                    directory_descriptor,
                    temporary=temporary,
                    name=target.name,
                    published_sha256=hashlib.sha256(encoded).hexdigest(),
                    original_sha256=current_hash,
                ):
                    raise OSError("semantic document changed during rollback")
                exchanged = False
            elif _bound_hash(directory_descriptor, target.name) == hashlib.sha256(
                encoded
            ).hexdigest():
                os.unlink(target.name, dir_fd=directory_descriptor)
                os.fsync(directory_descriptor)
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        after_bound = _read_bound_document(directory_descriptor, target.name)
        if after_bound is None:
            raise OSError("semantic document disappeared")
        after = hashlib.sha256(after_bound[0]).hexdigest()
        if after != hashlib.sha256(encoded).hexdigest():
            raise OSError("semantic document verification failed")
        if (
            _path_directory_identity(target.parent)
            != expected_directory_identity
        ):
            if exchanged:
                if not _rollback_exchange_if_unchanged(
                    directory_descriptor,
                    temporary=temporary,
                    name=target.name,
                    published_sha256=after,
                    original_sha256=current_hash,
                ):
                    raise OSError("semantic document changed during rollback")
                exchanged = False
            elif _bound_hash(directory_descriptor, target.name) == after:
                os.unlink(target.name, dir_fd=directory_descriptor)
                os.fsync(directory_descriptor)
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        recorded = store.record_document_review(
            closeout_request_id=capability["closeout_request_id"],
            file_path=relative,
            expected_sha256=current_hash,
            after_sha256=after,
            outcome="updated",
        )
        if not recorded:
            if exchanged:
                if not _rollback_exchange_if_unchanged(
                    directory_descriptor,
                    temporary=temporary,
                    name=target.name,
                    published_sha256=after,
                    original_sha256=current_hash,
                ):
                    raise OSError("semantic document changed during rollback")
                exchanged = False
            elif _bound_hash(directory_descriptor, target.name) == after:
                os.unlink(target.name, dir_fd=directory_descriptor)
                os.fsync(directory_descriptor)
            return {"status": "error", "reason_code": "state_internal_error"}
        if exchanged:
            os.unlink(temporary, dir_fd=directory_descriptor)
            temporary_created = False
            exchanged = False
            os.fsync(directory_descriptor)
        return {
            "status": "updated",
            "reason_code": "event_document_updated",
            "file_path": relative,
            "before_sha256": current_hash,
            "after_sha256": after,
        }
    finally:
        if temporary_created:
            try:
                os.unlink(temporary, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
        if lock_descriptor >= 0:
            try:
                fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
            finally:
                os.close(lock_descriptor)
        os.close(state_descriptor)
        os.close(directory_descriptor)


def apply_semantic_document_for_closeout(
    store: StateStore,
    *,
    closeout_request_id: str,
    file_path: str,
    content: str,
) -> dict[str, Any]:
    """Resolve one persisted candidate without exposing its capability token."""
    context = store.trusted_closeout_context(closeout_request_id)
    if context is None:
        return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
    if context["status"] != "live":
        return {"status": "stale", "reason_code": "state_watermark_stale"}
    state = store.document_review_state(str(context["changed_set_id"]))
    candidates = state.get("candidates") if isinstance(state, dict) else None
    if not isinstance(candidates, list):
        return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
    matches = [
        item
        for item in candidates
        if isinstance(item, dict) and item.get("file_path") == file_path
    ]
    if len(matches) != 1 or not isinstance(matches[0].get("expected_sha256"), str):
        return {"status": "invalid", "reason_code": "path_outside_root"}
    root = Path(context["root"]).resolve(strict=True)
    token = store.mint_document_capability(
        closeout_request_id=closeout_request_id,
        root=root,
        path=file_path,
        expected_sha256=str(matches[0]["expected_sha256"]),
    )
    return apply_semantic_document(
        store,
        candidate_token=token,
        content=content,
    )


def document_review_evidence(
    store: StateStore,
    context: dict[str, Any],
) -> list[dict[str, str]] | None:
    state = store.document_review_state(str(context["changed_set_id"]))
    if state is None:
        return (
            []
            if store.graph_review(str(context["changed_set_id"])) is None
            else None
        )
    targets = state.get("targets")
    candidates = state.get("candidates")
    reviewed = state.get("reviewed")
    if (
        not isinstance(targets, list)
        or not targets
        or not isinstance(candidates, list)
        or not isinstance(reviewed, list)
    ):
        return None
    by_path = {
        item.get("file_path"): item
        for item in reviewed
        if isinstance(item, dict) and isinstance(item.get("file_path"), str)
    }
    candidate_paths = {
        item.get("file_path")
        for item in candidates
        if isinstance(item, dict)
    }
    if set(targets) != candidate_paths:
        return None
    root = Path(context["root"]).resolve(strict=True)
    evidence: list[dict[str, str]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            return None
        relative = candidate.get("file_path")
        expected = candidate.get("expected_sha256")
        outcome = by_path.get(relative)
        if (
            not isinstance(relative, str)
            or not isinstance(expected, str)
            or not isinstance(outcome, dict)
            or outcome.get("expected_sha256") != expected
            or outcome.get("outcome") not in {"no_change", "updated"}
        ):
            return None
        target = safe_project_path(root, relative)
        if not _allowed_document(root, target):
            return None
        try:
            metadata = target.lstat()
        except FileNotFoundError:
            return False
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_size > MAX_DOCUMENT_BYTES
        ):
            return None
        after = _content_sha256(target)
        if after != outcome.get("after_sha256"):
            return None
        if outcome["outcome"] == "no_change" and after != expected:
            return None
        if outcome["outcome"] == "updated" and after == expected:
            return None
        evidence.append(
            {
                "file_path": relative,
                "before_sha256": expected,
                "after_sha256": after,
                "outcome": str(outcome["outcome"]),
            }
        )
    return sorted(evidence, key=lambda item: item["file_path"])


def document_reviews_satisfied(
    store: StateStore,
    context: dict[str, Any],
) -> bool:
    evidence = document_review_evidence(store, context)
    return evidence is not None
