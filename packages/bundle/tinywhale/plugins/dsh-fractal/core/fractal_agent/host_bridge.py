"""Thin native-host bridge for the shared fractal action contract."""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Protocol

from .actions import ActionService
from .contract import ACTION_CONTRACT_VERSION, AdapterError
from .registry import ManifestRegistry
from .state import StateStore
from .util import sha256_text

_CORE_CAPABILITIES = ("constraints", "change_detection", "closeout")
_CLAUDE_EVENTS = {
    "sessionstart": "SessionStart",
    "pretooluse": "PreToolUse",
    "posttooluse": "PostToolUse",
    "posttoolusefailure": "PostToolUseFailure",
    "afterfileedit": "PostToolUse",
    "stop": "Stop",
    "sessionend": "SessionEnd",
    "agentsettled": "Stop",
}
_GROK_EVENTS = {
    "sessionstart": "session_start",
    "pretooluse": "pre_tool_use",
    "posttooluse": "post_tool_use",
    "posttoolusefailure": "post_tool_use_failure",
    "stop": "stop",
    "sessionend": "session_end",
}
_PI_EVENTS = {
    "sessionstart": "SessionStart",
    "toolcall": "PreToolUse",
    "toolresult": "PostToolUse",
    "agentsettled": "Stop",
}


class CompatibilityRunner(Protocol):
    def run(self, event: str, payload: dict[str, object]) -> dict[str, object]:
        ...


class LegacyHookRunner:
    """Run the existing global fractal hooks without exposing their payload."""

    def __init__(self, hook_root: Path | None = None) -> None:
        self.hook_root = (
            Path("~/.claude/hooks").expanduser()
            if hook_root is None
            else hook_root.expanduser()
        )

    def run(self, event: str, payload: dict[str, object]) -> dict[str, object]:
        script_name = {
            "PreToolUse": "fractal-inject.sh",
            "PostToolUse": "post-edit.sh",
        }.get(event)
        if script_name is None:
            return {}
        script = self.hook_root / script_name
        if script.is_symlink() or not script.is_file():
            return {}
        environment = {
            key: value
            for key, value in os.environ.items()
            if key
            in {
                "HOME",
                "PATH",
                "SHELL",
                "TMPDIR",
                "LANG",
                "LC_ALL",
                "FRACTAL_AUTO_LLM",
                "FRACTAL_AUTO_LLM_BACKEND",
                "FRACTAL_AUTO_LLM_DAILY_MAX",
                "FRACTAL_AUTO_LLM_DEBOUNCE_SEC",
                "FRACTAL_AUTO_LLM_TIMEOUT_SEC",
                "FRACTAL_AUTO_LLM_RUNNING",
            }
        }
        try:
            completed = subprocess.run(
                ["bash", str(script)],
                input=json.dumps(
                    payload,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=8,
                check=False,
                env=environment,
            )
        except (OSError, subprocess.TimeoutExpired):
            return {}
        if completed.returncode != 0 or not completed.stdout.strip():
            return {}
        if len(completed.stdout.encode("utf-8")) > 65_536:
            return {}
        try:
            value = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_event(event: str) -> str:
    compact = event.replace("_", "").replace("-", "").lower()
    return _CLAUDE_EVENTS.get(compact, event)


def _runtime_event(runtime_id: str, event: str) -> str:
    compact = event.replace("_", "").replace("-", "").lower()
    if runtime_id == "pi":
        return _PI_EVENTS.get(compact, _canonical_event(event))
    return _canonical_event(event)


def _session_value(runtime_id: str, payload: Mapping[str, Any]) -> str | None:
    candidates = (
        payload.get("session_id"),
        payload.get("sessionId"),
    )
    host = payload.get("host")
    if isinstance(host, Mapping):
        candidates += (
            host.get("session_id"),
            host.get("sessionId"),
        )
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _workspace_roots(payload: Mapping[str, Any]) -> tuple[str, ...]:
    values: list[str] = []
    workspace_roots = payload.get("workspace_roots")
    if isinstance(workspace_roots, list):
        for candidate in workspace_roots:
            if isinstance(candidate, str) and candidate and candidate not in values:
                values.append(candidate)
    return tuple(values)


def _contains_path(root: str, candidate: str) -> bool:
    try:
        root_path = Path(root).expanduser().resolve(strict=False)
        candidate_path = Path(candidate).expanduser()
        if not candidate_path.is_absolute():
            candidate_path = root_path / candidate_path
        return candidate_path.resolve(strict=False).is_relative_to(root_path)
    except (OSError, RuntimeError, ValueError):
        return False


def _cwd_value(
    payload: Mapping[str, Any],
    *,
    file: str | None = None,
) -> str | None:
    candidates = (payload.get("cwd"), *_workspace_roots(payload))
    host = payload.get("host")
    if isinstance(host, Mapping):
        candidates += (host.get("cwd"),)
    if file:
        matches = [
            candidate
            for candidate in candidates
            if isinstance(candidate, str)
            and candidate
            and _contains_path(candidate, file)
        ]
        if matches:
            return max(matches, key=lambda value: len(Path(value).parts))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _tool_input(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    for key in ("tool_input", "toolInput", "input"):
        candidate = payload.get(key)
        if isinstance(candidate, Mapping):
            return candidate
    return {}


def _tool_name(payload: Mapping[str, Any]) -> str:
    for key in ("tool_name", "toolName"):
        candidate = payload.get(key)
        if isinstance(candidate, str):
            return candidate
    return ""


def _file_value(payload: Mapping[str, Any]) -> str | None:
    direct = payload.get("file_path")
    if isinstance(direct, str) and direct:
        return direct
    value = _tool_input(payload)
    for key in ("file_path", "file", "path", "target_file"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _payload_matches_runtime(
    runtime_id: str,
    event: str,
    payload: Mapping[str, Any],
) -> bool:
    """Reject compatibility scanners replaying one vendor's hook as another."""
    def event_matches(candidate: object) -> bool:
        return (
            isinstance(candidate, str)
            and _runtime_event(runtime_id, candidate)
            == _runtime_event(runtime_id, event)
        )

    cursor_markers = (
        "cursor_version" in payload
        or "conversation_id" in payload
        or "workspace_roots" in payload
    )
    if runtime_id == "cursor":
        return cursor_markers and event_matches(
            payload.get("hook_event_name", payload.get("event"))
        )
    if cursor_markers:
        return False
    if runtime_id == "grok":
        hook_event = payload.get("hookEventName")
        native_event = os.environ.get("GROK_HOOK_EVENT")
        return (
            event_matches(hook_event)
            and (
                isinstance(payload.get("sessionId"), str)
                or (
                    event_matches(native_event)
                    and isinstance(os.environ.get("GROK_SESSION_ID"), str)
                    and isinstance(
                        os.environ.get("GROK_WORKSPACE_ROOT"),
                        str,
                    )
                )
            )
        )
    if runtime_id == "pi":
        host = payload.get("host")
        return event_matches(payload.get("type")) and isinstance(host, Mapping)
    if "hookEventName" in payload or "sessionId" in payload:
        return False
    return (
        event_matches(payload.get("hook_event_name"))
        and isinstance(payload.get("session_id"), str)
    )


def _to_claude_payload(
    event: str,
    payload: Mapping[str, Any],
) -> dict[str, object]:
    response = payload.get("tool_response")
    if not isinstance(response, Mapping):
        output = payload.get("tool_output")
        if isinstance(output, str):
            try:
                decoded = json.loads(output)
            except json.JSONDecodeError:
                decoded = None
            response = decoded if isinstance(decoded, Mapping) else {}
        elif isinstance(output, Mapping):
            response = output
        else:
            response = {}
    result: dict[str, object] = {
        "hook_event_name": event,
        "session_id": _session_value("", payload) or "",
        "cwd": _cwd_value(payload) or "",
        "tool_name": _tool_name(payload),
        "tool_input": dict(_tool_input(payload)),
        "tool_response": dict(response),
    }
    return result


def _context_from_output(value: Mapping[str, Any]) -> str:
    direct = value.get("additional_context")
    if isinstance(direct, str) and direct:
        return direct
    hook_specific = value.get("hookSpecificOutput")
    if isinstance(hook_specific, Mapping):
        context = hook_specific.get("additionalContext")
        if isinstance(context, str) and context:
            return context
    message = value.get("systemMessage")
    return message if isinstance(message, str) else ""


class HostBridge:
    def __init__(
        self,
        *,
        artifact_root: Path,
        manifest_dir: Path,
        state_root: Path,
        compatibility_runner: CompatibilityRunner | None = None,
    ) -> None:
        self.artifact_root = artifact_root.resolve(strict=True)
        self.registry = ManifestRegistry(
            artifact_root=self.artifact_root,
            manifest_dir=manifest_dir,
        )
        self.manifests = self.registry.load(verify_artifacts=False)
        self.service = ActionService(state_root=state_root)
        self.store = self.service.store
        self.compatibility_runner = compatibility_runner or LegacyHookRunner()

    @staticmethod
    def _envelope(
        *,
        runtime_id: str,
        adapter_version: str,
        session_id: str,
    ) -> dict[str, Any]:
        return {
            "contract_version": ACTION_CONTRACT_VERSION,
            "operation_id": f"bridge_{uuid.uuid4().hex}",
            "runtime_id": runtime_id,
            "adapter_version": adapter_version,
            "session_id": sha256_text(session_id),
            "occurred_at": _now(),
        }

    def _begin(
        self,
        *,
        runtime_id: str,
        adapter_version: str,
        session_id: str,
        cwd: str,
    ) -> tuple[str, str] | None:
        request = {
            **self._envelope(
                runtime_id=runtime_id,
                adapter_version=adapter_version,
                session_id=session_id,
            ),
            "cwd": cwd,
            "scope_mode": "native_session",
        }
        result = self.service.dispatch("begin_change_scope", request)
        scope_id = result.get("scope_id")
        hashed = request["session_id"]
        if not isinstance(scope_id, str) or not scope_id:
            return None
        return scope_id, hashed

    def _active_scope(
        self,
        *,
        runtime_id: str,
        session_id: str,
        cwd: str,
    ) -> tuple[str, str] | None:
        hashed = sha256_text(session_id)
        try:
            requested = Path(cwd).expanduser().resolve(strict=True)
        except OSError:
            return None
        for context in self.store.active_scope_contexts():
            if (
                context.get("runtime_id") != runtime_id
                or context.get("session_key") != hashed
            ):
                continue
            try:
                root = Path(str(context["root"])).resolve(strict=True)
            except (KeyError, OSError):
                continue
            if requested == root or requested.is_relative_to(root):
                scope_id = context.get("scope_id")
                if isinstance(scope_id, str) and scope_id:
                    return scope_id, hashed
        return None

    def _dispatch_normalized(
        self,
        *,
        runtime_id: str,
        adapter_version: str,
        session_id: str,
        cwd: str,
        normalized: list[dict[str, Any]],
        begin_if_missing: bool = True,
    ) -> tuple[list[dict[str, Any]], str | None]:
        begun = self._active_scope(
            runtime_id=runtime_id,
            session_id=session_id,
            cwd=cwd,
        )
        if begun is None and begin_if_missing:
            begun = self._begin(
                runtime_id=runtime_id,
                adapter_version=adapter_version,
                session_id=session_id,
                cwd=cwd,
            )
        if begun is None:
            return [], None
        scope_id, hashed_session = begun
        results: list[dict[str, Any]] = []
        for item in normalized:
            action = item.get("action")
            fields = item.get("fields")
            if not isinstance(action, str) or not isinstance(fields, Mapping):
                continue
            request = {
                **self._envelope(
                    runtime_id=runtime_id,
                    adapter_version=adapter_version,
                    session_id=session_id,
                ),
                **dict(fields),
            }
            request["session_id"] = hashed_session
            if "scope_id" in item.get("requires", []):
                request["scope_id"] = scope_id
            results.append(self.service.dispatch(action, request))
        return results, scope_id

    def _probe(
        self,
        *,
        runtime_id: str,
        runtime_version: str,
        adapter_version: str,
        capability: str,
        level: str,
    ) -> None:
        self.store.record_trusted_probe(
            runtime_id=runtime_id,
            runtime_version=runtime_version,
            adapter_version=adapter_version,
            capability=capability,
            level=level,
            result="passed",
        )

    @staticmethod
    def _render_context(runtime_id: str, event: str, context: str) -> dict[str, Any]:
        if not context:
            return {}
        if runtime_id == "cursor":
            if event == "Stop":
                return {"followup_message": context}
            return {"additional_context": context}
        if runtime_id == "pi":
            return {"additional_context": context}
        if event == "Stop":
            if runtime_id == "kimi":
                return {
                    "hookSpecificOutput": {
                        "permissionDecision": "deny",
                        "permissionDecisionReason": context,
                    }
                }
            return {"decision": "block", "reason": context}
        if event == "PreToolUse":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": context,
                }
            }
        return {"systemMessage": context}

    def _payload_for_adapter(
        self,
        runtime_id: str,
        event: str,
        payload: Mapping[str, Any],
        *,
        cwd: str,
    ) -> dict[str, Any]:
        value = dict(payload)
        if runtime_id == "grok":
            compact = event.replace("_", "").replace("-", "").lower()
            value.setdefault("hookEventName", _GROK_EVENTS.get(compact, event))
        elif runtime_id == "pi":
            value.setdefault(
                "type",
                "agent_settled" if event == "Stop" else event,
            )
        elif runtime_id == "cursor":
            value["_fractal_event"] = event
            value["cwd"] = cwd
            direct_file = value.get("file_path")
            if (
                event == "PostToolUse"
                and isinstance(direct_file, str)
                and direct_file
            ):
                value.setdefault("tool_name", "Write")
                value.setdefault("tool_input", {"file_path": direct_file})
        else:
            value.setdefault("hook_event_name", event)
        return value

    @staticmethod
    def _stop_suppressed(
        runtime_id: str,
        payload: Mapping[str, Any],
    ) -> bool:
        if payload.get("stop_hook_active") is True:
            return True
        if payload.get("stopHookActive") is True:
            return True
        if runtime_id != "cursor":
            return False
        loop_count = payload.get("loop_count")
        if (
            isinstance(loop_count, int)
            and not isinstance(loop_count, bool)
            and loop_count >= 1
        ):
            return True
        status = payload.get("status")
        return isinstance(status, str) and status not in {"", "completed"}

    @staticmethod
    def _safe_derived_writes(
        *,
        project_root: str,
        relative_paths: list[str],
    ) -> list[str]:
        try:
            root = Path(project_root).resolve(strict=True)
        except OSError:
            return []

        def safe_candidate(path: Path) -> bool:
            try:
                metadata = path.lstat()
            except OSError:
                return False
            return stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1

        candidates: set[Path] = set()
        for relative in relative_paths:
            target = (root / relative).resolve(strict=False)
            if not target.is_relative_to(root):
                continue
            directory = target.parent
            while directory.is_relative_to(root):
                candidate = directory / ".folder.md"
                if safe_candidate(candidate):
                    candidates.add(candidate)
                if directory == root:
                    break
                directory = directory.parent
        readme = root / "README.md"
        if safe_candidate(readme):
            candidates.add(readme)

        if len(candidates) > 64:
            return []
        audit_inputs = set(relative_paths)
        candidate_paths: list[str] = []
        for candidate in sorted(candidates):
            try:
                relative = candidate.relative_to(root).as_posix()
            except (OSError, ValueError):
                continue
            if candidate.name not in {".folder.md", "README.md"}:
                continue
            if relative in audit_inputs:
                continue
            candidate_paths.append(relative)
        if not candidate_paths:
            return []
        try:
            tracked = subprocess.run(
                ["git", "ls-files", "-z", "--", *candidate_paths],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
            )
            status = subprocess.run(
                [
                    "git",
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                    "--",
                    *candidate_paths,
                ],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        tracked_paths = {
            os.fsdecode(item)
            for item in tracked.stdout.split(b"\0")
            if item
        }
        if (
            tracked.returncode != 0
            or status.returncode != 0
            or status.stdout
            or tracked_paths != set(candidate_paths)
        ):
            return []
        return candidate_paths

    @staticmethod
    def _terminal_outcome(
        runtime_id: str,
        payload: Mapping[str, Any],
    ) -> str:
        if runtime_id != "cursor":
            return "completed"
        status = payload.get("status")
        if status in {"error", "failed"}:
            return "failed"
        if status in {"aborted", "cancelled"}:
            return "cancelled"
        return "completed"

    @staticmethod
    def _closeout_message(
        *,
        project_root: str,
        result: Mapping[str, Any],
    ) -> str:
        files = result.get("changed_files")
        changed_set_id = result.get("changed_set_id")
        closeout_request_id = result.get("closeout_request_id")
        if (
            not isinstance(files, list)
            or not isinstance(changed_set_id, str)
            or not changed_set_id
            or not isinstance(closeout_request_id, str)
            or not closeout_request_id
        ):
            return ""
        relative_paths = [
            item["path"]
            for item in files
            if isinstance(item, Mapping)
            and isinstance(item.get("path"), str)
            and item["path"]
        ]
        if not relative_paths:
            return ""
        encoded_paths = json.dumps(
            relative_paths,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        derived_writes = HostBridge._safe_derived_writes(
            project_root=project_root,
            relative_paths=relative_paths,
        )
        document_candidates = result.get("document_candidates")
        if isinstance(document_candidates, list):
            derived_writes = sorted(
                set(derived_writes).union(
                    item["file_path"]
                    for item in document_candidates
                    if isinstance(item, Mapping)
                    and isinstance(item.get("file_path"), str)
                    and item["file_path"]
                )
            )
        graph = result.get("graph")
        graph_targets = (
            graph.get("targets")
            if isinstance(graph, Mapping)
            and isinstance(graph.get("targets"), list)
            else []
        )
        if graph_targets:
            derived_writes = [
                item for item in derived_writes if item in set(graph_targets)
            ]
        encoded_derived_writes = json.dumps(
            derived_writes,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        graph_context = ""
        if isinstance(graph, Mapping):
            scoped_graph = graph.get("graph")
            graph_context = (
                "\n图谱裁决："
                + json.dumps(
                    {
                        "reason": graph.get("reason"),
                        "targets": graph_targets,
                        "structural_changes": (
                            scoped_graph.get("structural_changes", [])
                            if isinstance(scoped_graph, Mapping)
                            else []
                        ),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
        return (
            "检测到本次会话有待同步的分形文档，请由 LLM 自动完成定向分形自述。"
            f"\n项目根：{project_root}"
            f"\nchanged_set_id：{changed_set_id}"
            f"\ncloseout_request_id：{closeout_request_id}"
            f"\n状态机确认的只读审计输入路径：{encoded_paths}"
            f"\n状态机确认的派生文档写入白名单（唯一可写）：{encoded_derived_writes}"
            f"{graph_context}"
            "\n只以审计输入路径作为只读技术审计对象；不得修改其中的源码或"
            "文件头注释。唯一允许写入的是派生文档白名单，并且只能用于分形"
            "文档同步。"
            "\n禁止创建或写入清单外文件，禁止使用 git diff、git status 或"
            "其他全仓扫描扩大范围，禁止处理既有未提交改动或并发 unowned 变更。"
            "\n请自动完成技术审计与必要的分形文档同步，不要要求用户阅读审计报告。"
            "派生文档不得用通用写文件工具直接修改；对每个需要更新或确认无需变化"
            "的候选，调用 ~/.local/bin/fractal-capability update_fractal_document，"
            "stdin JSON 只传 closeout_request_id、file_path 和完整 content。"
            "所有候选均返回 updated 或 no_change 并验证后，再将"
            " closeout_request_id 作为 JSON 字段传给"
            " ~/.local/bin/fractal-capability complete_closeout；只有返回"
            " acknowledged 才算本次分形收尾完成。"
        )

    def handle(
        self,
        *,
        runtime_id: str,
        runtime_version: str,
        event: str,
        payload: Mapping[str, Any],
        compatibility: bool,
    ) -> dict[str, Any]:
        manifest = self.manifests.get(runtime_id)
        if (
            manifest is None
            or not isinstance(payload, Mapping)
            or not _payload_matches_runtime(runtime_id, event, payload)
        ):
            return {}
        adapter_version = str(manifest["adapter_version"])
        canonical_event = _runtime_event(runtime_id, event)
        suppress_stop = canonical_event == "Stop" and self._stop_suppressed(
            runtime_id,
            payload,
        )
        if runtime_id == "cursor" and canonical_event in {"SessionStart", "Stop"}:
            roots = _workspace_roots(payload)
            if len(roots) > 1:
                messages: list[str] = []
                for root in roots:
                    scoped_payload = dict(payload)
                    scoped_payload["cwd"] = root
                    scoped_payload["workspace_roots"] = [root]
                    response = self.handle(
                        runtime_id=runtime_id,
                        runtime_version=runtime_version,
                        event=event,
                        payload=scoped_payload,
                        compatibility=compatibility,
                    )
                    message = response.get("followup_message")
                    if isinstance(message, str) and message:
                        messages.append(message)
                if messages:
                    return {"followup_message": "\n\n".join(messages)}
                return {}
        session_id = _session_value(runtime_id, payload)
        cwd = _cwd_value(payload, file=_file_value(payload))
        if runtime_id == "grok":
            session_id = session_id or os.environ.get("GROK_SESSION_ID")
            cwd = cwd or os.environ.get("GROK_WORKSPACE_ROOT")
        if not session_id or not cwd:
            return {}
        try:
            adapter_payload = self._payload_for_adapter(
                runtime_id,
                canonical_event,
                payload,
                cwd=cwd,
            )
            if canonical_event == "SessionStart":
                if self._begin(
                    runtime_id=runtime_id,
                    adapter_version=adapter_version,
                    session_id=session_id,
                    cwd=cwd,
                ) is None:
                    return {}
                for capability in _CORE_CAPABILITIES:
                    self._probe(
                        runtime_id=runtime_id,
                        runtime_version=runtime_version,
                        adapter_version=adapter_version,
                        capability=capability,
                        level="discover",
                    )
                return {}

            if canonical_event == "PreToolUse":
                file = _file_value(payload)
                context = ""
                effective = False
                if file:
                    begun = self._begin(
                        runtime_id=runtime_id,
                        adapter_version=adapter_version,
                        session_id=session_id,
                        cwd=cwd,
                    )
                    if begun is not None:
                        scope_id, hashed_session = begun
                        request = {
                            **self._envelope(
                                runtime_id=runtime_id,
                                adapter_version=adapter_version,
                                session_id=session_id,
                            ),
                            "session_id": hashed_session,
                            "cwd": cwd,
                            "file": file,
                            "scope_id": scope_id,
                        }
                        resolved = self.service.dispatch(
                            "resolve_constraints",
                            request,
                        )
                        candidate = resolved.get("constraints")
                        if isinstance(candidate, str) and candidate:
                            context = candidate
                            effective = True
                if compatibility:
                    legacy = self.compatibility_runner.run(
                        "PreToolUse",
                        _to_claude_payload("PreToolUse", payload),
                    )
                    context = _context_from_output(legacy) or context
                    effective = effective or bool(context)
                self._probe(
                    runtime_id=runtime_id,
                    runtime_version=runtime_version,
                    adapter_version=adapter_version,
                    capability="constraints",
                    level="invoke",
                )
                if effective:
                    self._probe(
                        runtime_id=runtime_id,
                        runtime_version=runtime_version,
                        adapter_version=adapter_version,
                        capability="constraints",
                        level="effective",
                    )
                return self._render_context(
                    runtime_id,
                    canonical_event,
                    context,
                )

            adapter = self.registry.adapter(runtime_id)
            normalized = adapter(adapter_payload)
            results, scope_id = self._dispatch_normalized(
                runtime_id=runtime_id,
                adapter_version=adapter_version,
                session_id=session_id,
                cwd=cwd,
                normalized=normalized,
                begin_if_missing=canonical_event
                not in {"Stop", "SessionEnd"},
            )
            if canonical_event in {"PostToolUse", "PostToolUseFailure"}:
                if compatibility:
                    legacy = self.compatibility_runner.run(
                        "PostToolUse",
                        _to_claude_payload("PostToolUse", payload),
                    )
                else:
                    legacy = {}
                self._probe(
                    runtime_id=runtime_id,
                    runtime_version=runtime_version,
                    adapter_version=adapter_version,
                    capability="change_detection",
                    level="invoke",
                )
                if any(
                    result.get("status")
                    in {"recorded", "duplicate", "no_change"}
                    for result in results
                ):
                    self._probe(
                        runtime_id=runtime_id,
                        runtime_version=runtime_version,
                        adapter_version=adapter_version,
                        capability="change_detection",
                        level="effective",
                    )
                return self._render_context(
                    runtime_id,
                    canonical_event,
                    _context_from_output(legacy),
                )

            if canonical_event in {"Stop", "SessionEnd"}:
                self._probe(
                    runtime_id=runtime_id,
                    runtime_version=runtime_version,
                    adapter_version=adapter_version,
                    capability="closeout",
                    level="invoke",
                )
                valid = any(
                    result.get("status")
                    in {
                        "clean",
                        "needs_closeout",
                        "already_reminded",
                        "graph_reconciled",
                        "duplicate",
                        "needs_unowned_audit",
                    }
                    for result in results
                )
                if valid:
                    self._probe(
                        runtime_id=runtime_id,
                        runtime_version=runtime_version,
                        adapter_version=adapter_version,
                        capability="closeout",
                        level="effective",
                    )
                if scope_id:
                    end_request = {
                        **self._envelope(
                            runtime_id=runtime_id,
                            adapter_version=adapter_version,
                            session_id=session_id,
                        ),
                        "scope_id": scope_id,
                        "terminal_outcome": self._terminal_outcome(
                            runtime_id,
                            payload,
                        ),
                    }
                    self.service.dispatch("end_change_scope", end_request)
                messages = [
                    self._closeout_message(project_root=cwd, result=result)
                    for result in results
                    if result.get("status") == "needs_closeout"
                ]
                messages = [message for message in messages if message]
                if valid and messages and not suppress_stop:
                    return self._render_context(
                        runtime_id,
                        canonical_event,
                        "\n\n".join(messages),
                    )
                return {}
        except (AdapterError, KeyError, OSError, ValueError):
            return {}
        return {}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fractal-hook")
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--runtime-version", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--compatibility", action="store_true")
    parser.add_argument(
        "--state-root",
        default="~/.local/state/fractal-agent/v1",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    expected_owner = f"ai.fractal.{args.runtime}.v1"
    if args.owner != expected_owner:
        sys.stdout.write("{}\n")
        return 0
    try:
        raw = sys.stdin.buffer.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ValueError("oversize")
        payload = json.loads(raw.decode("utf-8", errors="strict"))
        if not isinstance(payload, dict):
            raise ValueError("not object")
        root = Path(__file__).resolve().parents[1]
        result = HostBridge(
            artifact_root=root,
            manifest_dir=root / "manifests",
            state_root=Path(args.state_root).expanduser(),
        ).handle(
            runtime_id=args.runtime,
            runtime_version=args.runtime_version,
            event=args.event,
            payload=payload,
            compatibility=bool(args.compatibility),
        )
    except (json.JSONDecodeError, UnicodeDecodeError, OSError, ValueError):
        result = {}
    sys.stdout.write(
        json.dumps(
            result,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
