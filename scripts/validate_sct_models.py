#!/usr/bin/env python3
"""
Validate the SCT browser model manifest.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


VALID_CATEGORIES = {"spinal-cord", "gray-matter", "pathology", "other-structure", "unsupported", "retired"}
VALID_OUTPUT_TYPES = {"binary-mask", "multi-label-mask", "soft-mask", "unsupported"}
VALID_SUPPORT = {"supported", "unsupported", "unvalidated", "retired"}
VALID_VALIDATION = {"not-run", "passed", "failed", "manual-only"}
VALID_CONVERSION = {"native", "converted", "failed", "not-needed"}


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def require(obj: dict, key: str, where: str, errors: list[str]) -> None:
    if key not in obj:
        fail(errors, f"{where}: missing required key '{key}'")


def validate_label(label: dict, where: str, errors: list[str]) -> None:
    for key in ("index", "name", "rgba", "meaning"):
        require(label, key, where, errors)
    rgba = label.get("rgba")
    if not isinstance(rgba, list) or len(rgba) != 4 or any(not isinstance(v, int) or v < 0 or v > 255 for v in rgba):
        fail(errors, f"{where}: rgba must be four integers from 0 to 255")


def validate_asset(asset: dict, where: str, model_dir: Path, errors: list[str]) -> None:
    for key in ("id", "sourceUrl", "sourceVersion", "sourceFormat", "conversionStatus"):
        require(asset, key, where, errors)
    if asset.get("conversionStatus") not in VALID_CONVERSION:
        fail(errors, f"{where}: invalid conversionStatus '{asset.get('conversionStatus')}'")
    filename = asset.get("filename")
    if filename and asset.get("conversionStatus") in {"native", "converted"}:
        path = model_dir / filename
        if not path.exists():
            fail(errors, f"{where}: model file does not exist: {path}")
        if "checksum" not in asset:
            fail(errors, f"{where}: converted/native asset must include checksum")
    if asset.get("conversionStatus") == "failed" and not asset.get("failureReason"):
        fail(errors, f"{where}: failed conversion must include failureReason")


def validate_task(task: dict, index: int, model_dir: Path, errors: list[str]) -> None:
    where = f"tasks[{index}]"
    for key in ("id", "displayName", "category", "inputContrasts", "requiredInputs", "outputType", "supportStatus", "validationStatus"):
        require(task, key, where, errors)
    if task.get("category") not in VALID_CATEGORIES:
        fail(errors, f"{where}: invalid category '{task.get('category')}'")
    if task.get("outputType") not in VALID_OUTPUT_TYPES:
        fail(errors, f"{where}: invalid outputType '{task.get('outputType')}'")
    if task.get("supportStatus") not in VALID_SUPPORT:
        fail(errors, f"{where}: invalid supportStatus '{task.get('supportStatus')}'")
    if task.get("validationStatus") not in VALID_VALIDATION:
        fail(errors, f"{where}: invalid validationStatus '{task.get('validationStatus')}'")
    if task.get("supportStatus") in {"unsupported", "retired"} and not task.get("unsupportedReason"):
        fail(errors, f"{where}: unsupported/retired tasks must include unsupportedReason")
    if task.get("supportStatus") == "supported" and task.get("validationStatus") != "passed":
        fail(errors, f"{where}: supported tasks must have validationStatus=passed")
    labels = task.get("labels", [])
    if task.get("supportStatus") == "supported" and len(labels) < 2:
        fail(errors, f"{where}: supported tasks must define at least background and foreground labels")
    for label_index, label in enumerate(labels):
        validate_label(label, f"{where}.labels[{label_index}]", errors)
    for asset_index, asset in enumerate(task.get("modelAssets", [])):
        validate_asset(asset, f"{where}.modelAssets[{asset_index}]", model_dir, errors)


def validate_manifest(path: Path, task_filter: str | None = None) -> list[str]:
    errors: list[str] = []
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"Could not parse manifest {path}: {exc}"]

    for key in ("schemaVersion", "sctStableSource", "generatedAt", "tasks"):
        require(manifest, key, "manifest", errors)
    if manifest.get("schemaVersion") != "1.0.0":
        fail(errors, "manifest: schemaVersion must be 1.0.0")
    tasks = manifest.get("tasks", [])
    if not isinstance(tasks, list) or not tasks:
        fail(errors, "manifest: tasks must be a non-empty list")
        return errors

    filtered = [task for task in tasks if task_filter in (None, "all", task.get("id"))]
    if task_filter not in (None, "all") and not filtered:
        fail(errors, f"manifest: task not found: {task_filter}")

    for index, task in enumerate(filtered):
        validate_task(task, index, path.parent, errors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate SCT browser model manifest")
    parser.add_argument("--manifest", default="web/models/manifest.json")
    parser.add_argument("--task", default=None)
    parser.add_argument("--all-tasks", action="store_true")
    args = parser.parse_args()

    task_filter = "all" if args.all_tasks else args.task
    errors = validate_manifest(Path(args.manifest), task_filter)
    if errors:
        print("SCT manifest validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"SCT manifest validation passed: {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
