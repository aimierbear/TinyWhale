"""Manifest-driven runtime and adapter discovery."""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from .contract import AdapterError, ContractError, validate_manifest


class ManifestRegistry:
    def __init__(
        self,
        *,
        artifact_root: Path,
        runtime_manifest_dir: Path | None = None,
        manifest_dir: Path | None = None,
    ) -> None:
        if (runtime_manifest_dir is None) == (manifest_dir is None):
            raise ValueError("exactly one runtime manifest directory is required")
        selected = (
            runtime_manifest_dir
            if runtime_manifest_dir is not None
            else manifest_dir
        )
        assert selected is not None
        self.runtime_manifest_dir = Path(
            os.path.abspath(selected.expanduser())
        )
        self.manifest_dir = self.runtime_manifest_dir
        try:
            self.artifact_root = artifact_root.expanduser().resolve(strict=True)
        except OSError as exc:
            raise ValueError("artifact root missing or unsafe") from exc
        if not self.artifact_root.is_dir():
            raise ValueError("artifact root missing or unsafe")
        if (
            self.runtime_manifest_dir.is_symlink()
            or not self.runtime_manifest_dir.is_dir()
        ):
            raise ValueError("runtime manifest directory missing or unsafe")
        self._sources: dict[str, Path] = {}

    def load(self, *, verify_artifacts: bool = True) -> dict[str, dict[str, Any]]:
        manifests: dict[str, dict[str, Any]] = {}
        owners: set[str] = set()
        sources: dict[str, Path] = {}
        for path in sorted(self.runtime_manifest_dir.glob("*.json")):
            try:
                if path.is_symlink() or not path.is_file():
                    raise OSError("unsafe runtime manifest")
                raw = json.loads(path.read_text(encoding="utf-8", errors="strict"))
                manifest = validate_manifest(raw)
            except (OSError, json.JSONDecodeError, ContractError) as exc:
                raise ValueError(f"invalid manifest: {path.name}") from exc
            runtime_id = manifest["id"]
            if runtime_id in manifests:
                raise ValueError(f"duplicate runtime id: {runtime_id}")
            owner_id = manifest["owner_id"]
            if owner_id in owners:
                raise ValueError(f"duplicate owner: {owner_id}")
            if verify_artifacts:
                self._verify_artifacts(manifest)
            manifests[runtime_id] = manifest
            owners.add(owner_id)
            sources[runtime_id] = path
        self._sources = sources
        return manifests

    def _artifact_target(self, relative: Path) -> Path:
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError("artifact escaped root")
        current = self.artifact_root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("artifact missing or unsafe")
        if not current.is_file():
            raise ValueError("artifact missing or unsafe")
        return current

    def _verify_artifacts(self, manifest: dict[str, Any]) -> None:
        for item in manifest["artifacts"]:
            if not isinstance(item, dict) or set(item) != {
                "path",
                "sha256",
                "mode",
            }:
                raise ValueError("invalid artifact entry")
            target = self._artifact_target(Path(item["path"]))
            actual = hashlib.sha256(target.read_bytes()).hexdigest()
            if actual != item["sha256"]:
                raise ValueError("artifact hash mismatch")
            actual_mode = target.stat().st_mode & 0o777
            if actual_mode != int(item["mode"], 8):
                raise ValueError("artifact mode mismatch")

    def _adapter_target(
        self,
        manifest: dict[str, Any],
        module_name: str,
    ) -> Path:
        relative = (
            Path(module_name)
            if "/" in module_name or module_name.endswith(".py")
            else Path(*module_name.split(".")).with_suffix(".py")
        )
        declared = {
            artifact["path"]: artifact for artifact in manifest["artifacts"]
        }
        item = declared.get(relative.as_posix())
        if item is None:
            raise ValueError("adapter is not a declared artifact")
        target = self._artifact_target(relative)
        if hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("adapter artifact hash mismatch")
        if target.stat().st_mode & 0o777 != int(item["mode"], 8):
            raise ValueError("adapter artifact mode mismatch")
        return target

    @staticmethod
    def _reject_foreign_cache(module_name: str, target: Path) -> None:
        cached = sys.modules.get(module_name)
        if cached is None:
            return
        origin = getattr(cached, "__file__", None)
        try:
            cached_origin = (
                None
                if not isinstance(origin, str)
                else Path(origin).resolve(strict=True)
            )
        except OSError:
            cached_origin = None
        if cached_origin != target:
            raise ValueError("adapter module origin mismatch")

    def _module_identity(self, module_name: str, target: Path) -> str:
        if "/" in module_name or module_name.endswith(".py"):
            relative = target.relative_to(self.artifact_root).with_suffix("")
            return ".".join(relative.parts)
        return module_name

    @staticmethod
    def _relative_dependencies(module_name: str, target: Path) -> tuple[str, ...]:
        try:
            tree = ast.parse(target.read_text(encoding="utf-8", errors="strict"))
        except (OSError, SyntaxError, UnicodeError) as exc:
            raise ValueError("manifest adapter cannot be parsed") from exc
        package = module_name.rpartition(".")[0]
        dependencies: list[str] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.level == 0:
                continue
            if not package:
                raise ValueError("relative adapter dependency has no package")
            prefix = "." * node.level
            candidates = (
                (prefix + node.module,)
                if node.module
                else tuple(prefix + alias.name for alias in node.names)
            )
            for candidate in candidates:
                try:
                    dependency = importlib.util.resolve_name(candidate, package)
                except ImportError as exc:
                    raise ValueError("invalid relative adapter dependency") from exc
                if dependency not in dependencies:
                    dependencies.append(dependency)
        return tuple(dependencies)

    def _dependency_closure(
        self,
        manifest: dict[str, Any],
        module_name: str,
        target: Path,
    ) -> tuple[tuple[str, Path], ...]:
        entry = self._module_identity(module_name, target)
        visiting: set[str] = set()
        visited: set[str] = set()
        ordered: list[tuple[str, Path]] = []

        def visit(identity: str, module_target: Path) -> None:
            if identity in visited:
                return
            if identity in visiting:
                raise ValueError("adapter relative dependency cycle")
            visiting.add(identity)
            for dependency in self._relative_dependencies(
                identity,
                module_target,
            ):
                dependency_target = self._adapter_target(
                    manifest,
                    dependency,
                )
                visit(dependency, dependency_target)
            visiting.remove(identity)
            visited.add(identity)
            ordered.append((identity, module_target))

        visit(entry, target)
        for identity, module_target in ordered:
            self._reject_foreign_cache(identity, module_target)
        return tuple(ordered)

    @staticmethod
    def _verified_package(name: str) -> ModuleType:
        package = ModuleType(name)
        package.__package__ = name
        package.__path__ = []
        package.__file__ = None
        return package

    def _load_verified_module(
        self,
        manifest: dict[str, Any],
        module_name: str,
        target: Path,
    ) -> Any:
        closure = self._dependency_closure(manifest, module_name, target)
        entry_identity = self._module_identity(module_name, target)
        namespace = f"_fractal_verified_{uuid.uuid4().hex}"
        created: list[str] = []
        modules: dict[str, Any] = {}
        try:
            identities = [identity for identity, _ in closure]
            package_names = {namespace}
            for identity in identities:
                parts = identity.split(".")
                package_names.update(
                    f"{namespace}.{'.'.join(parts[:index])}"
                    for index in range(1, len(parts))
                )
            for package_name in sorted(
                package_names,
                key=lambda value: value.count("."),
            ):
                sys.modules[package_name] = self._verified_package(package_name)
                created.append(package_name)
            for identity, module_target in closure:
                verified_name = f"{namespace}.{identity}"
                specification = importlib.util.spec_from_file_location(
                    verified_name,
                    module_target,
                )
                if specification is None or specification.loader is None:
                    raise ValueError("manifest adapter cannot be loaded")
                module = importlib.util.module_from_spec(specification)
                module.__dict__["_FRACTAL_ADAPTER_ERROR_TYPE"] = AdapterError
                sys.modules[verified_name] = module
                created.append(verified_name)
                try:
                    specification.loader.exec_module(module)
                except ModuleNotFoundError as exc:
                    raise ValueError(
                        "adapter dependency is not a declared artifact"
                    ) from exc
                parent_name, _, leaf = verified_name.rpartition(".")
                setattr(sys.modules[parent_name], leaf, module)
                modules[identity] = module
        finally:
            for created_name in reversed(created):
                sys.modules.pop(created_name, None)
        return modules[entry_identity]

    def source_path(self, runtime_id: str) -> Path:
        if runtime_id not in self._sources:
            self.load(verify_artifacts=False)
        return self._sources[runtime_id]

    def adapter(self, runtime_id: str) -> Callable[[dict[str, Any]], list[dict[str, Any]]]:
        manifests = self.load()
        manifest = manifests[runtime_id]
        module_name, separator, function_name = manifest["adapter"].partition(":")
        if not separator:
            raise ValueError("manifest adapter must name module:function")
        target = self._adapter_target(manifest, module_name)
        module = self._load_verified_module(manifest, module_name, target)
        function = getattr(module, function_name)
        if not callable(function):
            raise ValueError("manifest adapter is not callable")
        return function
