"""Safe management CLI: health, dry-run release, explicit local apply."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .activation import (
    ActivationError,
    ActivationInstaller,
    install_neutral_links,
)
from .doctor import HealthDoctor
from .release import ReleaseError, ReleaseManager, entrypoint_import_closure
from .state import StateStore

_LAYOUT_ROOTS = (
    "activation",
    "bin",
    "bridges",
    "contracts",
    "fixtures",
    "fractal_agent",
    "graph_scanner",
    "manifests",
)
_REQUIRED_RELEASE_ARTIFACTS = frozenset(
    {
        ".folder.md",
        "README.md",
        "bin/fractal-action",
        "bin/fractal-capability",
        "bin/fractal-activate",
        "bin/fractal-hook",
        "bin/fractal-manage",
        "activation/claude.json",
        "activation/codex.json",
        "activation/cursor.json",
        "activation/grok.json",
        "activation/kimi.json",
        "activation/pi.json",
        "bridges/pi/fractal-agent.ts",
        "contracts/action-v1.schema.json",
        "contracts/audit-output-v1.schema.json",
        "contracts/manifest-v1.schema.json",
        "contracts/reason-codes-v1.json",
        "fractal_agent/__init__.py",
        "fractal_agent/activation.py",
        "fractal_agent/capability_cli.py",
        "fractal_agent/cli.py",
        "fractal_agent/config_merge.py",
        "fractal_agent/contract.py",
        "fractal_agent/management.py",
        "fractal_agent/release.py",
        "graph_scanner/index.js",
        "graph_scanner/package-lock.json",
        "graph_scanner/package.json",
        "manifests/claude.json",
        "manifests/codex.json",
        "manifests/cursor.json",
        "manifests/grok.json",
        "manifests/kimi.json",
        "manifests/pi.json",
    }
)


def _root() -> Path:
    return Path(__file__).resolve().parents[1]


def _artifacts(root: Path) -> tuple[str, ...]:
    values: list[str] = []
    for relative_root in _LAYOUT_ROOTS:
        layout_root = root / relative_root
        if layout_root.is_symlink() or not layout_root.is_dir():
            raise ReleaseError("release source layout is incomplete or unsafe")
        for path in layout_root.rglob("*"):
            if path.is_symlink():
                raise ReleaseError("release source layout symlink refused")
            if (
                path.is_file()
                and "__pycache__" not in path.parts
                and path.suffix != ".pyc"
            ):
                values.append(path.relative_to(root).as_posix())
    for name in (".folder.md", "README.md"):
        path = root / name
        if path.is_file() and not path.is_symlink():
            values.append(name)
    result = tuple(sorted(values))
    missing = _REQUIRED_RELEASE_ARTIFACTS - set(result)
    if missing:
        raise ReleaseError("release source layout is incomplete or unsafe")
    closure = set(entrypoint_import_closure(root))
    if not closure.issubset(result):
        raise ReleaseError("entrypoint import closure is incomplete")
    return result


def _emit(value: dict[str, Any]) -> None:
    sys.stdout.write(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    )


def _versions(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        runtime, separator, version = value.partition("=")
        if not separator or not runtime or not version:
            raise ValueError("runtime version must be runtime=version")
        result[runtime] = version
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fractal-manage")
    commands = parser.add_subparsers(dest="command", required=True)
    doctor = commands.add_parser("doctor")
    doctor.add_argument(
        "--runtime-version",
        action="append",
        default=[],
        metavar="ID=VERSION",
    )
    doctor.add_argument(
        "--state-root",
        default="~/.local/state/fractal-agent/v1",
    )
    release = commands.add_parser("release")
    release.add_argument("--version", required=True)
    release.add_argument(
        "--install-root",
        default="~/.local/share/fractal-agent",
    )
    release.add_argument("--apply", action="store_true")
    release.add_argument("--runtime-stopped", action="store_true")
    rollback = commands.add_parser("rollback")
    rollback.add_argument(
        "--install-root",
        default="~/.local/share/fractal-agent",
    )
    rollback.add_argument("--apply", action="store_true")
    rollback.add_argument("--runtime-stopped", action="store_true")
    activate = commands.add_parser("activate")
    activate.add_argument(
        "--runtime-version",
        action="append",
        default=[],
        metavar="ID=VERSION",
    )
    activate.add_argument(
        "--runtime",
        action="append",
        default=[],
        metavar="ID",
    )
    activate.add_argument("--home", default="~")
    activate.add_argument(
        "--hook-command",
        default="~/.local/bin/fractal-hook",
    )
    activate.add_argument("--backup-root")
    activate.add_argument("--apply", action="store_true")
    activate.add_argument("--reload-deferred", action="store_true")
    return parser


def _trusted_quiescence(
    *,
    runtime_stopped: bool,
    verifier: Callable[[], bool] | None,
) -> bool:
    if not runtime_stopped or verifier is None:
        return False
    try:
        return verifier() is True
    except Exception:
        return False


def _refuse_unverified_quiescence() -> int:
    _emit(
        {
            "status": "refused",
            "reason_code": "config_concurrent_change",
            "retryable": True,
        }
    )
    return 64


def main(
    argv: list[str] | None = None,
    *,
    quiescence_verifier: Callable[[], bool] | None = None,
) -> int:
    try:
        args = _parser().parse_args(argv)
        root = _root()
        if args.command == "doctor":
            state_root = Path(args.state_root).expanduser()
            state = StateStore(state_root)
            report = HealthDoctor(
                manifest_dir=root / "manifests",
                artifact_root=root,
                state_root=state_root,
                probe_verifier=state.verify_trusted_probe,
            ).inspect(runtime_versions=_versions(args.runtime_version))
            _emit(report)
            return 0
        if args.command == "activate":
            if args.apply and not args.reload_deferred:
                return _refuse_unverified_quiescence()
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_root = (
                Path(args.backup_root).expanduser()
                if args.backup_root
                else Path(
                    f"~/.local/share/fractal-agent/backups/{stamp}"
                ).expanduser()
            )
            installer = ActivationInstaller(
                artifact_root=root,
                spec_dir=root / "activation",
                home=Path(args.home).expanduser(),
                hook_command=Path(args.hook_command).expanduser(),
                backup_root=backup_root,
            )
            links = install_neutral_links(
                artifact_root=root,
                home=Path(args.home).expanduser(),
                dry_run=not args.apply,
            )
            report = installer.install(
                _versions(args.runtime_version),
                runtime_ids=set(args.runtime) or None,
                dry_run=not args.apply,
                quiescence_verifier=(
                    (lambda _runtime_id: True)
                    if args.apply and args.reload_deferred
                    else None
                ),
            )
            report["links"] = links["links"]
            _emit(report)
            return 0
        manager = ReleaseManager(
            source_root=root,
            install_root=Path(args.install_root),
            artifacts=_artifacts(root),
        )
        if args.command == "release":
            if args.apply and not _trusted_quiescence(
                runtime_stopped=args.runtime_stopped,
                verifier=quiescence_verifier,
            ):
                return _refuse_unverified_quiescence()
            _emit(manager.install(args.version, dry_run=not args.apply))
            return 0
        if not args.apply or not _trusted_quiescence(
            runtime_stopped=args.runtime_stopped,
            verifier=quiescence_verifier,
        ):
            return _refuse_unverified_quiescence()
        _emit(manager.rollback())
        return 0
    except (ActivationError, ReleaseError, ValueError) as exc:
        _emit(
            {
                "status": "error",
                "reason_code": "config_concurrent_change",
                "error_type": type(exc).__name__,
                "retryable": False,
            }
        )
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
