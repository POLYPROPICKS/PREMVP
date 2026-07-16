import importlib.util
import hashlib
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
ORACLE_PATH = ROOT / "scripts" / "modeling" / "reference-statistics" / "reference_oracle.py"
EVIDENCE = ROOT / "modeling" / "evidence" / "2026-07-16-statistical-reference-oracle"


def load_oracle():
    spec = importlib.util.spec_from_file_location("reference_oracle", ORACLE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("reference oracle module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReferenceOracleValidationTests(unittest.TestCase):
    def setUp(self):
        self.oracle = load_oracle()

    def spa_input(self):
        return {
            "schema_version": 1,
            "fixture_id": "test",
            "operation": "spa",
            "benchmark": [1.0, 0.8, 1.2, 0.9],
            "models": [[0.9, 0.7, 1.1, 0.8], [1.1, 0.9, 1.3, 1.0]],
            "parameters": {
                "bootstrap": "stationary",
                "block_size": 2,
                "reps": 20000,
                "seed": 20260716,
                "studentize": True,
                "nested": False,
            },
        }

    def test_invalid_dimensions_are_rejected(self):
        payload = self.spa_input()
        payload["models"][0].pop()
        with self.assertRaisesRegex(ValueError, "dimensions"):
            self.oracle.validate_input(payload)

    def test_nan_and_infinity_are_rejected(self):
        for invalid in (math.nan, math.inf, -math.inf):
            payload = self.spa_input()
            payload["benchmark"][0] = invalid
            with self.assertRaisesRegex(ValueError, "finite"):
                self.oracle.validate_input(payload)

    def test_missing_seed_and_block_size_are_rejected(self):
        for field in ("seed", "block_size"):
            payload = self.spa_input()
            del payload["parameters"][field]
            with self.assertRaisesRegex(ValueError, field):
                self.oracle.validate_input(payload)

    def test_wrong_arch_version_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "arch==8.0.0"):
            self.oracle.assert_arch_version("7.2.0")

    def test_output_schema_hashes_and_runtime(self):
        result = self.oracle.run_oracle(self.spa_input())
        self.oracle.validate_output(result)
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(len(result["input_sha256"]), 64)
        self.assertEqual(len(result["output_sha256"]), 64)
        self.assertEqual(result["runtime"]["arch"], "8.0.0")
        self.assertIn("python", result["runtime"])
        self.assertIn("numpy", result["runtime"])
        self.assertIn("pandas", result["runtime"])
        self.assertIn("scipy", result["runtime"])

    def test_pvalue_bounds_and_ordering(self):
        result = self.oracle.run_oracle(self.spa_input())
        pvalues = result["results"]["pvalues"]
        self.assertLessEqual(pvalues["lower"], pvalues["consistent"])
        self.assertLessEqual(pvalues["consistent"], pvalues["upper"])
        for value in pvalues.values():
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, 1.0)

    def test_block_lengths_are_positive(self):
        payload = {
            "schema_version": 1,
            "fixture_id": "block",
            "operation": "optimal_block_length",
            "series": [0.1, -0.2, 0.3, -0.1, 0.4, -0.3, 0.2, 0.0] * 4,
        }
        result = self.oracle.run_oracle(payload)
        self.assertGreater(result["results"]["b_sb"], 0.0)
        self.assertGreater(result["results"]["b_cb"], 0.0)

    def test_two_fresh_process_runs_are_identical(self):
        payload = self.spa_input()
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            input_path = temp / "input.json"
            output_one = temp / "one.json"
            output_two = temp / "two.json"
            input_path.write_text(json.dumps(payload), encoding="utf-8")
            commands = [
                [sys.executable, str(ORACLE_PATH), "--input", str(input_path), "--output", str(output_one)],
                [sys.executable, str(ORACLE_PATH), "--input", str(input_path), "--output", str(output_two)],
            ]
            for command in commands:
                subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
            self.assertEqual(output_one.read_bytes(), output_two.read_bytes())

    def test_reference_fixtures_match_and_pass_independent_checks(self):
        for fixture_id in "bcde":
            payload = json.loads((EVIDENCE / "fixtures" / f"fixture_{fixture_id}.json").read_text(encoding="utf-8"))
            expected = json.loads((EVIDENCE / "expected" / f"fixture_{fixture_id}.json").read_text(encoding="utf-8"))
            actual = self.oracle.run_oracle(payload)
            self.assertEqual(actual, expected)
            if payload["operation"] == "optimal_block_length":
                self.assertGreater(actual["results"]["b_sb"], 0)
                self.assertGreater(actual["results"]["b_cb"], 0)
                continue
            self.assertEqual(len(payload["benchmark"]), len(payload["models"][0]))
            self.assertTrue(all(math.isfinite(value) for value in payload["benchmark"]))
            means = actual["results"]["benchmark_minus_model_mean"]
            for index, model in enumerate(payload["models"]):
                hand_mean = sum(b - m for b, m in zip(payload["benchmark"], model)) / len(model)
                self.assertAlmostEqual(means[index], hand_mean, places=14)
            pvalues = actual["results"]["pvalues"]
            self.assertLessEqual(pvalues["lower"], pvalues["consistent"])
            self.assertLessEqual(pvalues["consistent"], pvalues["upper"])

    def test_constant_fixture_is_a_documented_official_error(self):
        payload = json.loads((EVIDENCE / "fixtures" / "fixture_a.json").read_text(encoding="utf-8"))
        expected = json.loads((EVIDENCE / "expected" / "fixture_a.json").read_text(encoding="utf-8"))
        with self.assertRaisesRegex(RuntimeError, expected["error"]):
            self.oracle.run_oracle(payload)

    def test_all_successful_fixtures_are_fresh_process_deterministic(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            for fixture_id in "bcde":
                input_path = EVIDENCE / "fixtures" / f"fixture_{fixture_id}.json"
                outputs = [temp / f"{fixture_id}-{run}.json" for run in (1, 2)]
                for output in outputs:
                    subprocess.run(
                        [sys.executable, str(ORACLE_PATH), "--input", str(input_path), "--output", str(output)],
                        cwd=ROOT,
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())

    def test_recorded_fixture_file_hashes_are_exact(self):
        recorded = json.loads((EVIDENCE / "fixture_hashes.json").read_text(encoding="utf-8"))
        self.assertEqual(len(recorded), 10)
        for relative_path, expected_hash in recorded.items():
            actual_hash = hashlib.sha256((EVIDENCE / relative_path).read_bytes()).hexdigest()
            self.assertEqual(actual_hash, expected_hash, relative_path)


if __name__ == "__main__":
    unittest.main()
