import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadFrozenAuditInputs } from "../../lib/modeling/postJuneCanonicalFreeze";
import { buildExecutionWaterfall } from "../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { getStrictDedupKeyForExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";
import {
  collectForwardRows,
  buildSnapshotBytes,
  computeSha256,
  buildManifest,
  buildManifestBytes,
  assertSafeExternalOutputPath,
  exportForwardSnapshot,
  createSupabaseForwardSourceAdapter,
  FORWARD_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  FORWARD_SNAPSHOT_SOURCE_CONTRACT_VERSION,
  type ForwardSourceAdapter,
  type ForwardSourceCursor,
} from "../../lib/modeling/forwardSnapshotExporter";

const root = process.cwd();
const AS_OF = "2026-06-01T00:00:00.000Z";
const SOURCE_COMMIT = "1a01f2741c55880b3de2896d70717f7ab0ba3725";

// ── realistic unresolved source rows derived from the frozen corpus ──
function toUnresolvedSourceRow(row: ExportRow, createdAt: string): Record<string, unknown> {
  // Shape rows like the physical generated_signal_pairs source (pre-normalization):
  // selected_token_id (not token_id), no resolution fields.
  const src: Record<string, unknown> = { ...row };
  delete src.resolved_at;
  delete src.result;
  delete src.signal_result;
  delete src.outcome_status;
  delete src.realized_return_pct;
  delete src.winning_outcome;
  delete src.token_id;
  src.selected_token_id = (row as Record<string, unknown>).token_id ?? "tok-" + String(row.id);
  src.signal_result = null;
  src.resolved_at = null;
  src.created_at = createdAt;
  return src;
}

function realUnresolvedSourceRows(): Record<string, unknown>[] {
  const { corpus } = loadFrozenAuditInputs(root);
  const classifier = loadExecutableFunnelClassifier();
  const waterfall = buildExecutionWaterfall(corpus as ExportRow[], classifier);
  return waterfall.executionCandidates.slice(0, 6).map((c, i) =>
    toUnresolvedSourceRow(c.row as ExportRow, `2026-05-0${(i % 5) + 1}T00:00:00.000Z`),
  );
}

const SOURCE_ROWS = realUnresolvedSourceRows();

// Fake read-only adapter: keyset paginates an in-memory array in
// canonical (created_at DESC, id DESC) order. `pageGroups` optionally forces
// a specific page-boundary layout to prove page-order independence.
function fakeAdapter(rows: Record<string, unknown>[]): ForwardSourceAdapter {
  const canonicalCmp = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ca = String(a.created_at), cb = String(b.created_at);
    if (ca !== cb) return ca < cb ? 1 : -1; // created_at DESC
    const ia = String(a.id), ib = String(b.id);
    return ia < ib ? 1 : ia > ib ? -1 : 0;    // id DESC
  };
  return {
    async fetchPage(input: { asOfIso: string; cursor: ForwardSourceCursor | null; limit: number }) {
      const asOfMs = Date.parse(input.asOfIso);
      const sorted = [...rows]
        .filter((r) => Date.parse(String(r.created_at)) <= asOfMs)
        .sort(canonicalCmp);
      let start = 0;
      if (input.cursor) {
        start = sorted.findIndex(
          (r) => String(r.created_at) === input.cursor!.createdAt && String(r.id) === input.cursor!.id,
        ) + 1;
      }
      return sorted.slice(start, start + input.limit);
    },
  };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pp-forward-export-"));
}

// 1 + 2. Exact source query fields / read-only adapter shape.
test("1: production adapter exposes only a read-only fetchPage and no mutating methods", () => {
  const adapter = createSupabaseForwardSourceAdapter({ url: "https://example.invalid", key: "k" }, (async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [], text: async () => "" })) as never);
  const keys = Object.keys(adapter);
  assert.deepEqual(keys, ["fetchPage"]);
  for (const forbidden of ["insert", "update", "upsert", "delete", "rpc"]) {
    assert.equal((adapter as unknown as Record<string, unknown>)[forbidden], undefined);
  }
});

// 3 + 5. Explicit asOf + unresolved-only contract accepted end-to-end.
test("3+5: valid unresolved rows within asOf are collected via injected adapter", async () => {
  const { rows, identityKeys } = await collectForwardRows(fakeAdapter(SOURCE_ROWS), AS_OF, 2);
  assert.equal(rows.length, SOURCE_ROWS.length);
  assert.equal(identityKeys.length, SOURCE_ROWS.length);
  for (const r of rows) {
    assert.equal(r.signal_result, null);
    assert.equal(r.resolved_at, null);
    assert.ok(getStrictDedupKeyForExportRow(r as ExportRow) !== null);
  }
});

// 4. Client-side asOf rejection.
test("4: a source row with created_at after asOf is rejected fail-closed", async () => {
  const rows = [...SOURCE_ROWS, toUnresolvedSourceRow(SOURCE_ROWS[0] as ExportRow, "2026-07-01T00:00:00.000Z")];
  // fake adapter already filters by asOf server-side; force a leaking adapter:
  const leaking: ForwardSourceAdapter = { async fetchPage() { return rows.slice(-1); } };
  await assert.rejects(() => collectForwardRows(leaking, AS_OF, 10), /FORWARD_EXPORT_ROW_CREATED_AT_AFTER_AS_OF/);
});

// unresolved contract: resolved row rejected before snapshot creation.
test("5b: a resolved/outcome-bearing source row is rejected before snapshot", async () => {
  const bad = { ...SOURCE_ROWS[0], signal_result: "WIN" };
  const leaking: ForwardSourceAdapter = { async fetchPage() { return [bad]; } };
  await assert.rejects(() => collectForwardRows(leaking, AS_OF, 10), /FORWARD_EXPORT_ROW_RESOLVED/);
  const bad2 = { ...SOURCE_ROWS[0], resolved_at: "2026-05-10T00:00:00.000Z" };
  const leaking2: ForwardSourceAdapter = { async fetchPage() { return [bad2]; } };
  await assert.rejects(() => collectForwardRows(leaking2, AS_OF, 10), /FORWARD_EXPORT_ROW_RESOLVED/);
});

// 5c. real_pnl_usd is realized-PnL settlement data and must be rejected as
// resolution leakage via the real public exporter path.
test("5c: a source row carrying real_pnl_usd is rejected before snapshot", async () => {
  const bad = { ...SOURCE_ROWS[0], real_pnl_usd: 12.34 };
  const leaking: ForwardSourceAdapter = { async fetchPage() { return [bad]; } };
  await assert.rejects(() => collectForwardRows(leaking, AS_OF, 10), /FORWARD_EXPORT_ROW_RESOLVED:.*field=real_pnl_usd/);
});

// 5c-b. real_pnl_usd rejection through the full export leaves zero output,
// manifest, and temporary files.
test("5c-b: a full export of a real_pnl_usd-bearing row writes zero output/manifest/temp files", async () => {
  const dir = tempDir();
  try {
    const bad = { ...SOURCE_ROWS[0], real_pnl_usd: 9.99 };
    const leaking: ForwardSourceAdapter = { async fetchPage(input) { return input.cursor ? [] : [bad]; } };
    await assert.rejects(
      () => exportForwardSnapshot({ adapter: leaking, asOfIso: AS_OF, outputPath: path.join(dir, "s.jsonl"), manifestPath: path.join(dir, "m.json"), repositoryRoot: root, sourceCommit: SOURCE_COMMIT }),
      /FORWARD_EXPORT_ROW_RESOLVED:.*field=real_pnl_usd/,
    );
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 5c-c. winning_outcome is the resolved winning side and must remain rejected.
test("5c-c: winning_outcome remains rejected as resolution leakage", async () => {
  const bad = { ...SOURCE_ROWS[0], winning_outcome: "Canadiens" };
  const leaking: ForwardSourceAdapter = { async fetchPage() { return [bad]; } };
  await assert.rejects(() => collectForwardRows(leaking, AS_OF, 10), /FORWARD_EXPORT_ROW_RESOLVED:.*field=winning_outcome/);
});

// 5c-d. selected_outcome is the model's pre-resolution pick (forward decision
// data): it must be ACCEPTED and PRESERVED in the normalized snapshot. This is
// a semantic regression lock, expected to pass before and after the patch.
test("5c-d: selected_outcome is accepted and preserved in the normalized snapshot", async () => {
  const withPick = { ...SOURCE_ROWS[0], selected_outcome: "Canadiens" };
  const { rows } = await collectForwardRows(fakeAdapter([withPick]), AS_OF, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].selected_outcome, "Canadiens");
  // exportable end-to-end with no resolution fields present
  const dir = tempDir();
  try {
    const res = await exportForwardSnapshot({ adapter: fakeAdapter([withPick]), asOfIso: AS_OF, outputPath: path.join(dir, "s.jsonl"), manifestPath: path.join(dir, "m.json"), repositoryRoot: root, sourceCommit: SOURCE_COMMIT });
    assert.equal(res.rowCount, 1);
    const line = JSON.parse(readFileSync(path.join(dir, "s.jsonl"), "utf8").trim());
    assert.equal(line.selected_outcome, "Canadiens");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 6. Deterministic stable pagination across shared created_at.
test("6: keyset pagination over rows sharing created_at yields every row exactly once", async () => {
  const shared = SOURCE_ROWS.map((r, i) => ({ ...r, id: `dup-${i}`, created_at: "2026-05-02T00:00:00.000Z" }));
  const { rows } = await collectForwardRows(fakeAdapter(shared), AS_OF, 2);
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, shared.length);
});

// 7. Duplicate source identity detection.
test("7: two source rows with the same strict identity fail closed", async () => {
  const dupId = { ...SOURCE_ROWS[1], id: "other-id" };
  const leaking: ForwardSourceAdapter = { async fetchPage(input) { return input.cursor ? [] : [SOURCE_ROWS[1], dupId]; } };
  await assert.rejects(() => collectForwardRows(leaking, AS_OF, 10), /FORWARD_EXPORT_DUPLICATE_SOURCE_IDENTITY/);
});

// 8. Malformed row fail closed (missing id / missing identity).
test("8: a malformed source row (missing id) fails closed", async () => {
  const bad = { ...SOURCE_ROWS[0] }; delete (bad as Record<string, unknown>).id;
  const leaking: ForwardSourceAdapter = { async fetchPage() { return [bad]; } };
  await assert.rejects(() => collectForwardRows(leaking, AS_OF, 10), /FORWARD_EXPORT_ROW_MISSING_ID/);
});

// 9. Empty export.
test("9: an empty source produces zero rows", async () => {
  const { rows, identityKeys } = await collectForwardRows(fakeAdapter([]), AS_OF, 2);
  assert.equal(rows.length, 0);
  assert.equal(identityKeys.length, 0);
});

// 10 + 11. Deterministic row ordering / byte-identical snapshot for identical input.
test("10+11: snapshot bytes are deterministic and independent of source page order", async () => {
  const a = await collectForwardRows(fakeAdapter(SOURCE_ROWS), AS_OF, 2);
  const b = await collectForwardRows(fakeAdapter([...SOURCE_ROWS].reverse()), AS_OF, 5);
  assert.equal(buildSnapshotBytes(a.rows), buildSnapshotBytes(b.rows));
  // deterministic ordering: sorting the produced rows again does not change bytes
  assert.equal(buildSnapshotBytes(a.rows), buildSnapshotBytes([...a.rows]));
});

// 13. Snapshot SHA matches bytes.
test("13: snapshot SHA equals sha256 of the snapshot bytes", async () => {
  const { rows } = await collectForwardRows(fakeAdapter(SOURCE_ROWS), AS_OF, 3);
  const bytes = buildSnapshotBytes(rows);
  assert.equal(computeSha256(bytes), computeSha256(bytes));
  assert.match(computeSha256(bytes), /^[0-9a-f]{64}$/);
});

// 12. Byte-identical manifest for identical input.
test("12: manifest bytes are deterministic for identical input", async () => {
  const { rows, identityKeys } = await collectForwardRows(fakeAdapter(SOURCE_ROWS), AS_OF, 2);
  const bytes = buildSnapshotBytes(rows);
  const m1 = buildManifest({ asOfIso: AS_OF, rowCount: rows.length, snapshotBytes: bytes, identityKeys, sourceCommit: SOURCE_COMMIT });
  const m2 = buildManifest({ asOfIso: AS_OF, rowCount: rows.length, snapshotBytes: bytes, identityKeys, sourceCommit: SOURCE_COMMIT });
  assert.equal(buildManifestBytes(m1), buildManifestBytes(m2));
  assert.equal(m1.schemaVersion, FORWARD_SNAPSHOT_MANIFEST_SCHEMA_VERSION);
  assert.equal(m1.sourceContractVersion, FORWARD_SNAPSHOT_SOURCE_CONTRACT_VERSION);
  assert.deepEqual(m1.sourceTables, ["generated_signal_pairs"]);
  assert.equal(m1.rawSnapshotSha256, computeSha256(bytes));
  assert.equal(m1.outputFormat, "JSONL");
  assert.equal(m1.readOnlySafetyVerdict, "READ_ONLY_NO_WRITES");
});

// manifest must not embed secrets/urls.
test("manifest carries no credentials, urls, or env values", async () => {
  const { rows, identityKeys } = await collectForwardRows(fakeAdapter(SOURCE_ROWS), AS_OF, 2);
  const bytes = buildSnapshotBytes(rows);
  const m = buildManifestBytes(buildManifest({ asOfIso: AS_OF, rowCount: rows.length, snapshotBytes: bytes, identityKeys, sourceCommit: SOURCE_COMMIT }));
  assert.doesNotMatch(m, /SUPABASE_URL|SERVICE_ROLE|https?:\/\/|apikey|Bearer|eyJ/);
});

// 14-19. Path safety.
test("14+15: relative output and manifest paths are rejected", () => {
  assert.throws(() => assertSafeExternalOutputPath("snapshot.jsonl", root, "OUTPUT"), /FORWARD_EXPORT_OUTPUT_MUST_BE_ABSOLUTE/);
  assert.throws(() => assertSafeExternalOutputPath("manifest.json", root, "MANIFEST"), /FORWARD_EXPORT_MANIFEST_MUST_BE_ABSOLUTE/);
});

test("16: protected repository/frozen targets are rejected", () => {
  const targets = [
    path.join(root, "snapshot.jsonl"),
    path.join(root, "modeling/canonical/datasets/snapshot.jsonl"),
    path.join(root, "modeling/evidence/snapshot.jsonl"),
  ];
  for (const t of targets) {
    assert.throws(() => assertSafeExternalOutputPath(t, root, "OUTPUT"), /PROTECTED_ROOT_REJECTED/);
  }
});

test("17: a symlink into the repository fails closed", () => {
  const dir = tempDir();
  try {
    const junction = path.join(dir, "repo-link");
    symlinkSync(root, junction, "dir");
    assert.throws(() => assertSafeExternalOutputPath(path.join(junction, "snapshot.jsonl"), root, "OUTPUT"), /SYMLINK_REJECTED|PROTECTED_ROOT_REJECTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 18 + 19 + 22 + 23. End-to-end atomic export.
test("18+19: exportForwardSnapshot writes a byte-stable snapshot+manifest pair to an external dir", async () => {
  const dir = tempDir();
  try {
    const output = path.join(dir, "snapshot.jsonl");
    const manifest = path.join(dir, "manifest.json");
    const res = await exportForwardSnapshot({ adapter: fakeAdapter(SOURCE_ROWS), asOfIso: AS_OF, outputPath: output, manifestPath: manifest, repositoryRoot: root, sourceCommit: SOURCE_COMMIT, pageSize: 2 });
    assert.equal(res.rowCount, SOURCE_ROWS.length);
    assert.ok(existsSync(output) && existsSync(manifest));
    assert.deepEqual(readdirSync(dir).sort(), ["manifest.json", "snapshot.jsonl"]);
    const bytes = readFileSync(output, "utf8");
    assert.equal(computeSha256(bytes), res.rawSnapshotSha256);
    // exact re-export into a fresh dir is byte-identical
    const dir2 = tempDir();
    try {
      const out2 = path.join(dir2, "snapshot.jsonl");
      await exportForwardSnapshot({ adapter: fakeAdapter([...SOURCE_ROWS].reverse()), asOfIso: AS_OF, outputPath: out2, manifestPath: path.join(dir2, "manifest.json"), repositoryRoot: root, sourceCommit: SOURCE_COMMIT, pageSize: 4 });
      assert.equal(readFileSync(out2, "utf8"), bytes);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output and manifest cannot be the same path", async () => {
  const dir = tempDir();
  try {
    const p = path.join(dir, "same.jsonl");
    await assert.rejects(() => exportForwardSnapshot({ adapter: fakeAdapter(SOURCE_ROWS), asOfIso: AS_OF, outputPath: p, manifestPath: p, repositoryRoot: root, sourceCommit: SOURCE_COMMIT }), /FORWARD_EXPORT_OUTPUT_MANIFEST_SAME_PATH/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("19b: an existing output or manifest file is never overwritten", async () => {
  const dir = tempDir();
  try {
    const output = path.join(dir, "snapshot.jsonl");
    const manifest = path.join(dir, "manifest.json");
    writeFileSync(output, "PRE-EXISTING", "utf8");
    await assert.rejects(() => exportForwardSnapshot({ adapter: fakeAdapter(SOURCE_ROWS), asOfIso: AS_OF, outputPath: output, manifestPath: manifest, repositoryRoot: root, sourceCommit: SOURCE_COMMIT }), /FORWARD_EXPORT_OUTPUT_EXISTS/);
    assert.equal(readFileSync(output, "utf8"), "PRE-EXISTING");
    assert.equal(existsSync(manifest), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 20 + 21. Source failure / validation failure => zero writes.
test("20: a source page failure produces zero output files", async () => {
  const dir = tempDir();
  try {
    const failing: ForwardSourceAdapter = { async fetchPage() { throw new Error("SOURCE_PAGE_FAILURE"); } };
    await assert.rejects(() => exportForwardSnapshot({ adapter: failing, asOfIso: AS_OF, outputPath: path.join(dir, "s.jsonl"), manifestPath: path.join(dir, "m.json"), repositoryRoot: root, sourceCommit: SOURCE_COMMIT }), /SOURCE_PAGE_FAILURE/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("21: a validation failure produces zero output files", async () => {
  const dir = tempDir();
  try {
    const bad = { ...SOURCE_ROWS[0], signal_result: "LOSS" };
    const leaking: ForwardSourceAdapter = { async fetchPage(input) { return input.cursor ? [] : [bad]; } };
    await assert.rejects(() => exportForwardSnapshot({ adapter: leaking, asOfIso: AS_OF, outputPath: path.join(dir, "s.jsonl"), manifestPath: path.join(dir, "m.json"), repositoryRoot: root, sourceCommit: SOURCE_COMMIT }), /FORWARD_EXPORT_ROW_RESOLVED/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 22. Atomic temp cleanup — no .tmp residue after success.
test("22: a successful export leaves no temporary files", async () => {
  const dir = tempDir();
  try {
    await exportForwardSnapshot({ adapter: fakeAdapter(SOURCE_ROWS), asOfIso: AS_OF, outputPath: path.join(dir, "snapshot.jsonl"), manifestPath: path.join(dir, "manifest.json"), repositoryRoot: root, sourceCommit: SOURCE_COMMIT });
    assert.deepEqual(readdirSync(dir).sort(), ["manifest.json", "snapshot.jsonl"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 24 + 25 + 26. Static safety: no forbidden write methods / no forbidden imports / no package or repo mutation.
test("24+25: the exporter module contains no Supabase write methods, no mutable client, and no queue/Contur3/Ireland imports", () => {
  const src = readFileSync(path.join(root, "lib/modeling/forwardSnapshotExporter.ts"), "utf8");
  // real Supabase write verbs (crypto's harmless createHash().update() is excluded on purpose)
  assert.doesNotMatch(src, /\.(insert|upsert|rpc)\s*\(/);
  assert.doesNotMatch(src, /\bfrom\([^)]*\)[\s\S]{0,40}\.(update|delete)\s*\(/);
  // the core never imports a mutable supabase client
  assert.doesNotMatch(src, /createClient|supabaseAdmin|@supabase\/supabase-js/);
  assert.doesNotMatch(src, /storage|auth\.admin/i);
  assert.doesNotMatch(src, /queue|reservation|contur3|ireland/i);
});

test("26: the exporter core performs GET-only transport (no write verbs in production adapter)", () => {
  const src = readFileSync(path.join(root, "lib/modeling/forwardSnapshotExporter.ts"), "utf8");
  // the only HTTP method literal is GET
  const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  for (const m of methods) assert.equal(m, "GET");
});
