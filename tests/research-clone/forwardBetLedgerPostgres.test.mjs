// Real-Postgres semantic proof of the DBClone forward-BET contract (immutability, DB-owned time, economic unit,
// settlement authority). Runs only when PREMVP_TEST_PSQL points at a throwaway Postgres superuser connection, e.g.
//   PREMVP_TEST_PSQL="psql -h /tmp -p 54329 -U postgres" npm run test:research-clone-forward-bet
// It never touches Supabase: each run creates and drops its own scratch database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test, before, after } from 'node:test';

const PSQL = process.env.PREMVP_TEST_PSQL;
const skip = PSQL ? false : 'PREMVP_TEST_PSQL not set (throwaway Postgres required)';
const DB = `forward_bet_${process.pid}_${Date.now()}`;
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

function psql(db, text, { file = false } = {}) {
  const parts = PSQL.split(' ');
  const args = [...parts.slice(1), '-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-d', db, ...(file ? ['-f', text] : ['-c', text])];
  const result = spawnSync(parts[0], args, { encoding: 'utf8' });
  return { ok: result.status === 0, out: result.stdout.trim(), err: `${result.stderr}`.trim() };
}
const q = (text) => psql(DB, text);
function ok(text) { const r = q(text); assert.equal(r.ok, true, `${text}\n${r.err}`); return r.out; }
function fails(text, pattern) { const r = q(text); assert.equal(r.ok, false, `expected failure: ${text}`); assert.match(r.err, pattern); }

const BASE = `insert into prospective_selection_shadow_runtime(row_key,row_kind,model_id,decision_date,candidate_identity,physical_event_key,decision_timestamp,event_start,entry_price,sport_family,condition_id,selected_token_id,settlement_state`;
function contractInsert(key, { model = 'P50_52_SAFE', game = `G-${key}`, observed = "now() - interval '5 minutes'", decided = 'now()', scheduled = "now() + interval '3 hours'", authoritative = 'null', family = "'MONEYLINE'", extra = '', extraCols = '', timing = '', onConflict = '' } = {}) {
  return `${BASE},contract_version,canonical_game_key,provider_event_id,market_family,market_type,period_scope,selected_outcome,observed_at,decision_generated_at,scheduled_start_at,authoritative_start_at,reference_price,reference_price_source,reference_price_type,reference_price_acquired_at,model_version,selection_reason,decision_kind,economic_unit_key${extraCols})
  values ('${key}','LEDGER','${model}','2026-10-12','id-${key}','${game}',now(),now() + interval '3 hours',0.505,'tennis','0xcond-${key}','tok-${key}','UNQUERIED','FORWARD_BET_V1','tennis:${game}','${game}',${family},'moneyline','FULL_MATCH','Player A',${observed},${decided},${scheduled},${authoritative},0.505,'src','EVIDENCE_REFERENCE_NOT_EXECUTABLE',${observed},'${model}@v1','reason','BET','tennis:${game}'${extra}) ${onConflict}`;
}

before(() => {
  if (skip) return;
  const created = psql('postgres', `create database ${DB}`);
  assert.equal(created.ok, true, created.err);
  for (const role of ['service_role', 'anon', 'authenticated']) {
    assert.equal(psql(DB, `do $do$ begin if not exists (select 1 from pg_roles where rolname='${role}') then create role ${role}; end if; end $do$`).ok, true);
  }
  for (const sql of [
    read('ops/research-clone/prospective-selection-shadow-runtime-schema.sql'),
    read('ops/research-clone/migrations/20261012150000_prospective_shadow_first_persistence.sql'),
    read('ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql'),
  ]) {
    const wrapped = `begin;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '45s';\n${sql}\ncommit;\n`;
    const path = new URL(`../../.forward-bet-test-${process.pid}.sql`, import.meta.url);
    fs.writeFileSync(path, wrapped);
    try { const r = psql(DB, path.pathname, { file: true }); assert.equal(r.ok, true, r.err); } finally { fs.rmSync(path); }
  }
});
after(() => { if (!skip) psql('postgres', `drop database if exists ${DB}`); });

test('legacy-shaped inserts keep working, get DB time, and can never carry forward fields', { skip }, () => {
  ok(`${BASE}) values ('L1','LEDGER','P50_52_SAFE','2026-09-21','l1','LEGACY-EV',now(),now(),0.5,'tennis','0xl1','tl1','UNQUERIED')`);
  assert.match(ok("select first_persisted_at is not null, contract_version is null from prospective_selection_shadow_runtime where row_key='L1'"), /^t\|t$/);
  fails(`${BASE},timing_class) values ('L2','LEDGER','P50_52_SAFE','2026-09-21','l2','LEGACY-EV2',now(),now(),0.5,'tennis','0xl2','tl2','UNQUERIED','PRE_START_AUTHORITATIVE')`, /FORWARD_FIELDS_REQUIRE_CONTRACT_VERSION/);
  fails(`update prospective_selection_shadow_runtime set contract_version='FORWARD_BET_V1' where row_key='L1'`, /IMMUTABLE_SHADOW_CHOICE|forward_contract_ck/);
  fails(`update prospective_selection_shadow_runtime set timing_class='PRE_START_AUTHORITATIVE' where row_key='L1'`, /IMMUTABLE_SHADOW_CHOICE/);
});

test('contract insert: DB owns first-save time, lead time, timing class and completeness', { skip }, () => {
  ok(contractInsert('C1', { extraCols: ',timing_class,lead_time_scheduled_seconds,first_persisted_at', extra: ",'PRE_START_AUTHORITATIVE',999999,'2020-01-01T00:00:00Z'" }));
  const row = ok("select timing_class, contract_status, round(lead_time_scheduled_seconds)::int between 10700 and 10800, lead_time_authoritative_seconds is null, round(observation_lag_seconds)::int between 299 and 305, first_persisted_at > now() - interval '1 minute', executable_buy_price is null from prospective_selection_shadow_runtime where row_key='C1'");
  assert.equal(row, 'PRE_START_SCHEDULED_ONLY|COMPLETE|t|t|t|t|t');
});

test('timing classes: late, unknown start, replay, reschedule and authoritative start are distinguished', { skip }, () => {
  const cases = [
    ['T-LATE', { scheduled: "now() - interval '10 minutes'" }, 'LATE_SCHEDULED'],
    ['T-UNK', { scheduled: 'null' }, 'START_UNKNOWN'],
    ['T-REPLAY', { observed: "now() - interval '5 hours'", decided: "now() - interval '5 hours'" }, 'HISTORICAL_REPLAY'],
    ['T-AUTH', { authoritative: "now() + interval '1 hour'" }, 'PRE_START_AUTHORITATIVE'],
    // scheduled start already past but authoritative (rescheduled) start still ahead: proven only through the authoritative boundary
    ['T-RESCHED', { scheduled: "now() - interval '1 hour'", authoritative: "now() + interval '2 hours'" }, 'PRE_START_AUTHORITATIVE'],
    // scheduled start ahead but verified actual start already passed: never "proven pre-kickoff"
    ['T-EARLYSTART', { scheduled: "now() + interval '2 hours'", authoritative: "now() - interval '5 minutes'" }, 'LATE_AUTHORITATIVE'],
  ];
  for (const [key, options, expected] of cases) {
    ok(contractInsert(key, options));
    assert.equal(ok(`select timing_class from prospective_selection_shadow_runtime where row_key='${key}'`), expected, key);
  }
});

test('time-travel and incomplete contracts fail closed', { skip }, () => {
  fails(contractInsert('F1', { decided: "now() + interval '10 minutes'" }), /DECISION_TIME_IN_FUTURE/);
  fails(contractInsert('F2', { observed: "now() + interval '10 minutes'", decided: 'now()' }), /OBSERVATION_AFTER_DECISION/);
  ok(contractInsert('INC', { family: 'null' }));
  assert.equal(ok("select contract_status from prospective_selection_shadow_runtime where row_key='INC'"), 'INCOMPLETE:market_family');
  ok(contractInsert('INC2', { family: "'TOTAL'" }));
  assert.equal(ok("select contract_status from prospective_selection_shadow_runtime where row_key='INC2'"), 'INCOMPLETE:line_value');
});

test('executable BUY price needs an explicit authority; a missing book is never a price', { skip }, () => {
  fails(contractInsert('E1', { extraCols: ',executable_buy_price', extra: ',0.51' }), /forward_contract_ck/);
  fails(contractInsert('E2', { extraCols: ',executable_price_authority', extra: ",'CLOB_BEST_ASK'" }), /forward_contract_ck/);
  fails(contractInsert('E3', { extraCols: ',executable_buy_price,executable_price_authority,executable_quote_at', extra: ",0.51,'GAMMA_DISPLAY',now()" }), /forward_contract_ck/);
  ok(contractInsert('E4', { extraCols: ',executable_buy_price,executable_price_authority,executable_quote_at', extra: ",0.51,'CLOB_BEST_ASK',now()" }));
});

test('first persistence is immutable: no UPDATE of choice fields, no DELETE, no TRUNCATE; settlement columns stay writable', { skip }, () => {
  for (const column of ["reference_price=0.4", "condition_id='x'", "selected_token_id='x'", "scheduled_start_at=now()", "authoritative_start_at=now()", "first_persisted_at=now()", "contract_status='INCOMPLETE:x'", "observed_at=now()", "economic_unit_key='z'", "executable_buy_price=0.5"]) {
    fails(`update prospective_selection_shadow_runtime set ${column} where row_key='C1'`, /IMMUTABLE_SHADOW_CHOICE|forward_contract_ck/);
  }
  ok("update prospective_selection_shadow_runtime set settlement_state='WIN', result='WIN', settled_at=now() where row_key='C1'");
  fails("delete from prospective_selection_shadow_runtime where row_key='C1'", /IMMUTABLE_SHADOW_CHOICE/);
  fails('truncate prospective_selection_shadow_runtime', /IMMUTABLE_SHADOW_LEDGER_TRUNCATE|cannot truncate a table referenced/);
});

test('one model x physical game is one economic unit across dates, legacy rows included; replays are idempotent', { skip }, () => {
  ok(contractInsert('U1', { game: 'EV-UNIT' }));
  fails(contractInsert('U2', { game: 'EV-UNIT' }).replace("'2026-10-12'", "'2026-10-13'"), /DUPLICATE_ECONOMIC_UNIT/);
  ok(contractInsert('U3', { game: 'EV-UNIT', model: 'QUALITY_FILL_D_SAFE' }));
  fails(contractInsert('U4', { game: 'LEGACY-EV' }), /DUPLICATE_ECONOMIC_UNIT/);
  ok(contractInsert('U1', { game: 'EV-UNIT', onConflict: 'on conflict (row_key) do nothing' }));
  assert.equal(ok("select count(*) from prospective_selection_shadow_runtime where physical_event_key='EV-UNIT' and model_id='P50_52_SAFE'"), '1');
});


test('settlement authority: exact identity, one terminal outcome, append-only history with conflicts', { skip }, () => {
  const insert = (bet, cond, tok, kind, outcome, source, indep, winner, closed, reason, digest, tail = '') =>
    `insert into virtual_bet_settlement_authority(bet_row_key,condition_id,selected_token_id,check_kind,outcome,source_authority,independent_of_selection,winner_token_id,provider_closed,reason,provider_digest${tail ? ',checked_at' : ''}) values ('${bet}','${cond}','${tok}','${kind}','${outcome}','${source}',${indep},${winner},${closed},'${reason}','${digest}'${tail ? `,'2020-01-01T00:00:00Z'` : ''})`;
  fails(insert('L1', '0xl1', 'tl1', 'TERMINAL', 'WIN', 'CLOB_WINNER_TOKEN', true, "'tl1'", true, 'r', 'd'), /SETTLEMENT_REQUIRES_FORWARD_CONTRACT_BET/);
  fails(insert('C1', '0xcond-C1', 'other-token', 'TERMINAL', 'LOSS', 'CLOB_WINNER_TOKEN', true, "'tok-C1'", true, 'r', 'd'), /SETTLEMENT_EXACT_IDENTITY_MISMATCH/);
  fails(insert('C1', '0xcond-C1', 'tok-C1', 'TERMINAL', 'WIN', 'CLOB_WINNER_TOKEN', true, "'someone-else'", true, 'r', 'd'), /check/);
  fails(insert('C1', '0xcond-C1', 'tok-C1', 'TERMINAL', 'WIN', 'GAMMA_AUXILIARY', false, "'tok-C1'", true, 'r', 'd'), /check/);
  ok(insert('C1', '0xcond-C1', 'tok-C1', 'PENDING', 'UNKNOWN', 'NONE', false, 'null', false, 'MARKET_NOT_CLOSED', 'd0'));
  ok(insert('C1', '0xcond-C1', 'tok-C1', 'TERMINAL', 'WIN', 'CLOB_WINNER_TOKEN', true, "'tok-C1'", true, 'CLOB_EXACT_WINNER_TOKEN', 'd1', 'clientclock'));
  assert.equal(ok("select checked_at > now() - interval '1 minute' from virtual_bet_settlement_authority where check_kind='TERMINAL'"), 't');
  fails(insert('C1', '0xcond-C1', 'tok-C1', 'TERMINAL', 'WIN', 'CLOB_WINNER_TOKEN', true, "'tok-C1'", true, 'again', 'd1'), /one_terminal_uidx/);
  fails(insert('C1', '0xcond-C1', 'tok-C1', 'TERMINAL', 'LOSS', 'CLOB_WINNER_TOKEN', true, "'x'", true, 'flip', 'd2'), /one_terminal_uidx/);
  const terminalId = ok("select check_id from virtual_bet_settlement_authority where check_kind='TERMINAL'");
  ok(`insert into virtual_bet_settlement_authority(bet_row_key,condition_id,selected_token_id,check_kind,outcome,source_authority,independent_of_selection,winner_token_id,provider_closed,reason,provider_digest,conflicts_with_check_id) values ('C1','0xcond-C1','tok-C1','CONFLICT','LOSS','CLOB_WINNER_TOKEN',true,'x',true,'CONFLICT_WITH_TERMINAL:CLOB_EXACT_WINNER_TOKEN','d2',${terminalId})`);
  fails("update virtual_bet_settlement_authority set outcome='LOSS'", /IMMUTABLE_SETTLEMENT_AUTHORITY/);
  fails('delete from virtual_bet_settlement_authority', /IMMUTABLE_SETTLEMENT_AUTHORITY/);
  fails('truncate virtual_bet_settlement_authority', /IMMUTABLE_SETTLEMENT_AUTHORITY/);
  assert.equal(ok("select count(*) filter (where check_kind='TERMINAL'), count(*) from virtual_bet_settlement_authority"), '1|3');
});

test('grants: service_role cannot delete/truncate the ledger or update/delete settlement history; anon sees nothing', { skip }, () => {
  assert.equal(ok("select has_table_privilege('service_role','prospective_selection_shadow_runtime','DELETE'), has_table_privilege('service_role','prospective_selection_shadow_runtime','TRUNCATE'), has_table_privilege('service_role','virtual_bet_settlement_authority','UPDATE'), has_table_privilege('service_role','virtual_bet_settlement_authority','DELETE'), has_table_privilege('service_role','virtual_bet_settlement_authority','INSERT'), has_table_privilege('anon','virtual_bet_settlement_authority','SELECT')"), 'f|f|f|f|t|f');
});

test('migration is idempotent against an already-migrated database', { skip }, () => {
  const sql = `begin;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '45s';\n${read('ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql')}\ncommit;\n`;
  const path = new URL(`../../.forward-bet-test-rerun-${process.pid}.sql`, import.meta.url);
  fs.writeFileSync(path, sql);
  try { const r = psql(DB, path.pathname, { file: true }); assert.equal(r.ok, true, r.err); } finally { fs.rmSync(path); }
  assert.equal(ok("select count(*) from prospective_selection_shadow_runtime where row_key='C1'"), '1');
});
