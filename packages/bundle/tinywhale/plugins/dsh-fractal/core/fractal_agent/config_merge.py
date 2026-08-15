"""Owner-scoped JSON configuration merge with cooperative concurrency."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import stat
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .util import has_unsafe_symlink_component


class ConfigMergeError(RuntimeError):
    pass


TextTransformer = Callable[[str], str]


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ConfigMergeError("configuration contains duplicate keys")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ConfigMergeError(f"configuration contains invalid number: {value}")


def _load_document(original: str) -> dict[str, Any]:
    try:
        document = json.loads(
            original or "{}",
            object_pairs_hook=_strict_object,
            parse_constant=_reject_constant,
        )
    except json.JSONDecodeError as exc:
        raise ConfigMergeError("configuration is invalid JSON") from exc
    if not isinstance(document, dict):
        raise ConfigMergeError("configuration root must be an object")
    return document


def _owned_chain(value: Any, path: Sequence[str], owned_node: Mapping[str, Any]) -> bool:
    current = value
    for part in path:
        if not isinstance(current, dict) or list(current) != [part]:
            return False
        current = current[part]
    return current == dict(owned_node)


def _same_value_and_mapping_order(before: Any, after: Any) -> bool:
    if isinstance(before, Mapping) or isinstance(after, Mapping):
        if not isinstance(before, Mapping) or not isinstance(after, Mapping):
            return False
        if list(before) != list(after):
            return False
        return all(
            _same_value_and_mapping_order(before[key], after[key])
            for key in before
        )
    if isinstance(before, list) or isinstance(after, list):
        if not isinstance(before, list) or not isinstance(after, list):
            return False
        return len(before) == len(after) and all(
            _same_value_and_mapping_order(left, right)
            for left, right in zip(before, after)
        )
    return type(before) is type(after) and before == after


def _verify_non_owned_preserved(
    original: Mapping[str, Any],
    updated: Mapping[str, Any],
    path: Sequence[str],
    owned_node: Mapping[str, Any],
) -> None:
    head = path[0]
    original_keys = list(original)
    if [key for key in updated if key in original] != original_keys:
        raise ConfigMergeError("non-owned mapping order changed")
    new_keys = [key for key in updated if key not in original]
    if new_keys and (head in original or new_keys != [head]):
        raise ConfigMergeError("non-owned mapping structure changed")
    for key in original_keys:
        if key != head:
            if not _same_value_and_mapping_order(original[key], updated.get(key)):
                raise ConfigMergeError("non-owned configuration changed")
            continue
        if len(path) == 1:
            continue
        before_child = original[key]
        after_child = updated.get(key)
        if not isinstance(before_child, Mapping) or not isinstance(
            after_child,
            Mapping,
        ):
            raise ConfigMergeError("owned path crosses a non-object node")
        _verify_non_owned_preserved(
            before_child,
            after_child,
            path[1:],
            owned_node,
        )
    if head not in original and not _owned_chain(updated[head], path[1:], owned_node):
        raise ConfigMergeError("non-owned mapping structure changed")


def _prepare_owned_json(
    original: str,
    *,
    path: Sequence[str],
    owned_node: Mapping[str, Any],
    owner_id: str,
) -> tuple[dict[str, Any], bytes]:
    if not path or any(not isinstance(part, str) or not part for part in path):
        raise ConfigMergeError("invalid owned path")
    if owned_node.get("_fractal_owner") != owner_id:
        raise ConfigMergeError("owned node marker mismatch")
    document = _load_document(original)
    updated = deepcopy(document)
    parent: dict[str, Any] = updated
    for part in path[:-1]:
        if part not in parent:
            child = {}
            parent[part] = child
        else:
            child = parent[part]
        if not isinstance(child, dict):
            raise ConfigMergeError("owned path crosses a non-object node")
        parent = child
    leaf = path[-1]
    if leaf in parent:
        existing = parent[leaf]
        if not isinstance(existing, dict):
            raise ConfigMergeError("owned path conflicts with foreign value")
        existing_owner = existing.get("_fractal_owner")
        if existing_owner != owner_id:
            raise ConfigMergeError("foreign owned node refused")
    parent[leaf] = deepcopy(dict(owned_node))
    _verify_non_owned_preserved(document, updated, path, owned_node)
    content = json.dumps(
        updated,
        ensure_ascii=False,
        indent=2,
    ) + "\n"
    original_bytes = original.encode("utf-8")
    content_bytes = content.encode("utf-8")
    return {
        "changed": content != original,
        "before_digest": _digest(original_bytes),
        "after_digest": _digest(content_bytes),
        "before_bytes": len(original_bytes),
        "after_bytes": len(content_bytes),
    }, content_bytes


def merge_owned_json(
    original: str,
    *,
    path: Sequence[str],
    owned_node: Mapping[str, Any],
    owner_id: str,
) -> dict[str, Any]:
    result, _ = _prepare_owned_json(
        original,
        path=path,
        owned_node=owned_node,
        owner_id=owner_id,
    )
    return result


def _read_target(target: Path) -> tuple[bytes, int]:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(target, flags)
    except FileNotFoundError:
        return b"", 0o600
    except OSError as exc:
        raise ConfigMergeError("configuration cannot be opened safely") from exc
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigMergeError("configuration is not a regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks), stat.S_IMODE(metadata.st_mode)
    finally:
        os.close(descriptor)


def _validate_target(target: Path) -> None:
    if has_unsafe_symlink_component(target) or target.is_symlink():
        raise ConfigMergeError("configuration symlink component refused")
    if target.exists() and not target.is_file():
        raise ConfigMergeError("configuration is not a regular file")


def _lock_configuration(target: Path) -> int:
    lock = target.with_name(f".{target.name}.fractal.lock")
    if lock.is_symlink():
        raise ConfigMergeError("configuration lock symlink refused")
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock, flags, 0o600)
    except OSError as exc:
        raise ConfigMergeError("configuration lock cannot be opened safely") from exc
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ConfigMergeError("configuration lock is not regular")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError) as exc:
            raise ConfigMergeError("cooperative configuration lock is busy") from exc
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _atomic_replace(
    target: Path,
    data: bytes,
    *,
    mode: int,
    expected_digest: str,
) -> None:
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{target.name}.",
        dir=target.parent,
    )
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        _validate_target(target)
        current, _ = _read_target(target)
        if _digest(current) != expected_digest:
            raise ConfigMergeError("concurrent configuration change")
        # This is the final cooperative digest check, not a filesystem CAS.
        # A writer that ignores the advisory lock can still race this rename.
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def write_owned_json(
    target: Path,
    *,
    path: Sequence[str],
    owned_node: Mapping[str, Any],
    owner_id: str,
    expected_digest: str | None = None,
    dry_run: bool = False,
    quiescence_verifier: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    target = target.expanduser()
    _validate_target(target)

    def calculate() -> tuple[dict[str, Any], bytes, int, str]:
        raw, mode = _read_target(target)
        actual_digest = _digest(raw)
        if expected_digest is not None and expected_digest != actual_digest:
            raise ConfigMergeError("concurrent configuration change")
        try:
            original = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ConfigMergeError("configuration is not UTF-8") from exc
        result, content = _prepare_owned_json(
            original,
            path=path,
            owned_node=owned_node,
            owner_id=owner_id,
        )
        return result, content, mode, actual_digest

    if dry_run:
        result, _, _, _ = calculate()
        return result

    if quiescence_verifier is None:
        raise ConfigMergeError("trusted quiescence verifier is required")
    try:
        quiescent = quiescence_verifier() is True
    except Exception as exc:
        raise ConfigMergeError("trusted quiescence verification failed") from exc
    if not quiescent:
        raise ConfigMergeError("trusted quiescence verification failed")

    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _validate_target(target)
    descriptor = _lock_configuration(target)
    try:
        result, content, mode, locked_digest = calculate()
        if result["changed"]:
            _atomic_replace(
                target,
                content,
                mode=mode,
                expected_digest=locked_digest,
            )
        return result
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def write_transformed_text(
    target: Path,
    *,
    transform: TextTransformer,
    expected_digest: str | None = None,
    dry_run: bool = False,
    quiescence_verifier: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Safely apply a closed text transformation without returning content."""
    target = target.expanduser()
    _validate_target(target)

    def calculate() -> tuple[dict[str, Any], bytes, int, str]:
        raw, mode = _read_target(target)
        actual_digest = _digest(raw)
        if expected_digest is not None and expected_digest != actual_digest:
            raise ConfigMergeError("concurrent configuration change")
        try:
            original = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ConfigMergeError("configuration is not UTF-8") from exc
        updated = transform(original)
        if not isinstance(updated, str):
            raise ConfigMergeError("configuration transform returned non-text")
        content = updated.encode("utf-8")
        return (
            {
                "changed": content != raw,
                "before_digest": actual_digest,
                "after_digest": _digest(content),
                "before_bytes": len(raw),
                "after_bytes": len(content),
            },
            content,
            mode,
            actual_digest,
        )

    if dry_run:
        result, _, _, _ = calculate()
        return result
    if quiescence_verifier is None:
        raise ConfigMergeError("trusted quiescence verifier is required")
    try:
        quiescent = quiescence_verifier() is True
    except Exception as exc:
        raise ConfigMergeError("trusted quiescence verification failed") from exc
    if not quiescent:
        raise ConfigMergeError("trusted quiescence verification failed")

    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _validate_target(target)
    descriptor = _lock_configuration(target)
    try:
        result, content, mode, locked_digest = calculate()
        if result["changed"]:
            _atomic_replace(
                target,
                content,
                mode=mode,
                expected_digest=locked_digest,
            )
        return result
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)
