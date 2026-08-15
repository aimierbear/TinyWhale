"""Declarative, owner-scoped activation for native agent hook surfaces."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import stat
import tomllib
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable, Mapping

from .config_merge import ConfigMergeError, write_transformed_text

_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
_KINDS = {
    "claude_hooks",
    "cursor_hooks",
    "kimi_toml",
    "owned_claude_hooks",
    "pi_extension",
}
_SPEC_FIELDS = {
    "schema_version",
    "runtime_id",
    "kind",
    "target",
    "owner_id",
    "events",
    "retire_commands",
}
_EVENT_FIELDS = {
    "name",
    "matcher",
    "timeout",
    "compatibility",
    "loop_limit",
}


class ActivationError(RuntimeError):
    pass


def install_neutral_links(
    *,
    artifact_root: Path,
    home: Path,
    dry_run: bool,
) -> dict[str, Any]:
    """Install only owned stable entry links and the shared rules pointer."""
    root = artifact_root.resolve(strict=True)
    resolved_home = home.resolve(strict=True)
    if root.parent.name == "releases":
        install_root = root.parent.parent
        binary_root = install_root / "current" / "bin"
    else:
        binary_root = root / "bin"
    links = {
        resolved_home / ".local/bin/fractal-action": binary_root / "fractal-action",
        resolved_home
        / ".local/bin/fractal-capability": binary_root / "fractal-capability",
        resolved_home / ".local/bin/fractal-activate": binary_root / "fractal-activate",
        resolved_home / ".local/bin/fractal-hook": binary_root / "fractal-hook",
        resolved_home / ".local/bin/fractal-manage": binary_root / "fractal-manage",
        resolved_home
        / ".config/fractal-agent/rules/current": resolved_home / ".claude/docs",
    }
    report: dict[str, Any] = {}
    for target, destination in links.items():
        if not destination.exists():
            raise ActivationError("neutral link destination is missing")
        changed = True
        if target.is_symlink():
            try:
                current = (target.parent / os.readlink(target)).resolve(strict=False)
            except OSError as exc:
                raise ActivationError("neutral link cannot be inspected") from exc
            changed = current != destination.resolve(strict=False)
            if changed:
                current_text = str(current)
                allowed = (
                    "/fractal-agent/" in current_text
                    if target.name.startswith("fractal-")
                    else current == resolved_home / ".claude/docs"
                )
                if not allowed:
                    raise ActivationError("foreign neutral link target refused")
        elif target.exists():
            raise ActivationError("foreign neutral link path refused")
        if changed and not dry_run:
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = target.with_name(f".{target.name}.fractal-new")
            if temporary.exists() or temporary.is_symlink():
                raise ActivationError("neutral link staging path is occupied")
            os.symlink(destination, temporary)
            os.replace(temporary, target)
        report[target.name] = {
            "changed": changed,
            "target_hash": _digest(str(target).encode("utf-8")),
        }
    return {"status": "dry_run" if dry_run else "installed", "links": report}


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ActivationError("activation document contains duplicate keys")
        value[key] = item
    return value


def _json_object(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}", object_pairs_hook=_strict_object)
    except json.JSONDecodeError as exc:
        raise ActivationError("activation target is invalid JSON") from exc
    if not isinstance(value, dict):
        raise ActivationError("activation JSON root must be an object")
    return value


def _owner_from_command(command: Any) -> str | None:
    if not isinstance(command, str) or not command:
        return None
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    for index, part in enumerate(parts[:-1]):
        if part == "--owner":
            return parts[index + 1]
    return None


def _handler_is_owned(handler: Any, owner_id: str) -> bool:
    return (
        isinstance(handler, Mapping)
        and _owner_from_command(handler.get("command")) == owner_id
    )


def _json_text(value: Mapping[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


_TOML_TABLE_HEADER = re.compile(
    r"^\s*\[\[?.+?\]?\]\s*(?:#.*)?$"
)
_TOML_HOOK_HEADER = re.compile(
    r"^\s*\[\[\s*hooks\s*\]\]\s*(?:#.*)?$"
)


def _retire_kimi_hook_sections(
    original: str,
    retire_commands: frozenset[str],
    *,
    owner_id: str | None = None,
) -> str:
    if not retire_commands and owner_id is None:
        return original
    lines = original.splitlines(keepends=True)
    headers = [
        index
        for index, line in enumerate(lines)
        if _TOML_TABLE_HEADER.fullmatch(line.rstrip("\r\n"))
    ]
    retired_lines: set[int] = set()
    for position, start in enumerate(headers):
        if not _TOML_HOOK_HEADER.fullmatch(lines[start].rstrip("\r\n")):
            continue
        end = headers[position + 1] if position + 1 < len(headers) else len(lines)
        section_end = end
        while section_end > start + 1:
            trailing = lines[section_end - 1].strip()
            if trailing and not trailing.startswith("#"):
                break
            section_end -= 1
        section = "".join(lines[start:section_end])
        try:
            parsed = tomllib.loads(section)
        except tomllib.TOMLDecodeError as exc:
            raise ActivationError("Kimi legacy hook section is invalid") from exc
        hooks = parsed.get("hooks")
        command = (
            hooks[0].get("command")
            if isinstance(hooks, list)
            and len(hooks) == 1
            and isinstance(hooks[0], Mapping)
            else None
        )
        if command in retire_commands or (
            owner_id is not None
            and _owner_from_command(command) == owner_id
        ):
            retired_lines.update(range(start, section_end))
    return "".join(
        line for index, line in enumerate(lines) if index not in retired_lines
    )


class ActivationInstaller:
    def __init__(
        self,
        *,
        artifact_root: Path,
        spec_dir: Path,
        home: Path,
        hook_command: Path,
        backup_root: Path,
    ) -> None:
        self.artifact_root = artifact_root.resolve(strict=True)
        self.spec_dir = spec_dir.resolve(strict=True)
        self.home = home.resolve(strict=True)
        self.hook_command = hook_command
        self.backup_root = backup_root

    def _target(self, declared: str) -> Path:
        if not declared.startswith("~/"):
            raise ActivationError("activation target must be user-relative")
        target = Path(
            os.path.abspath(self.home / declared.removeprefix("~/"))
        )
        try:
            target.relative_to(self.home)
        except ValueError as exc:
            raise ActivationError("activation target escaped user root") from exc
        return target

    def load_specs(self) -> dict[str, dict[str, Any]]:
        specs: dict[str, dict[str, Any]] = {}
        for path in sorted(self.spec_dir.glob("*.json")):
            if path.is_symlink() or not path.is_file():
                raise ActivationError("activation spec is unsafe")
            try:
                raw = json.loads(
                    path.read_text(encoding="utf-8", errors="strict"),
                    object_pairs_hook=_strict_object,
                )
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise ActivationError("activation spec is invalid") from exc
            if not isinstance(raw, dict):
                raise ActivationError("activation spec root is invalid")
            allowed = set(_SPEC_FIELDS)
            if raw.get("kind") == "pi_extension":
                allowed.add("template")
            if set(raw) != allowed:
                raise ActivationError("activation spec fields are invalid")
            runtime_id = raw.get("runtime_id")
            owner_id = raw.get("owner_id")
            if (
                raw.get("schema_version") != 1
                or not isinstance(runtime_id, str)
                or not _ID_RE.fullmatch(runtime_id)
                or runtime_id in specs
                or raw.get("kind") not in _KINDS
                or owner_id != f"ai.fractal.{runtime_id}.v1"
                or not isinstance(raw.get("target"), str)
                or not isinstance(raw.get("events"), list)
                or not isinstance(raw.get("retire_commands"), list)
                or len(raw["retire_commands"]) > 32
                or any(
                    not isinstance(command, str)
                    or not command
                    or len(command) > 1024
                    for command in raw["retire_commands"]
                )
                or len(set(raw["retire_commands"]))
                != len(raw["retire_commands"])
            ):
                raise ActivationError("activation spec identity is invalid")
            self._target(raw["target"])
            for event in raw["events"]:
                if (
                    not isinstance(event, dict)
                    or not set(event).issubset(_EVENT_FIELDS)
                    or "name" not in event
                    or not isinstance(event["name"], str)
                    or not event["name"]
                    or (
                        "matcher" in event
                        and not isinstance(event["matcher"], str)
                    )
                    or (
                        "timeout" in event
                        and (
                            not isinstance(event["timeout"], int)
                            or not 1 <= event["timeout"] <= 600
                        )
                    )
                    or (
                        "compatibility" in event
                        and not isinstance(event["compatibility"], bool)
                    )
                    or (
                        "loop_limit" in event
                        and (
                            not isinstance(event["loop_limit"], int)
                            or not 1 <= event["loop_limit"] <= 100
                        )
                    )
                ):
                    raise ActivationError("activation event is invalid")
            if raw["kind"] == "pi_extension":
                template = raw.get("template")
                if not isinstance(template, str) or not template:
                    raise ActivationError("Pi activation template is missing")
                candidate = Path(template)
                if candidate.is_absolute() or ".." in candidate.parts:
                    raise ActivationError("Pi activation template escaped release")
                template_path = self.artifact_root / candidate
                if template_path.is_symlink() or not template_path.is_file():
                    raise ActivationError("Pi activation template is unsafe")
            specs[runtime_id] = raw
        if not specs:
            raise ActivationError("activation catalog is empty")
        return specs

    def _command(
        self,
        *,
        runtime_id: str,
        runtime_version: str,
        owner_id: str,
        event: Mapping[str, Any],
    ) -> str:
        parts = [
            str(self.hook_command),
            "--runtime",
            runtime_id,
            "--runtime-version",
            runtime_version,
            "--event",
            str(event["name"]),
            "--owner",
            owner_id,
        ]
        if event.get("compatibility") is True:
            parts.append("--compatibility")
        return shlex.join(parts)

    def _nested_hook_document(
        self,
        original: str,
        *,
        spec: Mapping[str, Any],
        runtime_version: str,
        owned_file: bool,
    ) -> str:
        owner_id = str(spec["owner_id"])
        retire_commands = frozenset(spec["retire_commands"])
        document = _json_object(original)
        hooks = document.get("hooks", {})
        if not isinstance(hooks, dict):
            raise ActivationError("activation hooks node is not an object")
        if owned_file and hooks:
            for groups in hooks.values():
                if not isinstance(groups, list):
                    raise ActivationError("owned hook file is malformed")
                for group in groups:
                    if not isinstance(group, Mapping):
                        raise ActivationError("owned hook group is malformed")
                    handlers = group.get("hooks", [])
                    if not isinstance(handlers, list) or any(
                        not _handler_is_owned(handler, owner_id)
                        for handler in handlers
                    ):
                        raise ActivationError("foreign node in owned hook file")

        updated = deepcopy(document)
        updated_hooks: dict[str, Any] = deepcopy(hooks)
        for event_name, groups in list(updated_hooks.items()):
            if not isinstance(groups, list):
                raise ActivationError("activation event hooks are malformed")
            retained: list[Any] = []
            for group in groups:
                if not isinstance(group, dict):
                    raise ActivationError("activation hook group is malformed")
                handlers = group.get("hooks")
                if not isinstance(handlers, list):
                    retained.append(group)
                    continue
                remaining = [
                    handler
                    for handler in handlers
                    if (
                        not _handler_is_owned(handler, owner_id)
                        and (
                            not isinstance(handler, Mapping)
                            or handler.get("command") not in retire_commands
                        )
                    )
                ]
                if remaining:
                    candidate = deepcopy(group)
                    candidate["hooks"] = remaining
                    retained.append(candidate)
                elif not handlers:
                    retained.append(group)
            updated_hooks[event_name] = retained
        for event in spec["events"]:
            handler = {
                "type": "command",
                "command": self._command(
                    runtime_id=str(spec["runtime_id"]),
                    runtime_version=runtime_version,
                    owner_id=owner_id,
                    event=event,
                ),
                "timeout": int(event.get("timeout", 10)),
            }
            group: dict[str, Any] = {"hooks": [handler]}
            if event.get("matcher"):
                group["matcher"] = event["matcher"]
            updated_hooks.setdefault(str(event["name"]), []).append(group)
        updated["hooks"] = updated_hooks
        return _json_text(updated)

    def _cursor_document(
        self,
        original: str,
        *,
        spec: Mapping[str, Any],
        runtime_version: str,
    ) -> str:
        owner_id = str(spec["owner_id"])
        retire_commands = frozenset(spec["retire_commands"])
        document = _json_object(original)
        updated = deepcopy(document)
        updated.setdefault("version", 1)
        if updated["version"] != 1:
            raise ActivationError("unsupported Cursor hook version")
        hooks = updated.get("hooks", {})
        if not isinstance(hooks, dict):
            raise ActivationError("Cursor hooks node is not an object")
        for event_name, handlers in list(hooks.items()):
            if not isinstance(handlers, list):
                raise ActivationError("Cursor hook event is malformed")
            hooks[event_name] = [
                handler
                for handler in handlers
                if (
                    not _handler_is_owned(handler, owner_id)
                    and (
                        not isinstance(handler, Mapping)
                        or handler.get("command") not in retire_commands
                    )
                )
            ]
        for event in spec["events"]:
            handler: dict[str, Any] = {
                "command": self._command(
                    runtime_id=str(spec["runtime_id"]),
                    runtime_version=runtime_version,
                    owner_id=owner_id,
                    event=event,
                ),
                "timeout": int(event.get("timeout", 10)),
            }
            if event.get("matcher"):
                handler["matcher"] = event["matcher"]
            if "loop_limit" in event:
                handler["loop_limit"] = int(event["loop_limit"])
            hooks.setdefault(str(event["name"]), []).append(handler)
        updated["hooks"] = hooks
        return _json_text(updated)

    def _kimi_document(
        self,
        original: str,
        *,
        spec: Mapping[str, Any],
        runtime_version: str,
    ) -> str:
        owner_id = str(spec["owner_id"])
        original = _retire_kimi_hook_sections(
            original,
            frozenset(spec["retire_commands"]),
            owner_id=owner_id,
        )
        begin = f"# BEGIN FRACTAL_AGENT {owner_id}"
        end = f"# END FRACTAL_AGENT {owner_id}"
        lines = original.splitlines(keepends=True)
        begin_pattern = re.compile(rf"^\s*{re.escape(begin)}\s*$")
        end_pattern = re.compile(rf"^\s*{re.escape(end)}\s*$")
        begin_lines = [
            index
            for index, line in enumerate(lines)
            if begin_pattern.fullmatch(line.rstrip("\r\n"))
        ]
        end_lines = [
            index
            for index, line in enumerate(lines)
            if end_pattern.fullmatch(line.rstrip("\r\n"))
        ]
        if (
            len(begin_lines) != len(end_lines)
            or len(begin_lines) > 1
            or (begin_lines and begin_lines[0] >= end_lines[0])
        ):
            raise ActivationError("Kimi owned block markers are invalid")
        blocks = [begin]
        for event in spec["events"]:
            blocks.extend(
                [
                    "[[hooks]]",
                    f"event = {json.dumps(event['name'])}",
                ]
            )
            if event.get("matcher"):
                blocks.append(f"matcher = {json.dumps(event['matcher'])}")
            command = self._command(
                runtime_id=str(spec["runtime_id"]),
                runtime_version=runtime_version,
                owner_id=owner_id,
                event=event,
            )
            blocks.extend(
                [
                    f"command = {json.dumps(command)}",
                    f"timeout = {int(event.get('timeout', 10))}",
                    "",
                ]
            )
        blocks.append(end)
        block = "\n".join(blocks)
        if begin_lines:
            start = begin_lines[0]
            finish = end_lines[0]
            marker_line = lines[finish]
            line_ending = (
                "\r\n"
                if marker_line.endswith("\r\n")
                else ("\n" if marker_line.endswith("\n") else "")
            )
            updated = (
                "".join(lines[:start])
                + block
                + line_ending
                + "".join(lines[finish + 1 :])
            )
        else:
            separator = "" if not original else ("\n" if original.endswith("\n") else "\n\n")
            updated = original + separator + block + "\n"
        try:
            tomllib.loads(updated)
        except tomllib.TOMLDecodeError as exc:
            raise ActivationError("Kimi activation produced invalid TOML") from exc
        return updated

    def _pi_document(
        self,
        original: str,
        *,
        spec: Mapping[str, Any],
        runtime_version: str,
    ) -> str:
        owner_id = str(spec["owner_id"])
        if original and f"FRACTAL_OWNER: {owner_id}" not in original:
            raise ActivationError("foreign Pi extension target refused")
        template = self.artifact_root / str(spec["template"])
        value = template.read_text(encoding="utf-8", errors="strict")
        replacements = {
            "__FRACTAL_OWNER__": owner_id,
            "__FRACTAL_HOOK_JSON__": json.dumps(str(self.hook_command)),
            "__FRACTAL_RUNTIME_VERSION_JSON__": json.dumps(runtime_version),
            "__FRACTAL_OWNER_JSON__": json.dumps(owner_id),
        }
        for marker, replacement in replacements.items():
            value = value.replace(marker, replacement)
        if "__FRACTAL_" in value:
            raise ActivationError("Pi activation template is incomplete")
        return value

    def _transform(
        self,
        spec: Mapping[str, Any],
        runtime_version: str,
    ) -> Callable[[str], str]:
        kind = spec["kind"]
        if kind == "claude_hooks":
            return lambda original: self._nested_hook_document(
                original,
                spec=spec,
                runtime_version=runtime_version,
                owned_file=False,
            )
        if kind == "owned_claude_hooks":
            return lambda original: self._nested_hook_document(
                original,
                spec=spec,
                runtime_version=runtime_version,
                owned_file=True,
            )
        if kind == "cursor_hooks":
            return lambda original: self._cursor_document(
                original,
                spec=spec,
                runtime_version=runtime_version,
            )
        if kind == "kimi_toml":
            return lambda original: self._kimi_document(
                original,
                spec=spec,
                runtime_version=runtime_version,
            )
        if kind == "pi_extension":
            return lambda original: self._pi_document(
                original,
                spec=spec,
                runtime_version=runtime_version,
            )
        raise ActivationError("unsupported activation kind")

    def _snapshot(self, target: Path) -> tuple[bytes, int]:
        if target.is_symlink():
            raise ActivationError("activation target symlink refused")
        if not target.exists():
            return b"", 0o600
        metadata = target.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ActivationError("activation target is not regular")
        return target.read_bytes(), stat.S_IMODE(metadata.st_mode)

    def _backup(
        self,
        *,
        runtime_id: str,
        target: Path,
        raw: bytes,
    ) -> None:
        if not raw:
            return
        relative = target.relative_to(self.home)
        backup = self.backup_root / runtime_id / relative
        if backup.exists() or backup.is_symlink():
            raise ActivationError("activation backup target already exists")
        backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(
            backup,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            os.write(descriptor, raw)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def install(
        self,
        runtime_versions: Mapping[str, str],
        *,
        runtime_ids: set[str] | None = None,
        dry_run: bool,
        quiescence_verifier: Callable[[str], bool] | None = None,
    ) -> dict[str, Any]:
        specs = self.load_specs()
        selected = set(specs) if runtime_ids is None else set(runtime_ids)
        if not selected.issubset(specs):
            raise ActivationError("unknown activation runtime")
        reports: dict[str, Any] = {}
        for runtime_id in sorted(selected):
            runtime_version = runtime_versions.get(runtime_id)
            if (
                not isinstance(runtime_version, str)
                or not _VERSION_RE.fullmatch(runtime_version)
            ):
                raise ActivationError("runtime version is missing or invalid")
            spec = specs[runtime_id]
            target = self._target(str(spec["target"]))
            raw, _mode = self._snapshot(target)
            expected_digest = _digest(raw)
            transform = self._transform(spec, runtime_version)
            preview = write_transformed_text(
                target,
                transform=transform,
                expected_digest=expected_digest,
                dry_run=True,
            )
            backup_created = False
            if not dry_run and preview["changed"]:
                if quiescence_verifier is None:
                    raise ActivationError("trusted activation verifier is required")
                self._backup(
                    runtime_id=runtime_id,
                    target=target,
                    raw=raw,
                )
                backup_created = bool(raw)
                try:
                    result = write_transformed_text(
                        target,
                        transform=transform,
                        expected_digest=expected_digest,
                        dry_run=False,
                        quiescence_verifier=lambda: quiescence_verifier(runtime_id),
                    )
                except ConfigMergeError as exc:
                    raise ActivationError("activation write was refused") from exc
            else:
                result = preview
            reports[runtime_id] = {
                **result,
                "backup_created": backup_created,
                "target_hash": _digest(str(target).encode("utf-8")),
            }
        return {
            "status": "dry_run" if dry_run else "installed",
            "runtimes": reports,
        }
