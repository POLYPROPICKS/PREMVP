#!/usr/bin/env python3
"""Deterministic JSON oracle for the approved arch statistical convention."""

import argparse
import hashlib
import inspect
import json
import math
import platform
import sys
from pathlib import Path
from typing import Any

import arch
import numpy as np
import pandas as pd
import scipy
import statsmodels
from arch.bootstrap import SPA, optimal_block_length


ARCH_VERSION = "8.0.0"
APPROVED_PARAMETERS = {
    "bootstrap": "stationary",
    "reps": 20000,
    "seed": 20260716,
    "studentize": True,
    "nested": False,
}


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def assert_arch_version(actual: str) -> None:
    if actual != ARCH_VERSION:
        raise RuntimeError(f"reference oracle requires arch==8.0.0; found {actual}")


def _finite_vector(value: Any, name: str) -> list[float]:
    if not isinstance(value, list) or len(value) < 2:
        raise ValueError(f"{name} must be an array with at least two values")
    result: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise ValueError(f"{name} must contain only finite numeric values")
        result.append(float(item))
    return result


def validate_input(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("schema_version must equal 1")
    if not isinstance(payload.get("fixture_id"), str) or not payload["fixture_id"]:
        raise ValueError("fixture_id must be a non-empty string")
    operation = payload.get("operation")
    if operation == "optimal_block_length":
        _finite_vector(payload.get("series"), "series")
        if "parameters" in payload:
            raise ValueError("optimal_block_length does not accept parameters")
        return payload
    if operation != "spa":
        raise ValueError("operation must be optimal_block_length or spa")
    benchmark = _finite_vector(payload.get("benchmark"), "benchmark")
    models = payload.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("models must contain at least one model")
    for index, model in enumerate(models):
        values = _finite_vector(model, f"models[{index}]")
        if len(values) != len(benchmark):
            raise ValueError("benchmark and model dimensions must match")
    parameters = payload.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("parameters are required for SPA")
    for field, expected in APPROVED_PARAMETERS.items():
        if field not in parameters:
            raise ValueError(f"{field} is required")
        if parameters[field] != expected:
            raise ValueError(f"{field} must equal the approved value {expected!r}")
    if "block_size" not in parameters:
        raise ValueError("block_size is required")
    if isinstance(parameters["block_size"], bool) or not isinstance(parameters["block_size"], int) or parameters["block_size"] <= 0:
        raise ValueError("block_size must be a positive integer")
    if set(parameters) != set(APPROVED_PARAMETERS) | {"block_size"}:
        raise ValueError("only approved SPA parameters are accepted")
    return payload


def runtime_versions() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "arch": arch.__version__,
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "scipy": scipy.__version__,
        "statsmodels": statsmodels.__version__,
    }


def verify_api_contract() -> None:
    assert_arch_version(arch.__version__)
    spa_parameters = inspect.signature(SPA).parameters
    for name in ("block_size", "reps", "bootstrap", "studentize", "nested", "seed"):
        if name not in spa_parameters:
            raise RuntimeError(f"arch SPA API is missing {name}")
    probe = optimal_block_length(np.arange(16.0))
    if list(probe.columns) != ["stationary", "circular"]:
        raise RuntimeError("arch optimal_block_length API did not return stationary and circular")


def _base_output(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "fixture_id": payload["fixture_id"],
        "operation": payload["operation"],
        "input_sha256": sha256(payload),
        "runtime": runtime_versions(),
    }


def run_oracle(payload: Any) -> dict[str, Any]:
    payload = validate_input(payload)
    verify_api_contract()
    output = _base_output(payload)
    if payload["operation"] == "optimal_block_length":
        reference = optimal_block_length(np.asarray(payload["series"], dtype=float))
        b_sb = float(reference.iloc[0]["stationary"])
        b_cb = float(reference.iloc[0]["circular"])
        if not math.isfinite(b_sb) or not math.isfinite(b_cb) or b_sb <= 0 or b_cb <= 0:
            raise RuntimeError("official optimal_block_length did not produce positive finite block lengths")
        output["parameters"] = {"approved_value": "b_sb"}
        output["results"] = {"b_sb": b_sb, "b_cb": b_cb}
    else:
        parameters = dict(payload["parameters"])
        benchmark = np.asarray(payload["benchmark"], dtype=float)
        models = np.asarray(payload["models"], dtype=float).T
        spa = SPA(benchmark, models, **parameters)
        spa.compute()
        pvalues = {name: float(spa.pvalues[name]) for name in ("lower", "consistent", "upper")}
        output["parameters"] = parameters
        output["results"] = {
            "pvalues": pvalues,
            "critical_values_at_0_10": {
                name: float(spa.critical_values(0.10)[name]) for name in ("lower", "consistent", "upper")
            },
            "better_models_at_0_10": [int(value) for value in spa.better_models(0.10, "consistent")],
            "benchmark_minus_model_mean": [float(value) for value in np.mean(benchmark[:, None] - models, axis=0)],
        }
    output["output_sha256"] = sha256(output)
    validate_output(output)
    return output


def validate_output(output: Any) -> None:
    if not isinstance(output, dict) or output.get("schema_version") != 1:
        raise ValueError("invalid output schema")
    for field in ("fixture_id", "operation", "input_sha256", "output_sha256", "runtime", "parameters", "results"):
        if field not in output:
            raise ValueError(f"output is missing {field}")
    expected_hash = sha256({key: value for key, value in output.items() if key != "output_sha256"})
    if output["output_sha256"] != expected_hash:
        raise ValueError("output_sha256 does not match normalized output")
    if output["runtime"].get("arch") != ARCH_VERSION:
        raise ValueError("output runtime arch version is not approved")
    if output["operation"] == "optimal_block_length":
        for field in ("b_sb", "b_cb"):
            value = output["results"].get(field)
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("block lengths must be positive and finite")
    else:
        pvalues = output["results"].get("pvalues", {})
        values = [pvalues.get(name) for name in ("lower", "consistent", "upper")]
        if any(not isinstance(value, (int, float)) or not 0 <= value <= 1 for value in values):
            raise ValueError("SPA p-values must be within [0,1]")
        if not values[0] <= values[1] <= values[2]:
            raise ValueError("SPA p-values must satisfy lower <= consistent <= upper")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        result = run_oracle(payload)
        args.output.write_bytes(canonical_bytes(result))
    except (OSError, json.JSONDecodeError, ValueError, RuntimeError) as error:
        print(f"reference-oracle: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
