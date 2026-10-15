import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assertCloneSqlSafe } from '../../scripts/control-plane/lib/premvp-migration-https-transport.mjs';

const sql = fs.readFileSync(new URL('../../ops/research-clone/inplay-paper-terminal-freeze-schema.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('only the exact reviewed freeze bundle is admitted; generic DDL and body mutations fail closed', () => {
  assert.equal(assertCloneSqlSafe(sql).statements_n, 3);
  assert.equal(assertCloneSqlSafe(sql.replace(/\n/g, '\r\n')).statements_n, 3);
  for (const unsafe of [sql.replace('clock_timestamp()', 'now()'), sql.replace('security invoker', 'security definer'), sql + '\nselect 1;', sql.replace('public.research_inplay_paper_decisions\n', 'public.other_table\n'),
    "create function public.anything() returns void language sql as $$ delete from public.anything $$;",
    'create trigger anything before insert on public.anything for each row execute function public.anything();']) {
    assert.throws(() => assertCloneSqlSafe(unsafe), /CLONE_SQL_STATEMENT_NOT_ALLOWED/);
  }
});

// Requires an explicitly supplied DISPOSABLE local PostgreSQL database. Never remote.
test('PostgreSQL OLD FAIL / NEW PASS: direct BET/SKIP, delayed transitions, spoof rejection and history', { skip: !process.env.FREEZE_TEST_PSQL }, () => {
  const base = fs.readFileSync(new URL('../../ops/research-clone/inplay-paper-decisions-schema.sql', import.meta.url), 'utf8');
  const insert = (id, status, extra = '') => `insert into public.research_inplay_paper_decisions
    (decision_id,physical_event_id,strategy_id,strategy_version,strategy_definition_hash,strategy_kind,scope_key,status,event_start_iso,admission_observed_at,entry_window_end,first_evaluated_at,
    source_observation_id,condition_id,token_id,side,entry_vwap,entry_quantity,entry_cost_authority,observed_at,frozen_at,provenance_class,processing_lag_ms,reject_reason ${extra ? ',frozen_db_at' : ''})
    values ('00000000-0000-0000-0000-${String(id).padStart(12, '0')}','event-${id}','A','v1','hash','CONTROL','scope','${status}',now(),now(),now(),now(),
    ${status === 'WAITING' ? 'null,null,null,null,null,null,null,null,null,null,null,null' : "'00000000-0000-0000-0000-000000000099','condition','token','YES',0.5,1,'fixture',now(),now(),'TIMING_UNPROVEN',0,'fixture'"} ${extra ? ',' + extra : ''});`;
  const transition = (id, status, extra = '') => `update public.research_inplay_paper_decisions set status='${status}',source_observation_id='00000000-0000-0000-0000-000000000099',condition_id='condition',token_id='token',side='YES',entry_vwap=0.5,entry_quantity=1,entry_cost_authority='fixture',observed_at=now(),frozen_at=now(),provenance_class='TIMING_UNPROVEN',processing_lag_ms=0,reject_reason='fixture' ${extra} where physical_event_id='event-${id}';`;
  const rejects = (statement, message) => `do $$ begin begin ${statement} raise exception 'EXPECTED_REJECTION_MISSING'; exception when others then if sqlerrm <> '${message}' then raise; end if; end; end $$;`;
  const check = (condition, label) => `do $$ begin if not (${condition}) then raise exception '${label}'; end if; end $$;`;
  const count = (where) => `(select count(*) from public.research_inplay_paper_decisions where ${where})`;
  const script = `begin;
    create role anon; create role authenticated; create role service_role;
    ${base}
    savepoint old_schema;
    alter table public.research_inplay_paper_decisions add column frozen_db_at timestamptz;
    ${insert(1, 'BET', "'2000-01-01'::timestamptz")}
    ${insert(2, 'WAITING')}
    select pg_sleep(0.05);
    ${transition(2, 'SKIP')}
    ${check(`${count("physical_event_id='event-1' and frozen_db_at='2000-01-01'")} = 1 and ${count("physical_event_id='event-2' and frozen_db_at is null")} = 1`, 'OLD_DEFECT_NOT_REPRODUCED')}
    select 'OLD_FAIL_PROVEN' as evidence;
    rollback to old_schema;
    ${insert(10, 'SKIP')}
    ${insert(11, 'WAITING')}
    ${sql}
    ${sql}
    ${check(`${count("physical_event_id='event-10' and frozen_db_at is null")} = 1`, 'HISTORY_REWRITTEN')}
    ${insert(12, 'BET')}
    ${insert(13, 'SKIP')}
    ${insert(14, 'WAITING')}
    ${check(`${count("status='WAITING' and frozen_db_at is not null")} = 0`, 'WAITING_FROZEN')}
    select pg_sleep(0.1);
    ${transition(11, 'BET')}
    ${transition(14, 'SKIP')}
    ${check(`${count("physical_event_id in ('event-11','event-12','event-13','event-14') and frozen_db_at > created_at")} = 4`, 'DB_CLOCK_NOT_TERMINAL_TIME')}
    ${rejects(insert(15, 'BET', "'2000-01-01'::timestamptz"), 'INPLAY_PAPER_FROZEN_DB_AT_CLIENT_FORBIDDEN')}
    ${rejects(insert(16, 'SKIP', "'2100-01-01'::timestamptz"), 'INPLAY_PAPER_FROZEN_DB_AT_CLIENT_FORBIDDEN')}
    ${rejects(insert(17, 'WAITING', "'2000-01-01'::timestamptz"), 'INPLAY_PAPER_FROZEN_DB_AT_CLIENT_FORBIDDEN')}
    ${insert(18, 'WAITING')}
    ${rejects(transition(18, 'BET', ",frozen_db_at='2000-01-01'"), 'INPLAY_PAPER_FROZEN_DB_AT_CLIENT_FORBIDDEN')}
    ${rejects(transition(18, 'SKIP', ",frozen_db_at='2100-01-01'"), 'INPLAY_PAPER_FROZEN_DB_AT_CLIENT_FORBIDDEN')}
    ${rejects("update public.research_inplay_paper_decisions set frozen_db_at=null where physical_event_id='event-12';", 'INPLAY_PAPER_DECISION_FROZEN')}
    ${rejects("update public.research_inplay_paper_decisions set status='WAITING' where physical_event_id='event-10';", 'INPLAY_PAPER_DECISION_FROZEN')}
    ${rejects("delete from public.research_inplay_paper_decisions where physical_event_id='event-13';", 'INPLAY_PAPER_DECISION_DELETE_FORBIDDEN')}
    ${rejects("update public.research_inplay_paper_decisions set status='WAITING' where physical_event_id='event-18';", 'INPLAY_PAPER_DECISION_NOOP_UPDATE')}
    ${rejects(transition(18, 'SKIP', ",strategy_id='spoof'"), 'INPLAY_PAPER_DECISION_IDENTITY_IMMUTABLE')}
    ${check(`${count("provenance_class='LIVE_PROSPECTIVE'")} = 0`, 'HISTORY_RECLASSIFIED')}
    select 'NEW_PASS_PROVEN' as evidence;
    rollback;`;
  const out = execFileSync(process.env.FREEZE_TEST_PSQL, ['-X', '-h', '127.0.0.1', '-p', '55439', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: script, encoding: 'utf8' });
  assert.match(out, /OLD_FAIL_PROVEN/);
  assert.match(out, /NEW_PASS_PROVEN/);
  console.log('OLD_FAIL_PROVEN; NEW_PASS_PROVEN on PostgreSQL 16; transaction rolled back');
});
