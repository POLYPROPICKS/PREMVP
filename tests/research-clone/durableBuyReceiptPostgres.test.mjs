// Disposable localhost PostgreSQL only. No Supabase credentials or remote connection strings are accepted.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const enabled = process.env.PREMVP_DISPOSABLE_RECEIPT_TEST === '1';
const skip = enabled ? false : 'explicit disposable PostgreSQL opt-in required';
const bin = process.env.PREMVP_DISPOSABLE_PSQL ?? 'psql';
const db = `receipt_v1_${process.pid}_${Date.now()}`;
const args = (database) => ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '65439', '-U', 'postgres', '-d', database];
function run(sql, database = db) {
  const r = spawnSync(bin, args(database), { input: sql, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), error: (r.stderr ?? '').trim() };
}
function ok(sql, database = db) { const r = run(sql, database); assert.equal(r.ok, true, r.error); return r.out; }
function fails(sql, pattern) { const r = run(sql); assert.equal(r.ok, false, r.out); assert.match(r.error, pattern); }
const file = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const literal = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const call = (f, id = f.id) => `select public.record_forward_buy_attempt_v1('${id}',${literal(f.ledger)},${literal(f.evidence)},${f.reject ? `'${f.reject}'` : 'null'});`;
const result = (f, id) => JSON.parse(ok(call(f, id)));
function fixture(name = randomUUID()) {
  const now = Date.now(), iso = (delta) => new Date(now + delta).toISOString();
  const condition = `condition-${name}`, token = `token-${name}`, observed = iso(-5000), unit = `football:${name}`;
  const receipt = {
    version: 'FORWARD_BUY_V1', stakeLedger: 'FORWARD_BUY_VIRTUAL_USD_2_50', model: 'P50_52_SAFE',
    conditionId: condition, selectedTokenId: token, economicUnitKey: unit, selectionObservedAt: observed,
    referencePrice: 0.5, stakeUsd: 2.5, shares: 5, vwap: 0.5, bestAsk: 0.5, depthLevelsUsed: 1, depthAvailableUsd: 50,
    fee: { usd: 0.0375, rate: 0.03, formulaVersion: 'POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1', source: 'GAMMA_MARKETS_BY_CLOB_TOKEN_ID', observedAt: iso(-500) },
    allInCostUsd: 2.5375, minOrderSize: 5, tickSize: 0.01,
    quote: { requestStartedAt: iso(-2000), receivedAt: iso(-1000), providerTimestamp: iso(-1500) }, decisionAt: iso(0),
  };
  const ledger = {
    row_key: `LEDGER:P50_52_SAFE:${name}`, row_kind: 'LEDGER', model_id: 'P50_52_SAFE', decision_date: observed.slice(0, 10),
    candidate_identity: `${condition}::${token}::${observed}`, physical_event_key: unit, decision_timestamp: observed,
    event_start: iso(3600000), entry_price: 0.5, sport_family: 'football', condition_id: condition, selected_token_id: token,
    contract_version: 'FORWARD_BET_V1', canonical_game_key: unit, game_identity_basis: 'TEAM_PAIR_START_DEDUP', scope_basis: 'STRUCTURED_MONEYLINE',
    provider_event_id: name, market_family: 'MONEYLINE', market_type: 'moneyline', period_scope: 'FULL_MATCH', selected_outcome: 'Home',
    observed_at: observed, decision_generated_at: receipt.decisionAt, scheduled_start_at: iso(3600000),
    reference_price: 0.5, reference_price_source: 'RESEARCH_EVIDENCE_PAGE', reference_price_type: 'EVIDENCE_REFERENCE_NOT_EXECUTABLE',
    reference_price_acquired_at: observed, provider_quote_at: receipt.quote.providerTimestamp,
    executable_buy_price: 0.5, executable_price_authority: 'CLOB_DEPTH_VWAP', executable_quote_at: receipt.quote.receivedAt,
    model_version: 'P50_52_SAFE@v1', selection_reason: 'frozen selection fixture', decision_kind: 'BET', economic_unit_key: unit,
  };
  const evidence = { receipt, source: { observationId: name, itemObservationId: name },
    book: { asset_id: token, market: condition, min_order_size: 5, tick_size: 0.01, asks: [{ price: 0.5, size: 100 }] },
  };
  ok(`insert into public.research_evidence_page_rows values ('${name}','${name}','${condition}','${token}','${observed}',0.5,'PRODUCTION_RESEARCH_EVIDENCE_PAGE','moneyline');`);
  return { id: randomUUID(), ledger, evidence };
}
function concurrent(sql) {
  return new Promise((resolve) => {
    const child = spawn(bin, args(db), { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', error = '';
    child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { error += b; });
    child.on('close', (status) => resolve({ ok: status === 0, out: out.trim(), error })); child.stdin.end(sql);
  });
}

before(() => {
  if (!enabled) return;
  assert.match(ok('show data_directory;', 'postgres').replaceAll('\\', '/'), /\/disposable-receipt-pg$/);
  assert.equal(ok('select host(inet_server_addr());', 'postgres'), '127.0.0.1');
  ok(`create database ${db};`, 'postgres');
  ok(`do $$ begin if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin; end if; end $$;`);
  for (const p of ['ops/research-clone/prospective-selection-shadow-runtime-schema.sql', 'ops/research-clone/migrations/20261012150000_prospective_shadow_first_persistence.sql', 'ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql']) ok(`begin; set local lock_timeout='5s'; set local statement_timeout='45s'; ${file(p)} commit;`);
  ok(`create table public.research_evidence_page_rows(observation_id text,item_observation_id text,condition_id text,selected_token_id text,observed_at timestamptz,entry_price_num numeric,source_kind text,market_type text,primary key(observation_id,item_observation_id)); grant select on public.research_evidence_page_rows to service_role;`);
  ok(file('ops/research-clone/proposals/forward-buy-receipt-v1.sql'));
});
after(() => { if (enabled && /^receipt_v1_\d+_\d+$/.test(db)) ok(`drop database if exists ${db} with (force);`, 'postgres'); });

test('atomic accepted receipt has DB-owned digest, exact mapping and five-share fill', { skip }, () => {
  const f = fixture(); const r = result(f);
  assert.equal(r.status, 'ACCEPTED'); assert.equal(r.ledgerRowKey, f.ledger.row_key); assert.match(r.receiptDigest, /^[0-9a-f]{64}$/);
  assert.equal(ok(`select count(*) from public.forward_buy_receipt_attempts where attempt_id='${f.id}' and receipt_digest=encode(sha256(convert_to(receipt_canonical,'UTF8')),'hex');`), '1');
  assert.equal(ok(`select count(*) from public.prospective_selection_shadow_runtime where row_key='${f.ledger.row_key}' and executable_buy_price=0.5;`), '1');
});
test('same attempt replays original evidence; changed content never overwrites it', { skip }, () => {
  const f = fixture(); const first = result(f); const replay = result(f);
  assert.equal(replay.status, 'REPLAY'); assert.equal(replay.receiptDigest, first.receiptDigest);
  f.evidence.receipt.depthAvailableUsd = 51;
  fails(call(f), /ATTEMPT_ID_CONFLICT/);
});
test('two concurrent same-attempt calls produce one acceptance and one replay', { skip }, async () => {
  const f = fixture(); const rows = await Promise.all([concurrent(call(f)), concurrent(call(f))]);
  for (const r of rows) assert.equal(r.ok, true, r.error);
  assert.deepEqual(rows.map((r) => JSON.parse(r.out).status).sort(), ['ACCEPTED', 'REPLAY']);
});
test('two concurrent attempts for one economic unit cannot produce duplicate positions', { skip }, async () => {
  const f = fixture(); const g = structuredClone(f); g.id = randomUUID(); g.ledger.row_key += ':competitor';
  const rows = await Promise.all([concurrent(call(f)), concurrent(call(g))]);
  for (const r of rows) assert.equal(r.ok, true, r.error);
  assert.deepEqual(rows.map((r) => JSON.parse(r.out).status).sort(), ['ACCEPTED', 'REJECTED']);
});
test('same row and VWAP with another quote yields rejection, never receipt adoption', { skip }, () => {
  const f = fixture(); result(f); const g = structuredClone(f); g.id = randomUUID();
  g.evidence.receipt.quote.receivedAt = new Date(Date.parse(g.evidence.receipt.quote.receivedAt) - 100).toISOString();
  g.ledger.executable_quote_at = g.evidence.receipt.quote.receivedAt;
  const r = result(g); assert.equal(r.status, 'REJECTED'); assert.equal(r.rejectionReason, 'LEDGER_KEY_CONFLICT'); assert.equal(r.ledgerRowKey, null);
});
test('transaction rollback leaves no ledger or receipt orphan', { skip }, () => {
  const f = fixture(); ok(`begin; ${call(f)} rollback;`);
  assert.equal(ok(`select count(*) from public.forward_buy_receipt_attempts where attempt_id='${f.id}';`), '0');
  assert.equal(ok(`select count(*) from public.prospective_selection_shadow_runtime where row_key='${f.ledger.row_key}';`), '0');
});
test('immutable rows reject update/delete/truncate even for privileged writers', { skip }, () => {
  const f = fixture(); result(f);
  fails(`update public.forward_buy_receipt_attempts set rejection_reason='BOOK_UNAVAILABLE' where attempt_id='${f.id}';`, /IMMUTABLE_BUY_RECEIPT/);
  fails(`delete from public.forward_buy_receipt_attempts where attempt_id='${f.id}';`, /IMMUTABLE_BUY_RECEIPT/);
  fails('truncate public.forward_buy_receipt_attempts;', /IMMUTABLE_BUY_RECEIPT/);
});
test('public roles cannot read or invoke; service role has no update/delete/truncate', { skip }, () => {
  for (const role of ['anon', 'authenticated']) {
    fails(`set role ${role}; select count(*) from public.forward_buy_receipt_attempts;`, /permission denied/);
    fails(`set role ${role}; select public.record_forward_buy_attempt_v1(gen_random_uuid(),'{}','{}',null);`, /permission denied/);
  }
  assert.equal(ok(`select has_table_privilege('service_role','public.forward_buy_receipt_attempts','UPDATE') or has_table_privilege('service_role','public.forward_buy_receipt_attempts','DELETE') or has_table_privilege('service_role','public.forward_buy_receipt_attempts','TRUNCATE');`), 'f');
  const f = fixture(); assert.equal(JSON.parse(ok(`set role service_role; ${call(f)}`)).status, 'ACCEPTED');
});
test('stale/missing evidence and below-minimum fills persist rejected attempts only', { skip }, () => {
  for (const kind of ['missing', 'stale', 'minimum', 'source', 'depth', 'stake']) {
    const f = fixture();
    if (kind === 'missing') f.evidence = {};
    if (kind === 'stale') { f.evidence.receipt.quote.receivedAt = new Date(Date.now() - 120000).toISOString(); f.ledger.executable_quote_at = f.evidence.receipt.quote.receivedAt; }
    if (kind === 'minimum') f.evidence.book.min_order_size = 6;
    if (kind === 'source') f.evidence.source.observationId = 'not-persisted';
    if (kind === 'depth') f.evidence.book.asks[0].size = 1;
    if (kind === 'stake') f.evidence.receipt.stakeUsd = 3;
    const r = result(f); assert.equal(r.status, 'REJECTED', kind); assert.ok(r.rejectionReason, kind);
    assert.equal(ok(`select count(*) from public.prospective_selection_shadow_runtime where row_key='${f.ledger.row_key}';`), '0');
  }
});
test('deferred integrity check prevents an executable row without a matching receipt', { skip }, () => {
  const f = fixture(); result(f);
  fails(`begin; set constraints all deferred; insert into public.prospective_selection_shadow_runtime(row_key,row_kind,model_id,decision_date,candidate_identity,decision_timestamp,entry_price,settlement_state,contract_version) values ('orphan','LEDGER','P50_52_SAFE',current_date,'x',now(),0.5,'UNQUERIED','FORWARD_BET_V1'); commit;`, /DECISION_TIME|OBSERVATION|forward_contract|not-null/);
  // A directly forged accepted receipt cannot bind to the existing valid row with different economics.
  fails(`insert into public.forward_buy_receipt_attempts(attempt_id,ledger_payload,quote_evidence,outcome,ledger_row_key) values(gen_random_uuid(),${literal({ ...f.ledger, executable_buy_price: 0.49 })},${literal(f.evidence)},'ACCEPTED','${f.ledger.row_key}');`, /RECEIPT_EVIDENCE_REJECTED|BUY_RECEIPT_LINK_MISMATCH/);
});

test('settlement authority is separate: terminal WIN neither creates nor alters the receipt or executable economics', { skip }, () => {
  const f = fixture(); const accepted = result(f);
  const before = ok(`select receipt_digest||':'||count(*) over () from public.forward_buy_receipt_attempts where attempt_id='${f.id}';`);
  ok(`insert into public.virtual_bet_settlement_authority(bet_row_key,condition_id,selected_token_id,check_kind,outcome,source_authority,independent_of_selection,winner_token_id,provider_closed,reason,provider_digest) values('${f.ledger.row_key}','${f.ledger.condition_id}','${f.ledger.selected_token_id}','TERMINAL','WIN','CLOB_WINNER_TOKEN',true,'${f.ledger.selected_token_id}',true,'fixture','d');`);
  assert.equal(ok(`select receipt_digest||':'||count(*) over () from public.forward_buy_receipt_attempts where attempt_id='${f.id}';`), before);
  assert.equal(ok(`select count(*) from public.forward_buy_receipt_attempts;`) >= '1', true);
  assert.equal(ok(`select executable_buy_price from public.prospective_selection_shadow_runtime where row_key='${f.ledger.row_key}';`), '0.5');
  assert.equal(accepted.ledgerRowKey, f.ledger.row_key);
  fails(`update public.virtual_bet_settlement_authority set outcome='LOSS' where bet_row_key='${f.ledger.row_key}';`, /IMMUTABLE_SETTLEMENT_AUTHORITY/);
  fails(`update public.prospective_selection_shadow_runtime set executable_buy_price=0.4 where row_key='${f.ledger.row_key}';`, /IMMUTABLE_SHADOW_CHOICE/);
  fails(`insert into public.virtual_bet_settlement_authority(bet_row_key,condition_id,selected_token_id,check_kind,outcome,source_authority,independent_of_selection,winner_token_id,reason,provider_digest) values('${f.ledger.row_key}','${f.ledger.condition_id}','${f.ledger.selected_token_id}','TERMINAL','LOSS','CLOB_WINNER_TOKEN',true,null,'second terminal','d2');`, /virtual_bet_settlement_one_terminal_uidx|duplicate key/);
});
test('accepted + rejected attempts reconcile to total attempts; rejected ones never own a ledger row', { skip }, () => {
  const total0 = Number(ok(`select count(*) from public.forward_buy_receipt_attempts;`));
  const a = fixture(), b = fixture(), c = fixture(); b.evidence.book.asks[0].size = 1; c.evidence = {};
  const outs = [a, b, c].map((f) => result(f).status);
  assert.deepEqual(outs, ['ACCEPTED', 'REJECTED', 'REJECTED']);
  assert.equal(Number(ok(`select count(*) from public.forward_buy_receipt_attempts;`)) - total0, 3);
  assert.equal(ok(`select count(*) from public.forward_buy_receipt_attempts where attempt_id in ('${a.id}','${b.id}','${c.id}') and ((outcome='ACCEPTED' and ledger_row_key is not null) or (outcome='REJECTED' and ledger_row_key is null and rejection_reason is not null));`), '3');
  assert.equal(ok(`select count(*) from public.prospective_selection_shadow_runtime where row_key in ('${b.ledger.row_key}','${c.ledger.row_key}');`), '0');
});
test('minimum-size fail-closed: unknown minimum, sub-minimum fill and sub-minimum encoded order never produce a BUY', { skip }, () => {
  const variants = {
    unknownMinimum: (f) => { delete f.evidence.book.min_order_size; },
    subMinimumFill: (f) => { f.evidence.book.asks[0].price = 0.6; f.evidence.receipt.vwap = 0.6; f.evidence.receipt.bestAsk = 0.6; f.evidence.receipt.shares = 2.5 / 0.6; },
    nullMinimum: (f) => { f.evidence.book.min_order_size = null; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const f = fixture(); mutate(f);
    const r = result(f); assert.equal(r.status, 'REJECTED', name); assert.ok(r.rejectionReason, name);
    assert.equal(ok(`select count(*) from public.prospective_selection_shadow_runtime where row_key='${f.ledger.row_key}';`), '0', name);
  }
});
