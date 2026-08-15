"""Dynamic entrypoint for runtime event normalization."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..registry import ManifestRegistry


def normalize_runtime_event(
    runtime_id: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    root = Path(__file__).resolve().parents[2]
    registry = ManifestRegistry(
        runtime_manifest_dir=root / "manifests",
        artifact_root=root,
    )
    try:
        adapter = registry.adapter(runtime_id)
    except KeyError as exc:
        raise ValueError(f"unsupported runtime: {runtime_id}") from exc
    return adapter(payload)
