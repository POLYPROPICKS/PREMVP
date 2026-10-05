// Shared in-memory fake of the Supabase Management API surface used by the HTTPS migration transport tests.
// No network, no real project. Used directly by unit tests and preloaded into the spawned adapter by the e2e tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MANAGEMENT_API_ORIGIN, SQL_LEDGER_VERSIONS, SQL_SCHEMA_FINGERPRINT, SQL_TRANSACTION_PROBE } from '../../../scripts/control-plane/lib/premvp-migration-https-transport.mjs';
import { sha256OfText } from '../../../scripts/control-plane/lib/premvp-target-only-migration.mjs';

export { sha256OfText };

export const TOKEN = 'sbp_SECRET_TOKEN_SENTINEL_0123456789';
export const PROD = 'nbnldzfsxffztsfrrxqy';
export const CLONE = 'nppznoujvnyjargjkmnv';
export const ALLOW = [PROD];
export const TARGET_BASENAME = '20261005090000_t10_executable_sibling_telemetry_v1.sql';
export const TARGET_VERSION = '20261005090000';
export const COLS = ['executable_telemetry_version', 'taker_fee_state', 'p_buy_max'];
export const TARGET_SQL = `-- PREMVP_APPLICATION_MIGRATION_V1
-- a comment mentioning COMMIT and BEGIN must not matter
ALTER TABLE public.reservation_market_observations
${COLS.map((c, i) => `  ADD COLUMN IF NOT EXISTS ${c} ${i === 2 ? 'numeric' : 'text'}${i === COLS.length - 1 ? ';' : ','}`).join('\n')}
COMMENT ON COLUMN public.reservation_market_observations.p_buy_max IS 'begin; commit; are only text here';
`;
export const VERIFY = [{ schema: 'public', table: 'reservation_market_observations', columns: COLS }];
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** In-memory fake of the Management API surface the transport uses. */
export function fakeApi({ ledger = ['20260930070000'], schema = ['public.reservation_market_observations.id'], transactional = true,
  nativeVersion = 'exact', nativeFailsAfterApply = false, tableLedgerDiffers = false, secretEchoOn401 = true } = {}) {
  const state = { ledger: ledger.map((version) => ({ version, name: 'x' })), schema: new Set(schema) };
  const log = [];
  const effects = (sql) => [...sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => `public.reservation_market_observations.${m[1]}`);
  const fingerprint = () => md5([...state.schema].sort().join('|'));
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, MANAGEMENT_API_ORIGIN, 'HTTPS fixed origin only');
    assert.equal(url.startsWith('https://'), true);
    const path = u.pathname.replace(/^\/v1\/projects\/[a-z0-9]{20}\/database/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    log.push({ method: init.method, path, query: body?.query ?? null, name: body?.name ?? null, headers: init.headers });
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: secretEchoOn401 ? `invalid token ${init.headers.authorization}` : 'unauthorized' });
    if (init.method === 'GET' && path === '/migrations') return json(200, state.ledger);
    if (init.method === 'POST' && path === '/query/read-only') {
      if (body.query === SQL_LEDGER_VERSIONS) return json(200, (tableLedgerDiffers ? state.ledger.slice(1) : state.ledger).map((l) => ({ version: l.version })));
      if (body.query === SQL_SCHEMA_FINGERPRINT) return json(200, [{ fingerprint: fingerprint(), n: state.schema.size }]);
      if (body.query.startsWith('select a.attname as column_name')) {
        const wanted = [...body.query.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]).slice(2);
        return json(200, wanted.filter((c) => state.schema.has(`public.reservation_market_observations.${c}`)).map((c) => ({ column_name: c, data_type: 'text', is_nullable: true })));
      }
      return json(400, { message: 'unexpected read-only query' });
    }
    if (init.method === 'POST' && path === '/query') {
      if (body.read_only !== false) return json(400, { message: 'writable queries must say read_only:false' });
      if (body.query === SQL_TRANSACTION_PROBE) return json(200, [{ rolled_back: transactional }]);
      if (body.query.startsWith('BEGIN;\n') && body.query.endsWith('ROLLBACK;')) {
        if (!transactional) for (const e of effects(body.query)) state.schema.add(e);
        return json(201, []);
      }
      if (body.query.startsWith('BEGIN;\n') && body.query.endsWith('COMMIT;')) { for (const e of effects(body.query)) state.schema.add(e); return json(201, []); }
      const repair = /^update supabase_migrations\.schema_migrations set version = '(\d{14})' where version = '(\d{14})' and name = '([a-z0-9_]+)'$/.exec(body.query);
      if (repair) { state.ledger.find((l) => l.version === repair[2]).version = repair[1]; return json(201, []); }
      return json(400, { message: 'unexpected writable query' });
    }
    if (init.method === 'POST' && path === '/migrations') {
      for (const e of effects(body.query)) state.schema.add(e);
      state.ledger.push({ version: nativeVersion === 'exact' ? TARGET_VERSION : '20261005162341', name: body.name });
      return nativeFailsAfterApply ? json(500, { message: 'gateway timeout' }) : json(201, null);
    }
    return json(404, { message: 'not found' });
  };
  return { state, log, fetchImpl };
}

