"""Locked adapter around the deterministic dependency graph scanner."""

from __future__ import annotations

import fcntl
import json
import os
import stat
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from .paths import (
    GRAPH_IGNORED_DIRECTORIES,
    graph_code_file,
    open_directory_no_symlinks,
    safe_project_path,
    supported_code_file,
)
from .util import sha256_text

_MAX_SCANNER_OUTPUT = 1_048_576
_DEFAULT_TIMEOUT_SECONDS = 6


def _default_scanner_path() -> Path:
    configured = os.environ.get("FRACTAL_GRAPH_SCANNER")
    if configured and os.environ.get("FRACTAL_DEV_MODE") == "1":
        return Path(configured).expanduser()
    return Path(__file__).resolve().parents[1] / "graph_scanner/index.js"


def _relative(root: Path, value: str) -> str:
    target = safe_project_path(root, value)
    return target.relative_to(root).as_posix()


def _ignored_path(value: str) -> bool:
    parts = Path(value).parts
    return any(part in GRAPH_IGNORED_DIRECTORIES for part in parts[:-1])


class GraphReconciler:
    """Serialize graph writes and return a small, validated machine summary."""

    def __init__(
        self,
        scanner_path: Path | None = None,
        *,
        state_root: Path | None = None,
        node_binary: str = "node",
        timeout_seconds: int = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.scanner_path = scanner_path or _default_scanner_path()
        self.state_root = (
            state_root
            or Path(
                os.environ.get(
                    "FRACTAL_STATE_ROOT",
                    "~/.local/state/fractal-agent/v1",
                )
            ).expanduser()
        )
        self.node_binary = node_binary
        self.timeout_seconds = timeout_seconds

    def _context(self, root: Path) -> Path:
        context = self.state_root / "graphs" / sha256_text(str(root))
        descriptor = open_directory_no_symlinks(
            context,
            create=True,
            mode=0o700,
            opener=os.open,
            mkdirer=os.mkdir,
        )
        os.close(descriptor)
        return context

    @contextmanager
    def _lock(self, root: Path, *, shared: bool = False) -> Iterator[None]:
        context = self._context(root)
        descriptor = open_directory_no_symlinks(
            context,
            create=True,
            mode=0o700,
            opener=os.open,
            mkdirer=os.mkdir,
        )
        lock_descriptor = -1
        try:
            lock_descriptor = os.open(
                ".dependency-index.reconcile.lock",
                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                0o600,
                dir_fd=descriptor,
            )
            metadata = os.fstat(lock_descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError("unsafe dependency graph lock")
            fcntl.flock(
                lock_descriptor,
                fcntl.LOCK_SH if shared else fcntl.LOCK_EX,
            )
            yield
        finally:
            if lock_descriptor >= 0:
                try:
                    fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
                finally:
                    os.close(lock_descriptor)
            os.close(descriptor)

    def _scanner(self) -> Path:
        scanner = self.scanner_path.expanduser().resolve(strict=True)
        metadata = scanner.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("dependency graph scanner is not a regular file")
        return scanner

    def _run(self, root: Path, arguments: Sequence[str]) -> dict[str, Any]:
        root = root.resolve(strict=True)
        scanner = self._scanner()
        environment = dict(os.environ)
        environment.pop("NODE_OPTIONS", None)
        environment["NO_COLOR"] = "1"
        completed = subprocess.run(
            [self.node_binary, str(scanner), *arguments],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=self.timeout_seconds,
            check=False,
            env=environment,
        )
        if completed.returncode != 0:
            raise RuntimeError("dependency graph scanner failed")
        if len(completed.stdout) > _MAX_SCANNER_OUTPUT:
            raise RuntimeError("dependency graph scanner output is too large")
        try:
            value = json.loads(completed.stdout.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("dependency graph scanner output is invalid") from exc
        if not isinstance(value, dict):
            raise RuntimeError("dependency graph scanner output is invalid")
        return value

    @staticmethod
    def _validate_scan(root: Path, value: Mapping[str, Any]) -> dict[str, Any]:
        if (
            value.get("schema") != "dependency-scan-result"
            or value.get("schemaVersion") != 1
            or value.get("status") != "ok"
            or value.get("mode") not in {"full", "incremental", "skipped"}
        ):
            raise RuntimeError("dependency graph scan contract mismatch")
        changes = value.get("structuralChanges")
        if not isinstance(changes, list) or len(changes) > 10_000:
            raise RuntimeError("dependency graph scan changes are invalid")
        normalized_changes: list[dict[str, Any]] = []
        for item in changes:
            if not isinstance(item, Mapping):
                raise RuntimeError("dependency graph scan change is invalid")
            kind = item.get("type")
            if kind not in {
                "file_added",
                "file_deleted",
                "exports_changed",
                "dependencies_changed",
            }:
                raise RuntimeError("dependency graph scan change type is invalid")
            file = item.get("file")
            if not isinstance(file, str) or not file:
                raise RuntimeError("dependency graph scan path is invalid")
            relative = _relative(root, file)
            normalized = {"type": kind, "file": relative}
            for field in ("before", "after"):
                if field not in item:
                    continue
                values = item[field]
                if not isinstance(values, list) or not all(
                    isinstance(entry, str) for entry in values
                ):
                    raise RuntimeError("dependency graph scan delta is invalid")
                normalized[field] = sorted(
                    {
                        _relative(root, entry)
                        if kind == "dependencies_changed"
                        else entry
                        for entry in values
                    }
                )
            normalized_changes.append(normalized)
        dirty = value.get("dirtyFiles")
        if not isinstance(dirty, list) or not all(
            isinstance(item, str) for item in dirty
        ):
            raise RuntimeError("dependency graph dirty set is invalid")
        stats = value.get("stats")
        if not isinstance(stats, Mapping):
            raise RuntimeError("dependency graph stats are invalid")
        return {
            "status": "ok",
            "mode": value["mode"],
            "skipped": bool(value.get("skipped")),
            "initialized": bool(value.get("initialized")),
            "dirty_files": sorted({_relative(root, item) for item in dirty}),
            "structural_changes": normalized_changes,
            "top_level_modules_changed": bool(
                value.get("topLevelModulesChanged")
            ),
            "stats": dict(stats),
            "duration_ms": int(value.get("durationMs") or 0),
        }

    def scan(
        self,
        root: Path,
        *,
        force_full: bool = False,
        files: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        root = root.resolve(strict=True)
        arguments = [
            "scan",
            "--json",
            "--project",
            str(root),
            "--context",
            str(self._context(root)),
        ]
        if force_full:
            arguments.append("--full")
        if files:
            for value in sorted({_relative(root, item) for item in files}):
                arguments.extend(["--file", value])
        try:
            with self._lock(root):
                return self._validate_scan(root, self._run(root, arguments))
        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError):
            return {
                "status": "unavailable",
                "reason_code": "capability_fallback",
                "retryable": True,
            }

    def ensure_baseline(self, root: Path) -> dict[str, Any]:
        """Create the graph before edits when a host delivers SessionStart."""
        root = root.resolve(strict=True)
        index = self._context(root) / "dependency-index.json"
        if index.is_file() and not index.is_symlink():
            return {"status": "existing", "initialized": False}
        try:
            listed = subprocess.run(
                [
                    "git",
                    "-C",
                    str(root),
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            listed = None
        if listed is None or listed.returncode != 0 or not any(
            graph_code_file(Path(os.fsdecode(item)))
            for item in listed.stdout.split(b"\0")
            if item
        ):
            return {"status": "not_applicable", "initialized": False}
        return self.scan(root, force_full=True)

    def targeted_review(
        self,
        root: Path,
        changed_paths: Sequence[str],
        *,
        graph: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Conservatively review the first scope that established a baseline."""
        root = root.resolve(strict=True)
        sources = [
            relative
            for item in changed_paths
            if graph_code_file(Path(relative := _relative(root, item)))
        ]
        targets = sorted(
            {
                target
                for source in sources
                if (target := self._folder_target(root, source)) is not None
            }
        )
        return {
            "decision": "review",
            "reason": "graph_baseline_requires_targeted_review",
            "targets": targets,
            "graph": dict(graph),
        }

    def query(self, root: Path, file: str, *, depth: int = 1) -> dict[str, Any]:
        root = root.resolve(strict=True)
        relative = _relative(root, file)
        if not 1 <= depth <= 4:
            raise ValueError("graph query depth must be between 1 and 4")
        arguments = [
            "query",
            "--json",
            "--project",
            str(root),
            "--context",
            str(self._context(root)),
            "--file",
            relative,
            "--depth",
            str(depth),
        ]
        with self._lock(root, shared=True):
            value = self._run(root, arguments)
        if value.get("status") != "ok" or value.get("file") != relative:
            raise RuntimeError("dependency graph query contract mismatch")
        exports = value.get("exports")
        upstream = value.get("upstream")
        downstream = value.get("downstream")
        if not isinstance(exports, list) or not all(
            isinstance(item, str) for item in exports
        ):
            raise RuntimeError("dependency graph query exports are invalid")

        def normalize_edges(items: Any) -> list[dict[str, Any]]:
            if not isinstance(items, list) or len(items) > 10_000:
                raise RuntimeError("dependency graph query edges are invalid")
            result = []
            for item in items:
                if (
                    not isinstance(item, Mapping)
                    or not isinstance(item.get("file"), str)
                    or not isinstance(item.get("depth"), int)
                ):
                    raise RuntimeError("dependency graph query edge is invalid")
                result.append(
                    {
                        "file": _relative(root, str(item["file"])),
                        "depth": int(item["depth"]),
                    }
                )
            return result

        return {
            "status": "ok",
            "file": relative,
            "exports": sorted(set(exports)),
            "upstream": normalize_edges(upstream),
            "downstream": normalize_edges(downstream),
        }

    @staticmethod
    def _folder_target(root: Path, relative_file: str) -> str | None:
        directory = safe_project_path(root, relative_file).parent
        candidate = directory / ".folder.md"
        try:
            metadata = candidate.lstat()
        except FileNotFoundError:
            if directory.is_symlink() or not directory.is_dir():
                return None
            entries = list(directory.iterdir())
            code_count = sum(
                1
                for entry in entries
                if entry.is_file()
                and not entry.is_symlink()
                and supported_code_file(entry)
            )
            has_module_child = any(
                entry.is_dir()
                and not entry.is_symlink()
                and entry.name not in GRAPH_IGNORED_DIRECTORIES
                for entry in entries
            )
            if (
                directory.name
                not in {"src", "core", "api", "lib", "services", "components"}
                and code_count < 3
                and not has_module_child
            ):
                return None
            return candidate.relative_to(root).as_posix()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            return None
        return candidate.relative_to(root).as_posix()

    @classmethod
    def _nearest_folder_target(cls, root: Path, relative_file: str) -> str | None:
        direct = cls._folder_target(root, relative_file)
        if direct is not None:
            return direct
        directory = safe_project_path(root, relative_file).parent
        while directory != root and root in directory.parents:
            candidate = directory / ".folder.md"
            try:
                metadata = candidate.lstat()
            except FileNotFoundError:
                directory = directory.parent
                continue
            if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                return candidate.relative_to(root).as_posix()
            return None
        return None

    @classmethod
    def _targets_for_paths(
        cls,
        root: Path,
        paths: Sequence[str],
    ) -> list[str]:
        targets: set[str] = set()
        by_directory: dict[str, str | None] = {}
        for relative in paths:
            path = Path(relative)
            if not supported_code_file(path):
                continue
            directory = path.parent.as_posix()
            if directory not in by_directory:
                by_directory[directory] = cls._nearest_folder_target(
                    root,
                    relative,
                )
            target = by_directory[directory]
            if target is not None:
                targets.add(target)
        return sorted(targets)

    def classify(
        self,
        root: Path,
        changed_paths: Sequence[str],
    ) -> dict[str, Any]:
        """Classify only the current changed set; unrelated queued work stays out."""
        root = root.resolve(strict=True)
        normalized = sorted({_relative(root, item) for item in changed_paths})
        if not normalized:
            return {"decision": "no_drift", "reason": "no_changes", "targets": []}
        if all(_ignored_path(item) for item in normalized):
            return {
                "decision": "no_drift",
                "reason": "ignored_paths_only",
                "targets": [],
            }
        code_paths = [item for item in normalized if supported_code_file(Path(item))]
        if not code_paths:
            return {
                "decision": "no_drift",
                "reason": "non_code_only",
                "targets": [],
            }
        fallback_targets = self._targets_for_paths(root, code_paths)
        graph_paths = [item for item in code_paths if graph_code_file(Path(item))]
        graph = (
            self.scan(root, files=graph_paths)
            if graph_paths
            else {"status": "not_applicable"}
        )
        if len(graph_paths) != len(code_paths):
            if not fallback_targets:
                return {
                    "decision": "no_drift",
                    "reason": "no_managed_document",
                    "targets": [],
                    "graph": graph,
                }
            return {
                "decision": "review",
                "reason": "unsupported_or_mixed_changes",
                "targets": fallback_targets,
                "graph": graph,
            }
        if graph.get("status") != "ok":
            if not fallback_targets:
                return {
                    "decision": "no_drift",
                    "reason": "no_managed_document",
                    "targets": [],
                    "graph": graph,
                }
            return {
                "decision": "review",
                "reason": "graph_unavailable",
                "targets": fallback_targets,
                "graph": graph,
            }
        changed = set(graph_paths)
        relevant_changes = [
            item
            for item in graph["structural_changes"]
            if item["file"] in changed
        ]
        scoped_graph = {
            **graph,
            "dirty_files": sorted(changed.intersection(graph["dirty_files"])),
            "structural_changes": relevant_changes,
        }
        if not graph["initialized"] and not relevant_changes:
            if not fallback_targets:
                return {
                    "decision": "no_drift",
                    "reason": "no_managed_document",
                    "targets": [],
                    "graph": scoped_graph,
                }
            return {
                "decision": "review",
                "reason": "implementation_change",
                "targets": fallback_targets,
                "graph": scoped_graph,
            }
        target_sources = set(graph_paths if graph["initialized"] else [])
        for item in relevant_changes:
            target_sources.add(item["file"])
            if item["type"] == "dependencies_changed":
                target_sources.update(item.get("before", []))
                target_sources.update(item.get("after", []))
        targets = sorted(
            {
                target
                for source in target_sources
                if (target := self._folder_target(root, source)) is not None
            }
        )
        if not targets:
            targets = fallback_targets
        if graph.get("top_level_modules_changed"):
            readme = root / "README.md"
            if readme.is_file() and not readme.is_symlink():
                targets.append("README.md")
        targets = sorted(set(targets))
        if not targets:
            return {
                "decision": "no_drift",
                "reason": "no_managed_document",
                "targets": [],
                "graph": scoped_graph,
            }
        return {
            "decision": "review",
            "reason": (
                "graph_baseline_requires_targeted_review"
                if graph["initialized"]
                else "structural_change"
            ),
            "targets": targets,
            "graph": scoped_graph,
        }
