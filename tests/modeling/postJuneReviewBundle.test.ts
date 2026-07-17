import { buildPostJuneReviewBundle } from "../../scripts/modeling/strategies/build-post-june-review-bundle";
// @ts-expect-error Vitest is supplied by the required one-off npx command.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("post-June review bundle", () => {
  const root = resolve(process.cwd());
  const review = "modeling/review/2026-07-17-post-june-canonical-review-v1";
  const walk = "modeling/canonical/model-handoff-v1/docs/POLYPROPICKS_POST_JUNE_CANONICAL_WALKTHROUGH_RU_V1.md";
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  it("builds a deterministic, inspect-only package anchored to frozen evidence", () => {
    const a = buildPostJuneReviewBundle(root), b = buildPostJuneReviewBundle(root);
    expect(a.manifest).toEqual(b.manifest);
    for (const file of [walk, `${review}/REVIEW_BUNDLE_INDEX_RU.md`, `${review}/INDEPENDENT_REVIEW_PROMPT_RU.md`, `${review}/source_inventory.json`, `${review}/review_questions.json`, `${review}/expected_verdict_schema.json`, `${review}/manifest.json`]) expect(existsSync(resolve(root, file))).toBe(true);
    const text = readFileSync(resolve(root, walk), "utf8");
    expect(text).toContain("b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45");
    expect(text).toContain("+16.82674451u"); expect(text).toContain("PRE-JUNE8: QUARANTINED");
    expect(text).toContain("UPSTREAM_SCORE_PRODUCTION_NOT_FROZEN"); expect(text).toContain("post_june_canonical_pnl.html");
    expect(text).not.toMatch(/[A-Za-z]:\\/); expect(text).not.toMatch(/https?:\/\//);
    const prompt = readFileSync(resolve(root, `${review}/INDEPENDENT_REVIEW_PROMPT_RU.md`), "utf8");
    expect(prompt).toContain("inspect-only"); expect(prompt).toContain("не изменяйте репозиторий"); expect(prompt).toContain("не является допустимым автоматическим выводом");
    const inv = JSON.parse(readFileSync(resolve(root, `${review}/source_inventory.json`), "utf8"));
    for (const item of inv) expect(hash(readFileSync(resolve(root, item.relativePath), "utf8"))).toBe(item.sha256);
    const manifest = JSON.parse(readFileSync(resolve(root, `${review}/manifest.json`), "utf8"));
    for (const [file, digest] of Object.entries(manifest.files)) expect(hash(readFileSync(resolve(root, `${review}/${file}`), "utf8"))).toBe(digest);
  });
});
