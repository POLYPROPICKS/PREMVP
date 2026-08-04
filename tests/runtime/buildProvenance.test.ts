// Direct tests for the build-provenance resolution seam (node:test via tsx):
//   node --import tsx --test tests/runtime/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeShaCandidate,
  resolveBuildProvenance,
  buildBuildInfoResponse,
  BUILD_PROVENANCE_MISMATCH_ERROR,
} from "../../lib/runtime/buildProvenance";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("normalizeShaCandidate returns a valid lowercase 40-char SHA unchanged", () => {
  assert.equal(normalizeShaCandidate(SHA_A), SHA_A);
});

test("normalizeShaCandidate rejects an abbreviated SHA", () => {
  assert.equal(normalizeShaCandidate("a1b2c3d"), null);
});

test("normalizeShaCandidate normalizes a full-length uppercase SHA to lowercase", () => {
  assert.equal(normalizeShaCandidate(SHA_A.toUpperCase()), SHA_A);
});

test("normalizeShaCandidate rejects full-length non-hex input", () => {
  assert.equal(normalizeShaCandidate("g".repeat(40)), null);
});

test("normalizeShaCandidate rejects null/undefined/empty input", () => {
  assert.equal(normalizeShaCandidate(null), null);
  assert.equal(normalizeShaCandidate(undefined), null);
  assert.equal(normalizeShaCandidate(""), null);
});

test("resolveBuildProvenance falls back to unknown when no valid source exists", () => {
  assert.deepEqual(
    resolveBuildProvenance({ envCommitSha: null, gitHeadSha: "not-a-sha" }),
    { commit_sha: "unknown", provenance_source: "unknown" }
  );
});

test("resolveBuildProvenance prefers a valid env-sourced SHA", () => {
  assert.deepEqual(
    resolveBuildProvenance({ envCommitSha: SHA_A, gitHeadSha: null }),
    { commit_sha: SHA_A, provenance_source: "env_var" }
  );
});

test("resolveBuildProvenance falls back to a valid Git HEAD SHA", () => {
  assert.deepEqual(
    resolveBuildProvenance({ envCommitSha: null, gitHeadSha: SHA_B }),
    { commit_sha: SHA_B, provenance_source: "git_head" }
  );
});

test("resolveBuildProvenance accepts agreeing env and Git sources", () => {
  assert.deepEqual(
    resolveBuildProvenance({ envCommitSha: SHA_A, gitHeadSha: SHA_A }),
    { commit_sha: SHA_A, provenance_source: "env_var" }
  );
});

test("resolveBuildProvenance fails closed on conflicting valid sources", () => {
  assert.throws(
    () => resolveBuildProvenance({ envCommitSha: SHA_A, gitHeadSha: SHA_B }),
    new RegExp(BUILD_PROVENANCE_MISMATCH_ERROR)
  );
});

test("buildBuildInfoResponse returns 200 with the exact public fields for a valid SHA", () => {
  const { body, status } = buildBuildInfoResponse({ commitSha: SHA_A, provenanceSource: "git_head" });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["commit_sha", "provenance_source", "repository", "service"]);
  assert.equal(body.service, "polypropicks-premvp");
  assert.equal(body.repository, "POLYPROPICKS/PREMVP");
  assert.equal(body.commit_sha, SHA_A);
  assert.equal(body.provenance_source, "git_head");
});

test("buildBuildInfoResponse returns 503 and unknown when the baked SHA is missing", () => {
  const { body, status } = buildBuildInfoResponse({ commitSha: null, provenanceSource: null });
  assert.equal(status, 503);
  assert.equal(body.commit_sha, "unknown");
  assert.equal(body.provenance_source, "unknown");
});

test("buildBuildInfoResponse rejects an invalid baked SHA and normalizes to unknown/503", () => {
  const { body, status } = buildBuildInfoResponse({ commitSha: "not-a-sha", provenanceSource: "git_head" });
  assert.equal(status, 503);
  assert.equal(body.commit_sha, "unknown");
  assert.equal(body.provenance_source, "unknown");
});
