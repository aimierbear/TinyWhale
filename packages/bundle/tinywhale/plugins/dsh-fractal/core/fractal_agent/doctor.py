"""Manifest-driven health reporting without content or credential output."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .registry import ManifestRegistry
from .release import ReleaseError, verify_closed_release_inventory
from .state import StateStore
from .util import canonical_json, parse_time

_RANK = {"green": 0, "yellow": 1, "red": 2}
_CORE_CAPABILITIES = ("constraints", "change_detection", "closeout")
ProbeVerifier = Callable[[Mapping[str, Any]], bool]


class HealthDoctor:
    def __init__(
        self,
        *,
        artifact_root: Path,
        runtime_manifest_dir: Path | None = None,
        manifest_dir: Path | None = None,
        state_root: Path | None = None,
        probe_verifier: ProbeVerifier | None = None,
    ) -> None:
        self.registry = ManifestRegistry(
            runtime_manifest_dir=runtime_manifest_dir,
            manifest_dir=manifest_dir,
            artifact_root=artifact_root,
        )
        self.artifact_root = self.registry.artifact_root
        self.store = None if state_root is None else StateStore(state_root)
        self.probe_verifier = probe_verifier

    @staticmethod
    def _status(
        status: str,
        source: str,
        reason_code: str,
    ) -> dict[str, str]:
        return {
            "status": status,
            "source": source,
            "reason_code": reason_code,
        }

    def _release_receipt(self) -> dict[str, Any] | None:
        try:
            target = self.registry._artifact_target(Path("release-manifest.json"))
            manifest_bytes = target.read_bytes()
            bootstrap = json.loads(
                manifest_bytes.decode("utf-8", errors="strict")
            )
        except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return None
        if (
            not isinstance(bootstrap, dict)
            or not isinstance(bootstrap.get("artifacts"), dict)
        ):
            return None
        try:
            inventory_snapshot = verify_closed_release_inventory(
                self.artifact_root,
                bootstrap["artifacts"],
            )
            confirmed_manifest_bytes = target.read_bytes()
        except (OSError, ReleaseError):
            return None
        if confirmed_manifest_bytes != manifest_bytes:
            return None
        try:
            raw = json.loads(
                confirmed_manifest_bytes.decode("utf-8", errors="strict")
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return None
        if not isinstance(raw, dict) or set(raw) != {
            "schema_version",
            "version",
            "release_digest",
            "artifacts",
        }:
            return None
        if raw["schema_version"] != 1:
            return None
        if not isinstance(raw["version"], str) or not raw["version"]:
            return None
        release_digest = raw["release_digest"]
        artifacts = raw["artifacts"]
        if (
            not isinstance(release_digest, str)
            or len(release_digest) != 64
            or not isinstance(artifacts, dict)
        ):
            return None
        expected_digest = hashlib.sha256(
            canonical_json(artifacts).encode("utf-8")
        ).hexdigest()
        if release_digest != expected_digest:
            return None
        for relative, metadata in artifacts.items():
            if (
                not isinstance(relative, str)
                or not isinstance(metadata, dict)
                or set(metadata) != {"sha256", "size", "mode"}
                or not isinstance(metadata["sha256"], str)
                or len(metadata["sha256"]) != 64
                or not isinstance(metadata["size"], int)
                or metadata["size"] < 0
                or metadata["mode"] not in {"0644", "0755"}
            ):
                return None
            try:
                artifact = self.registry._artifact_target(Path(relative))
                if (
                    hashlib.sha256(artifact.read_bytes()).hexdigest()
                    != metadata["sha256"]
                    or artifact.stat().st_size != metadata["size"]
                    or artifact.stat().st_mode & 0o777
                    != int(metadata["mode"], 8)
                ):
                    return None
            except (OSError, ValueError):
                return None
        try:
            if target.read_bytes() != manifest_bytes:
                return None
            verify_closed_release_inventory(
                self.artifact_root,
                artifacts,
                expected_snapshot=inventory_snapshot,
            )
        except (OSError, ReleaseError):
            return None
        return raw

    def _installed(
        self,
        runtime_id: str,
        manifest: Mapping[str, Any],
        receipt: Mapping[str, Any] | None,
    ) -> dict[str, str]:
        if receipt is None:
            return self._status(
                "red",
                "release_receipt",
                "audit_receipt_invalid",
            )
        receipt_artifacts = receipt["artifacts"]
        for artifact in manifest["artifacts"]:
            relative = artifact["path"]
            metadata = receipt_artifacts.get(relative)
            if not isinstance(metadata, Mapping):
                return self._status(
                    "red",
                    "release_receipt",
                    "capability_unsupported",
                )
            if (
                metadata.get("sha256") != artifact["sha256"]
                or metadata.get("mode") != artifact["mode"]
            ):
                return self._status(
                    "red",
                    "release_receipt",
                    "audit_evidence_stale",
                )
            try:
                target = self.registry._artifact_target(Path(relative))
            except ValueError:
                return self._status(
                    "red",
                    "artifact",
                    "capability_unsupported",
                )
            if (
                hashlib.sha256(target.read_bytes()).hexdigest()
                != artifact["sha256"]
                or target.stat().st_mode & 0o777
                != int(artifact["mode"], 8)
            ):
                return self._status(
                    "red",
                    "artifact",
                    "audit_evidence_stale",
                )

        registered = self.registry.source_path(runtime_id)
        installed_relative = Path("manifests") / registered.name
        metadata = receipt_artifacts.get(installed_relative.as_posix())
        if not isinstance(metadata, Mapping):
            return self._status(
                "red",
                "runtime_registry",
                "capability_unsupported",
            )
        try:
            installed_manifest = self.registry._artifact_target(
                installed_relative
            )
        except ValueError:
            return self._status(
                "red",
                "runtime_registry",
                "capability_unsupported",
            )
        registered_hash = hashlib.sha256(registered.read_bytes()).hexdigest()
        installed_hash = hashlib.sha256(installed_manifest.read_bytes()).hexdigest()
        if (
            registered_hash != installed_hash
            or metadata.get("sha256") != installed_hash
        ):
            return self._status(
                "red",
                "runtime_registry",
                "audit_evidence_stale",
            )
        return self._status(
            "green",
            "release_receipt",
            "capability_artifact_verified",
        )

    def _probe_capability(
        self,
        *,
        runtime_id: str,
        runtime_version: str | None,
        adapter_version: str,
        capability: str,
        level: str,
    ) -> dict[str, str]:
        if runtime_version is None:
            return self._status(
                "red",
                "native_probe",
                "capability_runtime_version_unknown",
            )
        probe = (
            None
            if self.store is None
            else self.store.latest_probe(
                runtime_id=runtime_id,
                adapter_version=adapter_version,
                capability=capability,
                level=level,
            )
        )
        if probe is None:
            return self._status(
                "red",
                "native_probe",
                "capability_probe_missing",
            )
        if probe["runtime_version"] != runtime_version:
            return self._status(
                "red",
                "native_probe",
                "audit_evidence_stale",
            )
        if probe["result"] != "passed":
            return self._status(
                "red",
                "native_probe",
                "capability_unsupported",
            )
        if bool(probe["fixture"]):
            return self._status(
                "yellow",
                "fixture",
                "capability_fallback",
            )
        if self.probe_verifier is None:
            return self._status(
                "red",
                "native_probe",
                "capability_probe_missing",
            )
        try:
            trusted = bool(self.probe_verifier(probe))
        except Exception:
            trusted = False
        if not trusted:
            return self._status(
                "red",
                "native_probe",
                "capability_unsupported",
            )
        try:
            stale = parse_time(probe["observed_at"]) <= (
                datetime.now(timezone.utc) - timedelta(hours=24)
            )
        except (TypeError, ValueError):
            return self._status(
                "red",
                "native_probe",
                "audit_evidence_stale",
            )
        if stale:
            return self._status(
                "yellow",
                "native_probe",
                "audit_evidence_stale",
            )
        return self._status(
            "green",
            "native_probe",
            "capability_probe_current",
        )

    def _level(
        self,
        source: str,
        *,
        installed: bool,
        runtime_id: str,
        runtime_version: str | None,
        adapter_version: str,
        level: str,
    ) -> dict[str, Any]:
        if not installed:
            return self._status(
                "red",
                source,
                "capability_unsupported",
            )
        if source == "native_probe":
            capabilities = {
                capability: self._probe_capability(
                    runtime_id=runtime_id,
                    runtime_version=runtime_version,
                    adapter_version=adapter_version,
                    capability=capability,
                    level=level,
                )
                for capability in _CORE_CAPABILITIES
            }
            status = max(
                (item["status"] for item in capabilities.values()),
                key=_RANK.get,
            )
            worst = next(
                item
                for item in capabilities.values()
                if item["status"] == status
            )
            return {
                "status": status,
                "source": source,
                "reason_code": worst["reason_code"],
                "capabilities": capabilities,
            }
        if source in {"fixture", "manual", "fallback"}:
            return self._status(
                "yellow",
                source,
                "capability_fallback",
            )
        return self._status(
            "red",
            source,
            "capability_unsupported",
        )

    def inspect(
        self,
        *,
        runtime_versions: Mapping[str, str],
    ) -> dict[str, Any]:
        try:
            manifests = self.registry.load(verify_artifacts=False)
        except ValueError:
            return {
                "overall": "red",
                "reason_code": "contract_field_invalid",
                "runtimes": {},
            }
        if not manifests:
            return {
                "overall": "red",
                "reason_code": "capability_unsupported",
                "runtimes": {},
            }
        receipt = self._release_receipt()
        runtimes: dict[str, Any] = {}
        overall = "green"
        for runtime_id, manifest in manifests.items():
            version = runtime_versions.get(runtime_id)
            installed = self._installed(runtime_id, manifest, receipt)
            installed_green = installed["status"] == "green"
            levels = {
                name: self._level(
                    manifest["verification"][name],
                    installed=installed_green,
                    runtime_id=runtime_id,
                    runtime_version=version,
                    adapter_version=manifest["adapter_version"],
                    level=name,
                )
                for name in ("discover", "invoke", "effective")
            }
            discovered = levels["discover"]
            invoked = levels["invoke"]
            effective = levels["effective"]
            if not version:
                for level_status in (discovered, invoked, effective):
                    level_status.update(
                        status="red",
                        reason_code="capability_runtime_version_unknown",
                    )
            runtime_status = max(
                (
                    installed["status"],
                    discovered["status"],
                    invoked["status"],
                    effective["status"],
                ),
                key=_RANK.get,
            )
            version_hash = hashlib.sha256(
                (version or "").encode("utf-8")
            ).hexdigest()
            runtimes[runtime_id] = {
                "status": runtime_status,
                "runtime_version_hash": version_hash,
                "runtime_version_source": "claimed" if version else "missing",
                "adapter_version": manifest["adapter_version"],
                "capabilities": manifest["capabilities"],
                "installed": installed,
                "discovered": discovered,
                "invoked": invoked,
                "effective": effective,
            }
            if _RANK[runtime_status] > _RANK[overall]:
                overall = runtime_status
        return {
            "overall": overall,
            "reason_code": "capability_health_report",
            "runtimes": runtimes,
        }
