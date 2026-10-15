import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { PGlite } = await import(process.env.BLIND_TEST_PGLITE_MODULE
  ? pathToFileURL(process.env.BLIND_TEST_PGLITE_MODULE).href : "@electric-sql/pglite");
const sql = fs.readFileSync(path.resolve("ops/research-clone/migrations/20261015081609_restore_blind_horizon_forward_v1.sql"), "utf8");

test("BLIND DB-clock snapshot, least privilege and immutable receipt", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls; create role blind_model_reader;
      create schema blind_obs;
      create table blind_obs.model_horizon(singleton boolean primary key default true check(singleton),as_of timestamptz not null,set_by text default session_user,set_at timestamptz default clock_timestamp());
      alter table blind_obs.model_horizon enable row level security;
      create table public.research_evidence_page_rows(
        observation_id uuid,item_observation_id uuid,observed_at timestamptz,ingested_at timestamptz,
        condition_id text,selected_token_id text,provider_event_id text,provider_sport_family text,
        market_family text,market_type text,game_start_iso text,entry_price_num numeric,pre_event_score_num numeric,
        signal_confidence_num numeric,formula_version text,metric_formula_version text,selected_outcome text,
        data_coverage numeric,signal_result text);
      create view blind_obs.prematch_observations_v1 as select signal_result from public.research_evidence_page_rows;
      create view blind_obs.inplay_observations_v1 as select signal_result from public.research_evidence_page_rows;
      create view blind_obs.t20_observations_v1 as select signal_result from public.research_evidence_page_rows;
      grant usage on schema blind_obs to blind_model_reader;
      grant select on blind_obs.prematch_observations_v1,blind_obs.inplay_observations_v1,blind_obs.t20_observations_v1 to blind_model_reader;
      insert into public.research_evidence_page_rows values
        ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011',now()-interval '1 minute',now()-interval '30 seconds',
         'condition','token','event','soccer','MONEYLINE','MONEYLINE',(now()+interval '4 hours')::text,.5,70,70,'frozen-formula','frozen-metric','YES',80,'FORBIDDEN_RESULT');
      insert into public.research_evidence_page_rows select observation_id,'00000000-0000-4000-8000-000000000012',observed_at,now()+interval '1 day',
         condition_id,'future-ingest',provider_event_id,provider_sport_family,market_family,market_type,game_start_iso,entry_price_num,
         pre_event_score_num,signal_confidence_num,formula_version,metric_formula_version,selected_outcome,data_coverage,signal_result from public.research_evidence_page_rows limit 1;
      insert into public.research_evidence_page_rows select observation_id,'00000000-0000-4000-8000-000000000013',observed_at,ingested_at,
         condition_id,'late-window',provider_event_id,provider_sport_family,market_family,market_type,(now()+interval '30 minutes')::text,entry_price_num,
         pre_event_score_num,signal_confidence_num,formula_version,metric_formula_version,selected_outcome,data_coverage,signal_result from public.research_evidence_page_rows limit 1;
      insert into public.research_evidence_page_rows select observation_id,'00000000-0000-4000-8000-000000000014',observed_at,ingested_at,
         condition_id,'invalid-date',provider_event_id,provider_sport_family,market_family,market_type,'not-a-date',entry_price_num,
         pre_event_score_num,signal_confidence_num,formula_version,metric_formula_version,selected_outcome,data_coverage,signal_result from public.research_evidence_page_rows limit 1;
    `);
    await db.exec(sql);
    const receipt = (await db.query("select receipt_id,as_of,source_received_at,source_rows from blind_obs.horizon_receipts_v1")).rows[0];
    assert.equal(receipt.source_rows.length,1);
    assert.ok(new Date(receipt.source_received_at) <= new Date(receipt.as_of));
    assert.equal(receipt.source_rows[0].selected_token_id,"token");
    assert.ok(!JSON.stringify(receipt).includes("FORBIDDEN_RESULT"));
    assert.ok(!Object.hasOwn(receipt.source_rows[0],"signal_result"));
    await db.exec("update public.research_evidence_page_rows set pre_event_score_num=1,signal_result='LATER_OUTCOME'");
    await db.exec("set role service_role");
    const read = (await db.query("select public.research_blind_read_horizon_v1($1) as receipt",[receipt.receipt_id])).rows[0].receipt;
    assert.equal(read.source_rows[0].pre_event_score_num,70);
    assert.equal((await db.query("select count(*)::int as n from blind_obs.scored_prematch_observations_v1")).rows[0].n,1);
    await assert.rejects(db.exec("update blind_obs.model_horizon set as_of='2000-01-01'"),/permission denied/);
    await assert.rejects(db.exec("delete from blind_obs.horizon_receipts_v1"),/permission denied/);
    await db.exec("reset role; set role anon");
    await assert.rejects(db.exec("select public.research_blind_freeze_horizon_v1()"),/permission denied/);
    await assert.rejects(db.query("select public.research_blind_read_horizon_v1($1)",[receipt.receipt_id]),/permission denied/);
    await db.exec("reset role; set role blind_model_reader");
    await assert.rejects(db.exec("select signal_result from public.research_evidence_page_rows"),/permission denied/);
    await assert.rejects(db.exec("select signal_result from blind_obs.inplay_observations_v1"),/permission denied/);
    assert.equal((await db.query("select count(*)::int as n from blind_obs.scored_prematch_observations_v1")).rows[0].n,1);
    await db.exec("reset role");
    await assert.rejects(db.exec("update blind_obs.horizon_receipts_v1 set as_of=clock_timestamp()"),/IMMUTABLE_BLIND_HORIZON_RECEIPT/);
    const first = receipt.as_of;
    await db.exec("set role service_role; select public.research_blind_freeze_horizon_v1(); reset role");
    const all=(await db.query("select as_of from blind_obs.horizon_receipts_v1 order by as_of")).rows;
    assert.equal(all.length,2);
    assert.ok(new Date(all[1].as_of)>=new Date(first));
    assert.equal((await db.query("select count(*)::int as n from blind_obs.model_horizon")).rows[0].n,1);
  } finally { await db.close(); }
});
