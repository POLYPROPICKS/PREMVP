#!/usr/bin/env python3
"""Deterministically build the single Box B release payload (v2) for the official migration API.

Inputs (all frozen at PR #529 SHA 809093ee):
  - ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql   (verbatim)
  - ops/research-clone/box-b/pilot_insert.sql                                         (verbatim)
  - the fail-closed verification block of operator_dbclone_box_b_v1.sql                (verbatim)
Outputs: release_v2/payload.sql, release_v2/manifest.json

The payload carries NO transaction control, NO sentinel-table "target identity" check and NO write to
supabase_migrations: the project-bound migration API establishes the target by exact project ref and
registers the version itself. The whole batch is one simple-protocol query, so any exception rolls
back everything. Business logic is unchanged; only the wrapper differs from the operator script.
"""
import hashlib, json, pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MIG = ROOT / "ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql"
PILOT = HERE / "pilot_insert.sql"
OPERATOR = HERE / "operator_dbclone_box_b_v1.sql"
OUT = HERE / "release_v2"

MIGRATION_NAME = "market_outcome_box_b_authority_v1"
VERIFY_START = "\n-- ===== fail-closed verification before COMMIT =====\n"
VERIFY_END = "commit;\n"

HEADER = f"""-- Box B release payload v2. Migration name for the official API: {MIGRATION_NAME}
-- Target: Research DBClone nppznoujvnyjargjkmnv, established by the project-bound migration API (exact project ref), not by this SQL.
-- One atomic batch: schema + 41 provider receipts + 20 market revisions + fail-closed verification.
-- Any exception rolls the whole batch back. Version/ledger registration is done by the API, never by this SQL.
-- Composition (all verbatim): migration 20261013130000, pilot_insert.sql, operator verification block, added count checks.
"""

GUARD = """-- ===== replay guard: refuse to run if Box B objects already exist (not a target-identity check) =====
do $$
begin
  if to_regclass('public.market_outcome_provider_receipts') is not null
     or to_regclass('public.market_outcome_revisions') is not null then
    raise exception 'BOX_B_GUARD: Box B already exists';
  end if;
end;
$$;
"""

EXTRA_VERIFY = """
-- ===== fail-closed verification (added in v2): 20 distinct markets, all FINAL, 41 receipts =====
do $$
begin
  if (select count(distinct condition_id) from public.market_outcome_revisions) <> 20
     or (select count(*) from public.market_outcome_revisions where outcome_status = 'FINAL') <> 20
     or (select count(*) from public.market_outcome_current where outcome_status = 'FINAL') <> 20
     or (select count(*) from public.market_outcome_revisions) <> 20
     or (select count(*) from public.market_outcome_provider_receipts) <> 41 then
    raise exception 'BOX_B_VERIFY: expected 20 distinct FINAL markets and 41 provider receipts';
  end if;
  if exists (select 1 from public.market_outcome_revisions where winner_token_id is null) then
    raise exception 'BOX_B_VERIFY: FINAL revision without winner';
  end if;
end;
$$;
"""


def sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    mig = MIG.read_text()
    pilot = PILOT.read_text()
    op = OPERATOR.read_text()
    i = op.index(VERIFY_START)
    j = op.rindex(VERIFY_END)
    assert op[j:] == VERIFY_END, "operator script must end with the commit"
    verify = op[i + 1:j]  # excludes the marker comment line and the closing commit
    verify = "-- ===== fail-closed verification (operator block verbatim; transaction wrapper removed) =====\n" + verify.split("\n", 1)[1]
    import re
    assert not re.search(r"^\s*(begin|commit|rollback)\s*;", verify, re.M | re.I)
    nl = lambda s: s if s.endswith("\n") else s + "\n"
    payload = (HEADER + GUARD + "-- ===== schema: migration 20261013130000 (verbatim) =====\n" + nl(mig)
               + "-- ===== pilot data (verbatim pilot_insert.sql) =====\n" + nl(pilot)
               + nl(verify) + EXTRA_VERIFY)
    OUT.mkdir(exist_ok=True)
    (OUT / "payload.sql").write_text(payload)
    man = {
        "migration_name": MIGRATION_NAME,
        "target_project_ref": "nppznoujvnyjargjkmnv",
        "source_pr": 529,
        "source_sha": "809093ee09c46ff7ecb588cdc30266465d018c0b",
        "payload_sha256": sha(OUT / "payload.sql"),
        "payload_bytes": (OUT / "payload.sql").stat().st_size,
        "migration_sha256": sha(MIG),
        "pilot_insert_sha256": sha(PILOT),
        "operator_sql_sha256": sha(OPERATOR),
        "receipt_inserts": pilot.count("insert into public.market_outcome_provider_receipts"),
        "revision_inserts": pilot.count("insert into public.market_outcome_revisions"),
        "transaction_control": False,
        "writes_supabase_migrations": False,
    }
    (OUT / "manifest.json").write_text(json.dumps(man, indent=1) + "\n")
    print(json.dumps(man, indent=1))


main()
