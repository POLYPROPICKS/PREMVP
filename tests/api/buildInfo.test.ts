// Direct tests for GET /api/build-info (node:test via tsx):
//   node --import tsx --test tests/api/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { GET } from "../../app/api/build-info/route";

const VALID_SHA = "c".repeat(40);
const ENV_KEYS = ["BUILD_PROVENANCE_COMMIT_SHA", "BUILD_PROVENANCE_SOURCE"] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test("GET returns 200, the valid SHA, and only the allowed public fields", async () => {
  await withEnv({ BUILD_PROVENANCE_COMMIT_SHA: VALID_SHA, BUILD_PROVENANCE_SOURCE: "git_head" }, async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["commit_sha", "provenance_source", "repository", "service"]);
    assert.equal(body.service, "polypropicks-premvp");
    assert.equal(body.repository, "POLYPROPICKS/PREMVP");
    assert.equal(body.commit_sha, VALID_SHA);
    assert.equal(body.provenance_source, "git_head");
  });
});

test("GET returns 503 and commit_sha unknown when provenance is missing", async () => {
  await withEnv({}, async () => {
    const res = await GET();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.commit_sha, "unknown");
    assert.equal(body.provenance_source, "unknown");
  });
});

test("GET sets Cache-Control: no-store and JSON content type", async () => {
  await withEnv({ BUILD_PROVENANCE_COMMIT_SHA: VALID_SHA, BUILD_PROVENANCE_SOURCE: "env_var" }, async () => {
    const res = await GET();
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
  });
});

test("GET response contains no environment map, credential, or filesystem path", async () => {
  await withEnv({ BUILD_PROVENANCE_COMMIT_SHA: VALID_SHA, BUILD_PROVENANCE_SOURCE: "git_head" }, async () => {
    const res = await GET();
    const raw = await res.text();
    assert.doesNotMatch(raw, /SUPABASE|SERVICE_ROLE|SECRET|TOKEN|\/home\/|\/root\//i);
  });
});
