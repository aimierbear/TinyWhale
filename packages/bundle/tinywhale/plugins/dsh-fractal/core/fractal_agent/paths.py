"""Project-root, confinement, rule and fingerprint primitives."""

from __future__ import annotations

import fnmatch
import hashlib
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from .contract import ContractError

LANGUAGE_ROOT_MARKERS = (
    "package.json",
    "pyproject.toml",
    "setup.py",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
)

SUPPORTED_CODE_EXTENSIONS = frozenset(
    {
        ".c",
        ".cc",
        ".cpp",
        ".cs",
        ".css",
        ".go",
        ".h",
        ".hpp",
        ".html",
        ".java",
        ".js",
        ".jsx",
        ".kt",
        ".kts",
        ".lua",
        ".m",
        ".mm",
        ".mjs",
        ".php",
        ".py",
        ".rb",
        ".rs",
        ".scss",
        ".sh",
        ".sql",
        ".swift",
        ".ts",
        ".tsx",
        ".vue",
    }
)
GRAPH_EXTENSIONS = frozenset({".js", ".jsx", ".mjs", ".ts", ".tsx", ".vue"})
_NUMBERED_SECTION = re.compile(
    r"^\s*\d+[.)]\s+\*\*(?P<title>[^*]+)\*\*\s*[:：]?\s*(?P<tail>.*)$"
)
IGNORED_DIRECTORIES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".idea",
        ".vscode",
        "__pycache__",
        "backup",
        "backups",
        "build",
        "cache",
        "coverage",
        "dist",
        "memories",
        "memories_extensions",
        "node_modules",
        "plans",
        "plugins",
        "target",
        "vendor",
    }
)
GRAPH_IGNORED_DIRECTORIES = IGNORED_DIRECTORIES | frozenset(
    {
        ".next",
        ".nuxt",
        ".pnpm",
        ".turbo",
        ".vercel",
        "__tests__",
        "assets",
        "out",
        "public",
        "spec",
        "static",
        "test",
        "tests",
    }
)


class PathBoundaryError(ValueError):
    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code


def open_directory_no_symlinks(
    path: Path,
    *,
    create: bool = False,
    mode: int = 0o700,
    opener: Callable[..., int] = os.open,
    mkdirer: Callable[..., None] = os.mkdir,
) -> int:
    """Bind every absolute directory component without following symlinks."""
    if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("secure directory open is unavailable")
    absolute = Path(os.path.abspath(path.expanduser()))
    parts = absolute.parts
    if not absolute.is_absolute() or not parts:
        raise ValueError("secure directory path must be absolute")
    # macOS exposes these stable system aliases at the filesystem root.
    if len(parts) > 1 and parts[1] in {"etc", "tmp", "var"}:
        alias = Path(absolute.anchor) / parts[1]
        if alias.is_symlink():
            absolute = Path(absolute.anchor) / "private" / Path(*parts[1:])
            parts = absolute.parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = opener(absolute.anchor, flags)
    try:
        for component in parts[1:]:
            try:
                child = opener(component, flags, dir_fd=descriptor)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    mkdirer(component, mode, dir_fd=descriptor)
                except FileExistsError:
                    pass
                child = opener(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


@dataclass(frozen=True)
class RuleResolution:
    status: str
    reason_code: str
    constraints: str = ""
    rule_path: Path | None = None
    rule_path_hash: str = ""
    rule_fingerprint: str = ""


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def safe_project_path(
    root: Path,
    target: str | os.PathLike[str] | Path,
    *,
    allow_missing: bool = True,
) -> Path:
    """Resolve a target while rejecting root escapes and symlink tricks."""
    root_resolved = root.expanduser().resolve(strict=True)
    candidate = Path(target).expanduser()
    if not candidate.is_absolute():
        candidate = root_resolved / candidate
    try:
        resolved = candidate.resolve(strict=not allow_missing)
    except (FileNotFoundError, RuntimeError) as exc:
        raise PathBoundaryError("path_root_changed", "path cannot be resolved") from exc
    if not _is_within(resolved, root_resolved):
        raise PathBoundaryError("path_outside_root", "target escaped project root")
    return resolved


def _walk_to_boundary(start: Path, boundary: Path) -> Iterable[Path]:
    current = start
    while True:
        yield current
        if current == boundary or current.parent == current:
            return
        current = current.parent


def discover_project_root(
    target: str | os.PathLike[str] | Path,
    *,
    boundary: Path | None = None,
) -> Path:
    """Find the project root using the plan's fixed priority."""
    raw = Path(target).expanduser()
    start = raw if raw.is_dir() else raw.parent
    start = start.resolve(strict=True)

    if boundary is None:
        home = Path.home().resolve(strict=True)
        boundary_resolved = home if _is_within(start, home) else start.anchor
        if isinstance(boundary_resolved, str):
            boundary_resolved = Path(boundary_resolved)
    else:
        boundary_resolved = boundary.expanduser().resolve(strict=True)
    if not _is_within(start, boundary_resolved):
        raise PathBoundaryError("path_outside_root", "start outside boundary")

    ancestors = tuple(_walk_to_boundary(start, boundary_resolved))
    for directory in ancestors:
        if (directory / ".project-root").is_file():
            return directory

    try:
        result = subprocess.run(
            ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result is not None and result.returncode == 0:
        git_root = Path(result.stdout.strip()).resolve(strict=True)
        if _is_within(git_root, boundary_resolved) and _is_within(start, git_root):
            return git_root

    for directory in ancestors:
        if any((directory / marker).is_file() for marker in LANGUAGE_ROOT_MARKERS):
            return directory
    raise PathBoundaryError("path_root_unknown", "project root not found")


def file_fingerprint(path: Path) -> str:
    """Hash file identity and content without following symlink files."""
    if path.is_symlink():
        raise PathBoundaryError("path_outside_root", "symlink is not a file witness")
    digest = hashlib.sha256()
    if not path.exists():
        digest.update(b"missing\0")
        return digest.hexdigest()
    if not path.is_file():
        digest.update(b"nonregular\0")
        digest.update(path.name.encode("utf-8", errors="surrogateescape"))
        return digest.hexdigest()
    digest.update(b"file\0")
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ignore_patterns(root: Path) -> tuple[str, ...]:
    ignore_file = root / ".fractalignore"
    if not ignore_file.is_file() or ignore_file.is_symlink():
        return ()
    values = []
    for raw in ignore_file.read_text(encoding="utf-8", errors="strict").splitlines():
        value = raw.strip()
        if value and not value.startswith("#"):
            values.append(value.lstrip("/"))
    return tuple(values)


def _ignored_by_path(root: Path, target: Path) -> bool:
    relative = target.relative_to(root).as_posix()
    parts = target.relative_to(root).parts
    if any(part in IGNORED_DIRECTORIES for part in parts[:-1]):
        return True
    return any(
        fnmatch.fnmatchcase(relative, pattern)
        or (
            pattern.endswith("/**")
            and relative.startswith(pattern.removesuffix("**"))
        )
        for pattern in _ignore_patterns(root)
    )


def _extract_rule_sections(content: str) -> str:
    selected: list[str] = []
    active = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip().lower()
            active = any(
                marker in heading
                for marker in ("约束", "constraint", "lesson", "原则", "规则")
            )
            if active:
                selected.append(line)
            continue
        numbered = _NUMBERED_SECTION.match(line)
        if numbered is not None:
            title = numbered.group("title").strip().lower()
            active = any(
                marker in title
                for marker in ("约束", "constraint", "lesson", "原则", "规则")
            )
            if active:
                selected.append(line)
            continue
        if active and stripped:
            selected.append(line)
    return "\n".join(selected).strip()


def resolve_rule(root: Path, target: Path) -> RuleResolution:
    """Resolve the nearest applicable `.folder.md` rule."""
    root_resolved = root.resolve(strict=True)
    target_resolved = safe_project_path(root_resolved, target)
    if _ignored_by_path(root_resolved, target_resolved):
        return RuleResolution("ignored", "rule_ignored")
    directory = target_resolved if target_resolved.is_dir() else target_resolved.parent
    for current in _walk_to_boundary(directory, root_resolved):
        rule = current / ".folder.md"
        if not rule.is_file() or rule.is_symlink():
            continue
        content = rule.read_text(encoding="utf-8", errors="strict")
        if "<!-- FRACTAL:IGNORE -->" in content:
            return RuleResolution("ignored", "rule_ignored")
        constraints = _extract_rule_sections(content)
        if not constraints:
            return RuleResolution("none", "rule_none")
        return RuleResolution(
            "applied",
            "rule_applied",
            constraints=constraints,
            rule_path=rule,
            rule_path_hash=sha256_text(rule.relative_to(root_resolved).as_posix()),
            rule_fingerprint=sha256_text(content),
        )
    return RuleResolution("none", "rule_none")


def git_changed_fingerprints(root: Path) -> dict[str, str]:
    """Return the current changed/untracked Git paths and content fingerprints."""
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ContractError(
            "state_internal_error",
            "git status unavailable",
            exit_code=75,
            retryable=True,
        ) from exc
    if result.returncode != 0:
        raise ContractError(
            "state_internal_error",
            "git status failed",
            exit_code=75,
            retryable=True,
        )
    records = result.stdout.split(b"\0")
    changed: dict[str, str] = {}
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        decoded = record.decode("utf-8", errors="surrogateescape")
        if len(decoded) < 4:
            raise ContractError(
                "state_internal_error",
                "malformed git status",
                exit_code=75,
                retryable=True,
            )
        status = decoded[:2]
        path_values = [decoded[3:]]
        if any(marker in status for marker in ("R", "C")):
            if index >= len(records) or not records[index]:
                raise ContractError(
                    "state_internal_error",
                    "malformed git rename status",
                    exit_code=75,
                    retryable=True,
                )
            path_values.append(
                records[index].decode("utf-8", errors="surrogateescape")
            )
            index += 1
        for path_value in path_values:
            target = safe_project_path(root, path_value)
            relative = target.relative_to(root.resolve()).as_posix()
            parts = Path(relative).parts
            if (
                (parts and parts[0] == ".context")
                or target.name == ".folder.md"
                or relative == "README.md"
            ):
                continue
            changed[relative] = file_fingerprint(target)
    return dict(sorted(changed.items()))


def supported_code_file(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_CODE_EXTENSIONS


def graph_code_file(path: Path) -> bool:
    return (
        path.suffix.lower() in GRAPH_EXTENSIONS
        and not any(part in GRAPH_IGNORED_DIRECTORIES for part in path.parts[:-1])
    )
