import test from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_BUCKET_KEYS,
  bucketFailureReason,
  renderFailureBucketsLine,
  summarizeFailureBuckets,
  tallyFailureBuckets,
} from "../../lib/liquidity/failureBuckets";

test("bucketFailureReason maps known CLOB reasons to canonical buckets", () => {
  assert.equal(bucketFailureReason("http_404"), "http_404");
  assert.equal(bucketFailureReason("http_429"), "http_429");
  assert.equal(bucketFailureReason("timeout"), "timeout");
  assert.equal(bucketFailureReason("empty_book"), "empty_book");
  // Transport-level failures collapse into network_error.
  assert.equal(bucketFailureReason("fetch_failed"), "network_error");
  assert.equal(bucketFailureReason("network_error"), "network_error");
  assert.equal(bucketFailureReason("NO_FETCH"), "network_error");
});

test("bucketFailureReason routes unmapped / other reasons to unknown", () => {
  assert.equal(bucketFailureReason("parse_failed"), "unknown");
  assert.equal(bucketFailureReason("one_sided_book"), "unknown");
  assert.equal(bucketFailureReason("http_500"), "unknown");
  assert.equal(bucketFailureReason("http_403"), "unknown");
  assert.equal(bucketFailureReason(null), "unknown");
  assert.equal(bucketFailureReason(undefined), "unknown");
  assert.equal(bucketFailureReason(""), "unknown");
});

test("bucketFailureReason is case/whitespace tolerant", () => {
  assert.equal(bucketFailureReason("  HTTP_404 "), "http_404");
  assert.equal(bucketFailureReason("Timeout"), "timeout");
});

test("tallyFailureBuckets counts reasons into all six buckets", () => {
  const counts = tallyFailureBuckets([
    "http_404",
    "http_404",
    "http_404",
    "timeout",
    "fetch_failed",
    "empty_book",
    "parse_failed",
    null,
  ]);
  assert.deepEqual(counts, {
    http_404: 3,
    http_429: 0,
    timeout: 1,
    network_error: 1,
    empty_book: 1,
    unknown: 2,
  });
  // Every canonical bucket key is always present (zero-filled).
  for (const key of FAILURE_BUCKET_KEYS) {
    assert.equal(typeof counts[key], "number");
  }
});

test("summarizeFailureBuckets reports total failures and top reason", () => {
  const summary = summarizeFailureBuckets([
    "http_404",
    "http_404",
    "http_404",
    "timeout",
  ]);
  assert.equal(summary.totalFailures, 4);
  assert.equal(summary.topReason, "http_404");
  assert.equal(summary.counts.http_404, 3);
  assert.equal(summary.counts.timeout, 1);
});

test("summarizeFailureBuckets reports topReason=none when there are no failures", () => {
  const summary = summarizeFailureBuckets([]);
  assert.equal(summary.totalFailures, 0);
  assert.equal(summary.topReason, "none");
});

test("renderFailureBucketsLine emits the canonical parseable summary line", () => {
  const line = renderFailureBucketsLine(
    tallyFailureBuckets(["http_404", "http_404", "timeout"]),
  );
  assert.equal(
    line,
    "LIQUIDITY_SNAPSHOT_FAILURE_BUCKETS http_404=2 http_429=0 timeout=1 network_error=0 empty_book=0 unknown=0",
  );
});
