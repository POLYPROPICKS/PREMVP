// @ts-expect-error Vitest is supplied by the required one-off npx command.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  canonicalizeLabel,
  resolveMarketFamily,
  resolveSport,
  validateResolvedAttribution,
} from "../../lib/modeling/historicalAttributionRepair";

describe("historical attribution repair", () => {
  it("canonicalizes stable aliases", () => {
    expect(canonicalizeLabel("  Major-League Baseball ")).toBe("MAJOR LEAGUE BASEBALL");
    expect(canonicalizeLabel("major league baseball")).toBe("MAJOR LEAGUE BASEBALL");
  });

  it("gives direct metadata priority and reports conflicts", () => {
    expect(resolveSport({ sport: "baseball", eventTitle: "Zverev vs Fritz" } as any).canonical).toBe("BASEBALL");
    expect(resolveSport({ sport: "baseball", sports: "tennis", eventTitle: "x" } as any).conflict).toBe(true);
  });

  it("keeps title fallbacks LOW and missing metadata unresolved", () => {
    expect(resolveSport({ eventTitle: "New York Mets vs. Boston Red Sox" } as any).confidence).toBe("LOW");
    expect(resolveSport({ eventTitle: null } as any).confidence).toBe("UNRESOLVED");
  });

  it("maps source-backed market semantics deterministically", () => {
    expect(resolveMarketFamily({ marketType: "total_corners" } as any).canonical).toBe("TOTAL");
    expect(resolveMarketFamily({ eventTitle: "Spread: Spain (-2.5)" } as any).canonical).toBe("SPREAD");
  });

  it("detects duplicate IDs, silent drops, and missing provenance", () => {
    const rows = [{ executionIndex: 0, observationId: "a", sportCanonical: "BASEBALL", sportProvenance: null }] as any;
    const result = validateResolvedAttribution([...rows, ...rows], ["a", "b"]);
    expect(result.duplicateIds).toEqual(["a"]);
    expect(result.missingIds).toEqual(["b"]);
    expect(result.canonicalWithoutProvenance).toContain("a:sport");
  });

  it("preserves frozen bytes, IDs, execution order, and reconciled fixed totals", () => {
    const root=process.cwd(),dir=`${root}/modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1`;
    const raw=gunzipSync(readFileSync(`${root}/modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/generated_signal_pairs_export.json.gz`));
    expect(createHash("sha256").update(raw).digest("hex")).toBe("b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45");
    const input=JSON.parse(readFileSync(`${root}/modeling/evidence/2026-07-17-suspicious-growth-temporal-audit-v1/joined_231_observations.json`,"utf8"));
    const output=JSON.parse(readFileSync(`${dir}/resolved_231_attribution.json`,"utf8"));
    expect(input).toHaveLength(231); expect(new Set(input.map((r:any)=>r.observationId)).size).toBe(231);
    expect(output.map((r:any)=>r.observationId)).toEqual(input.map((r:any)=>r.observationId));
    expect(output.filter((r:any)=>r.sportCanonical&&!r.sportProvenance)).toHaveLength(0);
    const comparison=JSON.parse(readFileSync(`${dir}/window_comparison.json`,"utf8"));
    expect(comparison.early.fixedPnlU).toBe(37.12524392);
    expect(comparison.early.dynamicLedgerAttributedPnlU).toBe(44.03789264);
    expect(comparison.early.dynamicRequiredAnchorPnlU).toBe(78.00453764);
    expect(comparison.suffix.post8.grossPnl).toBe(19.03913781);
    expect(comparison.suffix.post9.grossPnl).toBe(16.82674451);
  });

  it("has reproducible manifest and offline HTML", () => {
    const dir=`${process.cwd()}/modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1`;
    const manifest=JSON.parse(readFileSync(`${dir}/manifest.json`,"utf8"));
    for(const [name,hash] of Object.entries(manifest.files))expect(createHash("sha256").update(readFileSync(`${dir}/${name}`)).digest("hex")).toBe(hash);
    const html=readFileSync(`${dir}/suspicious_growth_attribution_repair.html`,"utf8");
    expect(html).not.toMatch(/https?:\/\/|fetch\(|XMLHttpRequest|<script[^>]+src=/i);
  });
});
