"""Versioned, hash-verified and rollback-capable local releases."""

from __future__ import annotations

import ast
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping

from .contract import ContractError, validate_manifest
from .util import canonical_json, has_unsafe_symlink_component

_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_VOLATILE_FILE_FLAGS = (
    int(getattr(stat, "UF_TRACKED", 0)) if sys.platform == "darwin" else 0
)
StagingValidator = Callable[[Path], bool | None]
InventoryEntry = tuple[
    str,
    str,
    int,
    int,
    int,
    int,
    int,
    int,
    int,
    int,
    int,
    int,
    str,
]
InventorySnapshot = tuple[InventoryEntry, ...]
_AJV_SCHEMA_CHECK = r"""
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const search = [input.nodeModules];
const Ajv2020 = require(require.resolve("ajv/dist/2020", {paths: search})).default;
const addFormats = require(require.resolve("ajv-formats", {paths: search}));
const ajv = new Ajv2020({allErrors: true, strict: true});
addFormats(ajv);
ajv.compile(input.schema);
"""


class ReleaseError(RuntimeError):
    pass


_PRODUCT_ENTRY_ARTIFACTS = frozenset(
    {"bin/fractal-action", "bin/fractal-capability", "bin/fractal-manage"}
)
_PRODUCT_ENTRY_MODULES = (
    "fractal_agent.capability_cli",
    "fractal_agent.cli",
    "fractal_agent.management",
)


def _stable_file_flags(metadata: os.stat_result) -> int:
    """Return file flags after excluding OS-managed document tracking state."""

    flags = int(getattr(metadata, "st_flags", 0))
    if stat.S_ISREG(metadata.st_mode):
        return flags & ~_VOLATILE_FILE_FLAGS
    return flags


def _release_artifact_relative(relative: str) -> Path:
    if not isinstance(relative, str) or not relative:
        raise ReleaseError("invalid release artifact path")
    value = Path(relative)
    if (
        value.is_absolute()
        or ".." in value.parts
        or not value.parts
    ):
        raise ReleaseError("invalid release artifact path")
    return value


def verify_closed_release_inventory(
    release: Path,
    artifact_names: Iterable[str],
    *,
    expected_snapshot: InventorySnapshot | None = None,
) -> InventorySnapshot:
    """Verify and snapshot the complete, regular release tree."""

    def metadata_for(path: Path) -> os.stat_result:
        try:
            return os.lstat(path)
        except OSError as exc:
            raise ReleaseError("release inventory changed") from exc

    def signature(
        relative: str,
        kind: str,
        metadata: os.stat_result,
        digest: str = "",
    ) -> InventoryEntry:
        return (
            relative,
            kind,
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_uid,
            metadata.st_gid,
            stat.S_IMODE(metadata.st_mode),
            metadata.st_nlink,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns if kind == "directory" else 0,
            (
                _stable_file_flags(metadata)
                if kind == "file"
                else int(getattr(metadata, "st_flags", 0))
            ),
            digest,
        )

    def file_signature(
        path: Path,
        relative: str,
        expected: os.stat_result,
    ) -> InventoryEntry:
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise ReleaseError("release inventory changed") from exc
        try:
            before = os.fstat(descriptor)
            if (
                not stat.S_ISREG(before.st_mode)
                or signature(relative, "file", before)
                != signature(relative, "file", expected)
            ):
                raise ReleaseError("release inventory changed")
            content = hashlib.sha256()
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                content.update(chunk)
            after = os.fstat(descriptor)
            if signature(relative, "file", after) != signature(
                relative,
                "file",
                before,
            ):
                raise ReleaseError("release inventory changed")
            return signature(relative, "file", after, content.hexdigest())
        finally:
            os.close(descriptor)

    release_metadata = metadata_for(release)
    if (
        stat.S_ISLNK(release_metadata.st_mode)
        or not stat.S_ISDIR(release_metadata.st_mode)
    ):
        raise ReleaseError("release directory is unsafe")
    expected_files = {"release-manifest.json"}
    expected_directories: set[str] = set()
    for relative in artifact_names:
        value = _release_artifact_relative(relative)
        if value.as_posix() != relative:
            raise ReleaseError("non-canonical release artifact path")
        expected_files.add(relative)
        parent = value.parent
        while parent != Path("."):
            expected_directories.add(parent.as_posix())
            parent = parent.parent

    actual_files: set[str] = set()
    actual_directories: set[str] = set()
    snapshot_entries = [signature("", "directory", release_metadata)]

    def scan(
        directory: Path,
        prefix: Path,
        expected_directory: os.stat_result,
    ) -> None:
        before = metadata_for(directory)
        if (
            not stat.S_ISDIR(before.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or signature("", "directory", before)
            != signature("", "directory", expected_directory)
        ):
            raise ReleaseError("release directory identity changed")
        try:
            entries = list(os.scandir(directory))
        except OSError as exc:
            raise ReleaseError("release inventory cannot be enumerated") from exc
        for entry in entries:
            relative = prefix / entry.name
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise ReleaseError("release inventory changed") from exc
            if stat.S_ISLNK(metadata.st_mode):
                raise ReleaseError("release inventory symlink refused")
            if stat.S_ISREG(metadata.st_mode):
                actual_files.add(relative.as_posix())
                snapshot_entries.append(file_signature(
                    Path(entry.path),
                    relative.as_posix(),
                    metadata,
                ))
            elif stat.S_ISDIR(metadata.st_mode):
                actual_directories.add(relative.as_posix())
                snapshot_entries.append(
                    signature(relative.as_posix(), "directory", metadata)
                )
                scan(Path(entry.path), relative, metadata)
            else:
                raise ReleaseError("release inventory contains special entry")
        after = metadata_for(directory)
        if signature("", "directory", after) != signature(
            "",
            "directory",
            before,
        ):
            raise ReleaseError("release inventory changed during enumeration")

    scan(release, Path(), release_metadata)
    if actual_files != expected_files:
        raise ReleaseError("release file inventory mismatch")
    if actual_directories != expected_directories:
        raise ReleaseError("release directory inventory mismatch")
    snapshot = tuple(sorted(snapshot_entries))
    if expected_snapshot is not None and snapshot != expected_snapshot:
        raise ReleaseError("release inventory changed during verification")
    return snapshot


def entrypoint_import_closure(root: Path) -> tuple[str, ...]:
    """Return both product entrypoints' complete static local import closure."""
    package_root = root / "fractal_agent"
    if package_root.is_symlink() or not package_root.is_dir():
        raise ReleaseError("entrypoint import closure root is unsafe")
    modules: dict[str, tuple[Path, bool]] = {}
    for target in package_root.rglob("*.py"):
        if target.is_symlink() or not target.is_file():
            raise ReleaseError("entrypoint import closure artifact is unsafe")
        relative = target.relative_to(root)
        if target.name == "__init__.py":
            identity = ".".join(relative.parent.parts)
            is_package = True
        else:
            identity = ".".join(relative.with_suffix("").parts)
            is_package = False
        modules[identity] = (target, is_package)

    closure: set[str] = set()
    visiting: set[str] = set()
    visited: set[str] = set()

    def require_local(identity: str) -> None:
        if identity in visited:
            return
        if identity in visiting:
            raise ReleaseError(
                f"entrypoint import cycle detected: {identity}"
            )
        item = modules.get(identity)
        if item is None:
            raise ReleaseError(
                f"entrypoint import closure dependency is missing: {identity}"
            )
        target, is_package = item
        visiting.add(identity)
        package = identity if is_package else identity.rpartition(".")[0]
        try:
            tree = ast.parse(
                target.read_text(encoding="utf-8", errors="strict"),
                filename=target.relative_to(root).as_posix(),
            )
        except (OSError, SyntaxError, UnicodeError) as exc:
            raise ReleaseError("entrypoint import closure cannot be parsed") from exc
        dependencies: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                dependencies.update(alias.name for alias in node.names)
                continue
            if not isinstance(node, ast.ImportFrom):
                continue
            if node.level:
                reference = "." * node.level + (node.module or "")
                try:
                    base = importlib.util.resolve_name(reference, package)
                except (ImportError, ValueError) as exc:
                    raise ReleaseError(
                        "entrypoint import closure is invalid"
                    ) from exc
            else:
                base = node.module or ""
            if base:
                dependencies.add(base)
            for alias in node.names:
                candidate = f"{base}.{alias.name}" if base else alias.name
                if candidate in modules:
                    dependencies.add(candidate)
        for dependency in sorted(dependencies):
            if dependency == "fractal_agent" or dependency.startswith(
                "fractal_agent."
            ):
                require_local(dependency)
        visiting.remove(identity)
        visited.add(identity)
        closure.add(target.relative_to(root).as_posix())

    require_local("fractal_agent")
    for entrypoint in _PRODUCT_ENTRY_MODULES:
        require_local(entrypoint)
    return tuple(sorted(closure))


class ReleaseManager:
    def __init__(
        self,
        *,
        source_root: Path,
        install_root: Path,
        artifacts: Iterable[str],
        staging_validator: StagingValidator | None = None,
    ) -> None:
        self.source_root = source_root.expanduser()
        self.install_root = install_root.expanduser()
        self.artifacts = tuple(sorted(set(artifacts)))
        self.staging_validator = staging_validator

    def _source(self, relative: str) -> Path:
        value = Path(relative)
        if value.is_absolute() or ".." in value.parts or not value.parts:
            raise ReleaseError("invalid artifact path")
        if (
            has_unsafe_symlink_component(self.source_root)
            or self.source_root.is_symlink()
            or not self.source_root.is_dir()
        ):
            raise ReleaseError("invalid source root")
        current = self.source_root
        for part in value.parts:
            current = current / part
            if current.is_symlink():
                raise ReleaseError("symlink artifact refused")
        if not current.is_file():
            raise ReleaseError("artifact is not a regular file")
        return current

    @staticmethod
    def _read_no_follow(path: Path) -> tuple[bytes, os.stat_result]:
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise ReleaseError("artifact cannot be opened safely") from exc
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise ReleaseError("artifact is not regular")
            chunks: list[bytes] = []
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks), metadata
        finally:
            os.close(descriptor)

    def _artifact_plan(self) -> tuple[dict[str, Any], dict[str, bytes]]:
        metadata: dict[str, Any] = {}
        content: dict[str, bytes] = {}
        for relative in self.artifacts:
            source = self._source(relative)
            raw, source_metadata = self._read_no_follow(source)
            mode = 0o755 if source_metadata.st_mode & stat.S_IXUSR else 0o644
            metadata[relative] = {
                "sha256": hashlib.sha256(raw).hexdigest(),
                "size": len(raw),
                "mode": f"{mode:04o}",
            }
            content[relative] = raw
        return metadata, content

    def _validate_destination(self) -> None:
        if has_unsafe_symlink_component(self.install_root):
            raise ReleaseError("install ancestor is a symlink")
        current = self.install_root
        while not current.exists() and current.parent != current:
            current = current.parent
        if current.is_symlink():
            raise ReleaseError("install ancestor is a symlink")
        if self.install_root.exists() and (
            self.install_root.is_symlink() or not self.install_root.is_dir()
        ):
            raise ReleaseError("invalid install root")

    @staticmethod
    def _directory_identity(path: Path) -> tuple[int, int]:
        try:
            metadata = os.lstat(path)
        except OSError as exc:
            raise ReleaseError("directory identity is unavailable") from exc
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise ReleaseError("directory identity is unsafe")
        return metadata.st_dev, metadata.st_ino

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            flags |= os.O_DIRECTORY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise ReleaseError("directory cannot be opened for fsync") from exc
        try:
            if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise ReleaseError("fsync target is not a directory")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _replace_symlink(self, link: Path, target: str) -> None:
        temporary = link.parent / f".{link.name}.{secrets.token_hex(8)}"
        temporary_created = False
        try:
            os.symlink(target, temporary)
            temporary_created = True
            os.replace(temporary, link)
            temporary_created = False
            self._fsync_directory(link.parent)
        finally:
            if temporary_created and temporary.is_symlink():
                temporary.unlink()
                temporary_created = False
                self._fsync_directory(link.parent)
            elif temporary_created:
                raise ReleaseError("temporary release link changed unexpectedly")

    @staticmethod
    def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ReleaseError("JSON artifact contains duplicate keys")
            result[key] = value
        return result

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ReleaseError(f"JSON artifact contains invalid number: {value}")

    @classmethod
    def _strict_json(cls, raw: bytes) -> Any:
        try:
            text = raw.decode("utf-8", errors="strict")
            return json.loads(
                text,
                object_pairs_hook=cls._strict_object,
                parse_constant=cls._reject_constant,
            )
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReleaseError("invalid JSON artifact") from exc

    @staticmethod
    def _artifact_relative(relative: str) -> Path:
        return _release_artifact_relative(relative)

    def _release_artifact(
        self,
        release: Path,
        relative: str,
    ) -> tuple[bytes, os.stat_result]:
        value = self._artifact_relative(relative)
        if release.is_symlink() or not release.is_dir():
            raise ReleaseError("release directory is unsafe")
        current = release
        for part in value.parts:
            current = current / part
            if current.is_symlink():
                raise ReleaseError("release artifact symlink refused")
        if not current.is_file():
            raise ReleaseError("release artifact is missing")
        return self._read_no_follow(current)

    def _verify_closed_inventory(
        self,
        release: Path,
        artifact_names: Iterable[str],
        *,
        expected_snapshot: InventorySnapshot | None = None,
    ) -> InventorySnapshot:
        return verify_closed_release_inventory(
            release,
            artifact_names,
            expected_snapshot=expected_snapshot,
        )

    @staticmethod
    def _same_metadata(
        left: os.stat_result,
        right: os.stat_result,
    ) -> bool:
        return (
            left.st_dev,
            left.st_ino,
            left.st_uid,
            left.st_gid,
            left.st_mode,
            left.st_nlink,
            left.st_size,
            left.st_mtime_ns,
            _stable_file_flags(left),
        ) == (
            right.st_dev,
            right.st_ino,
            right.st_uid,
            right.st_gid,
            right.st_mode,
            right.st_nlink,
            right.st_size,
            right.st_mtime_ns,
            _stable_file_flags(right),
        )

    @staticmethod
    def _validate_draft_2020_schema(document: Mapping[str, Any]) -> None:
        candidates = (
            Path(__file__).resolve().parents[1] / "node_modules",
            Path.home() / ".gstack" / "repos" / "gstack" / "node_modules",
        )
        node_modules = next(
            (
                candidate
                for candidate in candidates
                if (candidate / "ajv" / "dist" / "2020.js").is_file()
                and (candidate / "ajv-formats").is_dir()
            ),
            None,
        )
        if node_modules is None:
            raise ReleaseError("Draft 2020-12 schema validator is unavailable")
        try:
            completed = subprocess.run(
                ["node", "-e", _AJV_SCHEMA_CHECK],
                input=json.dumps(
                    {
                        "nodeModules": str(node_modules),
                        "schema": document,
                    }
                ),
                text=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ReleaseError("Draft 2020-12 schema validation failed") from exc
        if completed.returncode != 0:
            raise ReleaseError("invalid Draft 2020-12 machine contract")

    @classmethod
    def _validate_contract_document(
        cls,
        relative: str,
        document: Any,
    ) -> None:
        if not isinstance(document, Mapping):
            raise ReleaseError("machine contract must be an object")
        name = Path(relative).name
        if name.endswith(".schema.json"):
            cls._validate_draft_2020_schema(document)
            if (
                document.get("$schema")
                != "https://json-schema.org/draft/2020-12/schema"
                or not isinstance(document.get("$id"), str)
            ):
                raise ReleaseError("invalid machine contract schema")
            if name == "action-v1.schema.json":
                if not isinstance(document.get("oneOf"), list) or not isinstance(
                    document.get("$defs"),
                    Mapping,
                ):
                    raise ReleaseError("invalid action machine contract")
            elif (
                document.get("type") != "object"
                or not isinstance(document.get("required"), list)
                or not isinstance(document.get("properties"), Mapping)
            ):
                raise ReleaseError("invalid object machine contract")
        elif name == "reason-codes-v1.json":
            if (
                document.get("version") != 1
                or not isinstance(document.get("prefixes"), list)
                or not all(
                    isinstance(value, str) and value
                    for value in document["prefixes"]
                )
                or not isinstance(document.get("required"), list)
                or not all(
                    isinstance(value, str) and value
                    for value in document["required"]
                )
            ):
                raise ReleaseError("invalid reason-code machine contract")

    def _verify_release(
        self,
        release: Path,
        *,
        version: str,
        expected_artifacts: Mapping[str, Any] | None = None,
    ) -> None:
        if release.is_symlink() or not release.is_dir():
            raise ReleaseError("release is missing or unsafe")
        manifest_raw, manifest_metadata = self._release_artifact(
            release,
            "release-manifest.json",
        )
        bootstrap_manifest = self._strict_json(manifest_raw)
        if (
            not isinstance(bootstrap_manifest, Mapping)
            or not isinstance(bootstrap_manifest.get("artifacts"), Mapping)
        ):
            raise ReleaseError("invalid release manifest")
        inventory_snapshot = self._verify_closed_inventory(
            release,
            bootstrap_manifest["artifacts"],
        )
        confirmed_manifest_raw, confirmed_manifest_metadata = (
            self._release_artifact(release, "release-manifest.json")
        )
        if (
            confirmed_manifest_raw != manifest_raw
            or not self._same_metadata(
                confirmed_manifest_metadata,
                manifest_metadata,
            )
        ):
            raise ReleaseError("release manifest changed during verification")
        manifest = self._strict_json(confirmed_manifest_raw)
        if (
            stat.S_IMODE(confirmed_manifest_metadata.st_mode) != 0o644
            or not isinstance(manifest, Mapping)
            or set(manifest) != {
                "schema_version",
                "version",
                "release_digest",
                "artifacts",
            }
        ):
            raise ReleaseError("invalid release manifest")
        artifacts = manifest["artifacts"]
        if (
            manifest["schema_version"] != 1
            or manifest["version"] != version
            or not isinstance(artifacts, Mapping)
            or not isinstance(manifest["release_digest"], str)
            or not _HASH_RE.fullmatch(manifest["release_digest"])
        ):
            raise ReleaseError("invalid release manifest")
        if expected_artifacts is not None and artifacts != expected_artifacts:
            raise ReleaseError("staged release manifest changed")
        expected_digest = hashlib.sha256(
            canonical_json(artifacts).encode("utf-8")
        ).hexdigest()
        if manifest["release_digest"] != expected_digest:
            raise ReleaseError("release digest mismatch")
        json_documents: dict[str, Any] = {}
        for relative, item in artifacts.items():
            if (
                not isinstance(relative, str)
                or relative == "release-manifest.json"
                or not isinstance(item, Mapping)
                or set(item) != {"sha256", "size", "mode"}
                or not isinstance(item["sha256"], str)
                or not _HASH_RE.fullmatch(item["sha256"])
                or not isinstance(item["size"], int)
                or isinstance(item["size"], bool)
                or item["size"] < 0
                or item["mode"] not in {"0644", "0755"}
            ):
                raise ReleaseError("invalid release artifact metadata")
            raw, metadata = self._release_artifact(release, relative)
            if (
                len(raw) != item["size"]
                or hashlib.sha256(raw).hexdigest() != item["sha256"]
                or stat.S_IMODE(metadata.st_mode) != int(item["mode"], 8)
            ):
                raise ReleaseError("release artifact verification failed")
            suffix = Path(relative).suffix
            if suffix == ".json":
                json_documents[relative] = self._strict_json(raw)
            elif suffix == ".py":
                try:
                    source = raw.decode("utf-8", errors="strict")
                    compile(source, relative, "exec", dont_inherit=True)
                except (UnicodeDecodeError, SyntaxError, ValueError) as exc:
                    raise ReleaseError("invalid Python artifact") from exc

        owners: set[str] = set()
        runtime_ids: set[str] = set()
        for relative, document in json_documents.items():
            path = Path(relative)
            if path.parent == Path("manifests"):
                try:
                    validated = validate_manifest(document)
                except ContractError as exc:
                    raise ReleaseError("invalid runtime manifest") from exc
                if validated["id"] != path.stem:
                    raise ReleaseError("runtime manifest filename mismatch")
                if validated["id"] in runtime_ids or validated["owner_id"] in owners:
                    raise ReleaseError("duplicate runtime manifest identity")
                runtime_ids.add(validated["id"])
                owners.add(validated["owner_id"])
                for declared in validated["artifacts"]:
                    raw, metadata = self._release_artifact(
                        release,
                        declared["path"],
                    )
                    if (
                        hashlib.sha256(raw).hexdigest() != declared["sha256"]
                        or stat.S_IMODE(metadata.st_mode)
                        != int(declared["mode"], 8)
                    ):
                        raise ReleaseError(
                            "runtime manifest artifact verification failed"
                        )
            elif path.parts and path.parts[0] == "contracts":
                self._validate_contract_document(relative, document)
        if _PRODUCT_ENTRY_ARTIFACTS.issubset(artifacts):
            closure = set(entrypoint_import_closure(release))
            if not closure.issubset(artifacts):
                raise ReleaseError("entrypoint import closure is incomplete")
        final_manifest_raw, final_manifest_metadata = self._release_artifact(
            release,
            "release-manifest.json",
        )
        if (
            final_manifest_raw != manifest_raw
            or not self._same_metadata(
                final_manifest_metadata,
                manifest_metadata,
            )
        ):
            raise ReleaseError("release manifest changed during verification")
        self._verify_closed_inventory(
            release,
            artifacts,
            expected_snapshot=inventory_snapshot,
        )

    @staticmethod
    def _snapshot_value(snapshot: Mapping[str, Any], name: str) -> str | None:
        value = snapshot.get(name)
        if value is not None and not isinstance(value, str):
            raise ReleaseError("invalid recovery journal")
        return value

    def _validate_release_target(self, target: str) -> Path:
        value = Path(target)
        if (
            value.is_absolute()
            or len(value.parts) != 2
            or value.parts[0] != "releases"
            or not _VERSION_RE.fullmatch(value.parts[1])
            or target != f"releases/{value.parts[1]}"
        ):
            raise ReleaseError("release link target escaped releases")
        releases = self.install_root / "releases"
        if releases.is_symlink() or not releases.is_dir():
            raise ReleaseError("releases directory is missing or unsafe")
        release = releases / value.parts[1]
        if release.is_symlink() or not release.is_dir():
            raise ReleaseError("release target is missing or unsafe")
        self._verify_release(release, version=value.parts[1])
        return release

    def _link_value(self, name: str) -> str | None:
        link = self.install_root / name
        if link.is_symlink():
            target = os.readlink(link)
            self._validate_release_target(target)
            return target
        if os.path.lexists(link):
            raise ReleaseError(f"{name} is not a symlink")
        return None

    def _snapshot_links(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "current": self._link_value("current"),
            "previous": self._link_value("previous"),
        }

    @property
    def _journal(self) -> Path:
        return self.install_root / ".fractal-release-recovery.json"

    def _write_journal(self, snapshot: Mapping[str, Any]) -> None:
        journal = self._journal
        if journal.is_symlink():
            raise ReleaseError("release recovery journal symlink refused")
        descriptor, temporary = tempfile.mkstemp(
            prefix=".fractal-release-recovery.",
            dir=self.install_root,
        )
        try:
            os.fchmod(descriptor, 0o600)
            data = (
                json.dumps(
                    dict(snapshot),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            ).encode("utf-8")
            with os.fdopen(descriptor, "wb", closefd=True) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, journal)
            self._fsync_directory(self.install_root)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            else:
                self._fsync_directory(self.install_root)

    def _read_journal(self) -> dict[str, Any]:
        raw, metadata = self._read_no_follow(self._journal)
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise ReleaseError("invalid recovery journal mode")
        document = self._strict_json(raw)
        if (
            not isinstance(document, dict)
            or set(document) != {"schema_version", "current", "previous"}
            or document["schema_version"] != 1
        ):
            raise ReleaseError("invalid recovery journal")
        self._snapshot_value(document, "current")
        self._snapshot_value(document, "previous")
        return document

    def _restore_link(self, name: str, target: str | None) -> None:
        link = self.install_root / name
        if target is None:
            if link.is_symlink():
                link.unlink()
                self._fsync_directory(link.parent)
            elif os.path.lexists(link):
                raise ReleaseError(f"cannot restore non-symlink {name}")
            return
        self._validate_release_target(target)
        self._replace_symlink(link, target)

    def _restore_snapshot(self, snapshot: Mapping[str, Any]) -> None:
        self._restore_link(
            "current",
            self._snapshot_value(snapshot, "current"),
        )
        self._restore_link(
            "previous",
            self._snapshot_value(snapshot, "previous"),
        )

    def _remove_journal(self) -> None:
        if self._journal.is_symlink():
            raise ReleaseError("release recovery journal symlink refused")
        try:
            self._journal.unlink()
        except FileNotFoundError:
            pass
        else:
            self._fsync_directory(self.install_root)

    def _recover_journal(self) -> None:
        if not os.path.lexists(self._journal):
            return
        snapshot = self._read_journal()
        self._restore_snapshot(snapshot)
        self._remove_journal()

    @contextmanager
    def _operation_lock(self) -> Iterator[None]:
        self._validate_destination()
        self.install_root.mkdir(parents=True, exist_ok=True, mode=0o755)
        self._validate_destination()
        lock = self.install_root / ".fractal-release.lock"
        if lock.is_symlink():
            raise ReleaseError("release lock symlink refused")
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(lock, flags, 0o600)
        except OSError as exc:
            raise ReleaseError("release lock cannot be opened safely") from exc
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ReleaseError("release lock is not regular")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (BlockingIOError, OSError) as exc:
                raise ReleaseError("cooperative release lock is busy") from exc
            self._recover_journal()
            yield
        finally:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)

    def _cleanup_owned_directory(
        self,
        path: Path,
        identity: tuple[int, int] | None,
    ) -> None:
        if identity is None:
            return
        try:
            metadata = os.lstat(path)
        except FileNotFoundError:
            return
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != identity
        ):
            return
        shutil.rmtree(path)
        self._fsync_directory(path.parent)

    def _fsync_tree(self, root: Path) -> None:
        try:
            entries = list(os.scandir(root))
        except OSError as exc:
            raise ReleaseError("staging tree cannot be fsynced") from exc
        for entry in entries:
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise ReleaseError("staging tree changed during fsync") from exc
            path = Path(entry.path)
            if stat.S_ISREG(metadata.st_mode):
                flags = os.O_RDONLY
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(path, flags)
                try:
                    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                        raise ReleaseError("staging file changed during fsync")
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            elif stat.S_ISDIR(metadata.st_mode):
                self._fsync_tree(path)
            else:
                raise ReleaseError("staging tree contains unsafe entry")
        self._fsync_directory(root)

    def _populate_reserved_release(self, staging: Path, final: Path) -> None:
        try:
            entries = list(os.scandir(staging))
        except OSError as exc:
            raise ReleaseError("staging publish cannot be enumerated") from exc
        for entry in entries:
            destination = final / entry.name
            if os.path.lexists(destination):
                raise ReleaseError("reserved release was modified concurrently")
            os.rename(entry.path, destination)
        os.rmdir(staging)
        self._fsync_directory(final)
        os.chmod(final, 0o755)
        self._fsync_directory(final)
        self._fsync_directory(final.parent)

    def _restore_after_failure(self, snapshot: Mapping[str, Any]) -> bool:
        try:
            self._restore_snapshot(snapshot)
            if os.path.lexists(self._journal):
                self._remove_journal()
            return True
        except Exception:
            return False

    def install(self, version: str, dry_run: bool = False) -> dict[str, Any]:
        if not _VERSION_RE.fullmatch(version):
            raise ReleaseError("invalid version")
        metadata, content = self._artifact_plan()
        result = {
            "status": "dry_run" if dry_run else "installed",
            "version": version,
            "artifacts": metadata,
            "release_digest": hashlib.sha256(
                canonical_json(metadata).encode("utf-8")
            ).hexdigest(),
        }
        if dry_run:
            return result

        with self._operation_lock():
            snapshot = self._snapshot_links()
            releases = self.install_root / "releases"
            if releases.is_symlink() or (
                releases.exists() and not releases.is_dir()
            ):
                raise ReleaseError("releases path is unsafe")
            releases_existed = releases.exists()
            releases.mkdir(parents=True, exist_ok=True, mode=0o755)
            if not releases_existed:
                self._fsync_directory(self.install_root)
            final = releases / version
            if final.exists() or final.is_symlink():
                raise ReleaseError("release already exists")
            staging = releases / f".staging-{version}-{secrets.token_hex(8)}"
            staging.mkdir(mode=0o700)
            staging_identity = self._directory_identity(staging)
            final_identity: tuple[int, int] | None = None
            try:
                for relative, raw in content.items():
                    destination = staging / relative
                    destination.parent.mkdir(
                        parents=True,
                        exist_ok=True,
                        mode=0o755,
                    )
                    destination.write_bytes(raw)
                    os.chmod(destination, int(metadata[relative]["mode"], 8))
                manifest = {
                    "schema_version": 1,
                    "version": version,
                    "release_digest": result["release_digest"],
                    "artifacts": metadata,
                }
                manifest_path = staging / "release-manifest.json"
                manifest_path.write_text(
                    json.dumps(
                        manifest,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    + "\n",
                    encoding="utf-8",
                )
                os.chmod(manifest_path, 0o644)
                for directory in sorted(
                    (path for path in staging.rglob("*") if path.is_dir()),
                    key=lambda item: len(item.parts),
                    reverse=True,
                ):
                    os.chmod(directory, 0o755)
                os.chmod(staging, 0o755)
                self._verify_release(
                    staging,
                    version=version,
                    expected_artifacts=metadata,
                )
                if self.staging_validator is not None:
                    try:
                        validation = self.staging_validator(staging)
                    except Exception as exc:
                        raise ReleaseError("staging validator failed") from exc
                    if validation is False:
                        raise ReleaseError("staging validator failed")
                self._verify_release(
                    staging,
                    version=version,
                    expected_artifacts=metadata,
                )
                self._fsync_tree(staging)
                try:
                    os.mkdir(final, 0o700)
                except FileExistsError as exc:
                    raise ReleaseError("release already exists") from exc
                final_identity = self._directory_identity(final)
                self._fsync_directory(releases)
                self._populate_reserved_release(staging, final)
                self._write_journal(snapshot)
                current_target = self._snapshot_value(snapshot, "current")
                if current_target is not None:
                    self._replace_symlink(
                        self.install_root / "previous",
                        current_target,
                    )
                self._replace_symlink(
                    self.install_root / "current",
                    f"releases/{version}",
                )
                self._remove_journal()
                return result
            except Exception:
                restored = self._restore_after_failure(snapshot)
                self._cleanup_owned_directory(staging, staging_identity)
                if restored:
                    self._cleanup_owned_directory(final, final_identity)
                raise

    def rollback(self) -> dict[str, Any]:
        with self._operation_lock():
            snapshot = self._snapshot_links()
            current_target = self._snapshot_value(snapshot, "current")
            previous_target = self._snapshot_value(snapshot, "previous")
            if current_target is None or previous_target is None:
                raise ReleaseError("rollback links are unavailable")
            if current_target == previous_target:
                raise ReleaseError("rollback links collapse onto one release")
            self._write_journal(snapshot)
            try:
                self._replace_symlink(
                    self.install_root / "current",
                    previous_target,
                )
                self._replace_symlink(
                    self.install_root / "previous",
                    current_target,
                )
                self._remove_journal()
            except Exception:
                self._restore_after_failure(snapshot)
                raise
            return {
                "status": "rolled_back",
                "current": previous_target.removeprefix("releases/"),
                "previous": current_target.removeprefix("releases/"),
            }
