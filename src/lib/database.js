import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { decryptPayload, encryptPayload, isEncryptedPayload } from './secure-payload.js';

const { Pool } = pg;
let pool;

export function databaseEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

// Used only by the unauthenticated infrastructure health check. It never
// reads customer rows or returns database details to callers.
export async function databaseHealthy() {
  if (!databaseEnabled()) return true;
  await getPool().query('SELECT 1');
  return true;
}

function getPool() {
  if (!databaseEnabled()) throw new Error('DATABASE_URL is not configured.');
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 20_000 });
  return pool;
}

export async function migrateDatabase() {
  if (!databaseEnabled()) return false;
  const client = await getPool().connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../db/migrations');
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (applied.rowCount) continue;
      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    // Version 1 stored a JSONB compatibility payload. Convert it in place after
    // the encrypted column exists, leaving only an empty compatibility object.
    const legacyRows = await client.query("SELECT user_key, payload FROM financial_stores WHERE payload_enc IS NULL AND payload <> '{}'::jsonb");
    for (const row of legacyRows.rows) {
      const serialized = JSON.stringify(row.payload);
      await client.query("UPDATE financial_stores SET payload = '{}'::jsonb, payload_enc = $2 WHERE user_key = $1", [row.user_key, encryptPayload(serialized)]);
    }
    return true;
  } finally {
    client.release();
  }
}

export async function importLegacyStore(userKey, payload, sourceUpdatedAt = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  const serialized = JSON.stringify(payload);
  const sourceHash = crypto.createHash('sha256').update(serialized).digest('hex');
  await getPool().query(
    `INSERT INTO financial_stores (user_key, payload, payload_enc, source_hash, source_updated_at, imported_at)
     VALUES ($1, '{}'::jsonb, $2, $3, $4, now())
     ON CONFLICT (user_key) DO UPDATE SET
       payload = '{}'::jsonb,
       payload_enc = EXCLUDED.payload_enc,
       source_hash = EXCLUDED.source_hash,
       source_updated_at = EXCLUDED.source_updated_at,
       imported_at = now()
     WHERE financial_stores.source_hash IS DISTINCT FROM EXCLUDED.source_hash`,
    [userKey, encryptPayload(serialized), sourceHash, sourceUpdatedAt]
  );
  return sourceHash;
}

export async function readDatabaseStore(userKey) {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  const result = await getPool().query('SELECT payload_enc FROM financial_stores WHERE user_key = $1', [userKey]);
  if (!result.rowCount) return null;
  const encrypted = result.rows[0].payload_enc;
  if (!isEncryptedPayload(encrypted)) throw new Error('Encrypted database payload is unavailable.');
  return JSON.parse(decryptPayload(encrypted));
}

// The scheduler needs opaque storage keys only; financial payloads remain
// encrypted and are never inspected by this query.
export async function listDatabaseStoreKeys() {
  const result = await getPool().query('SELECT user_key FROM financial_stores');
  return result.rows.map((row) => row.user_key);
}

export async function writeDatabaseStore(userKey, payload) {
  return importLegacyStore(userKey, payload, new Date());
}

export async function recordAuditEvent(userKey, eventType) {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  await getPool().query(
    'INSERT INTO audit_events (id, user_key, event_type) VALUES ($1, $2, $3)',
    [crypto.randomUUID(), userKey, eventType]
  );
}

// Dependency events are intentionally operational rather than customer
// telemetry. They never carry a user key, URL parameters, provider payload,
// account identifier, credential, or financial value.
export async function recordDependencyEvent({ dependency, operation, outcome, statusCode = null, durationMs }) {
  if (!/^[a-z0-9_]{1,40}$/.test(dependency) || !/^[a-z0-9_]{1,80}$/.test(operation)) throw new Error('Invalid dependency event.');
  if (!['success', 'failure', 'client_error', 'server_error'].includes(outcome)) throw new Error('Invalid dependency outcome.');
  if (statusCode != null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) throw new Error('Invalid dependency status.');
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('Invalid dependency duration.');
  if (!databaseEnabled()) return;
  const database = getPool();
  await database.query("DELETE FROM dependency_events WHERE created_at < now() - interval '30 days'");
  await database.query(
    `INSERT INTO dependency_events (id, dependency, operation, outcome, status_code, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [crypto.randomUUID(), dependency, operation, outcome, statusCode, Math.round(durationMs)]
  );
}

const launchEventNames = new Set([
  'demo_opened', 'sign_in_completed', 'dashboard_opened', 'account_link_started',
  'account_link_completed', 'sync_succeeded', 'sync_failed', 'cash_flow_viewed',
  'investments_viewed', 'retirement_viewed', 'accounts_viewed',
  'net_worth_history_explored', 'cash_flow_drilldown',
  'cash_flow_month_selected', 'cash_flow_expanded', 'investment_allocation_filtered',
  'holding_reconciliation_started', 'account_group_opened', 'debt_plan_opened',
  'debt_strategy_selected', 'retirement_milestone_opened', 'goal_created',
  'net_worth_card_viewed', 'goal_card_viewed', 'cash_flow_overview_viewed',
  'monthly_cash_flow_viewed', 'investment_holdings_viewed',
  'investment_allocation_viewed', 'retirement_outlook_viewed',
  'retirement_spending_targets_viewed', 'debt_payoff_viewed'
]);

// Launch telemetry intentionally records only a tiny set of product-health
// events. It never accepts arbitrary properties or financial content. Events
// are coalesced to one member/event/day by the database index and are retained
// for 90 days, which is sufficient for a small beta retention check-in.
export async function recordLaunchEvent(userKey, eventName) {
  if (userKey != null && !/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid launch-event user key.');
  if (!launchEventNames.has(eventName)) throw new Error('Invalid launch event.');
  if (!databaseEnabled()) return;
  const database = getPool();
  await database.query('DELETE FROM launch_events WHERE created_at < now() - interval \'90 days\'');
  await database.query(
    `INSERT INTO launch_events (id, user_key, event_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_key, event_name, event_date) WHERE user_key IS NOT NULL DO NOTHING`,
    [crypto.randomUUID(), userKey || null, eventName]
  );
}

// Aggregates only. The owner dashboard never reads encrypted financial stores
// and cannot drill into a person’s balances, transactions, or event history.
export async function launchMetrics() {
  if (!databaseEnabled()) throw new Error('Launch metrics require PostgreSQL.');
  const database = getPool();
  const [summary, returning, cohorts, features] = await Promise.all([
    database.query(`
      SELECT
        COUNT(DISTINCT user_key) FILTER (WHERE event_name = 'sign_in_completed')::int AS signed_in_members,
        COUNT(DISTINCT user_key) FILTER (WHERE event_name = 'account_link_completed')::int AS activated_members,
        COUNT(DISTINCT user_key) FILTER (WHERE event_name = 'dashboard_opened' AND created_at >= now() - interval '7 days')::int AS active_7d,
        COUNT(DISTINCT user_key) FILTER (WHERE event_name = 'dashboard_opened' AND created_at >= now() - interval '28 days')::int AS active_28d,
        COUNT(*) FILTER (WHERE event_name = 'demo_opened' AND created_at >= now() - interval '7 days')::int AS demo_opens_7d,
        COUNT(DISTINCT user_key) FILTER (WHERE event_name = 'sync_succeeded' AND created_at >= now() - interval '26 hours')::int AS synced_26h,
        COUNT(DISTINCT user_key) FILTER (WHERE event_name = 'sync_failed' AND created_at >= now() - interval '26 hours')::int AS sync_failed_26h
      FROM launch_events
    `),
    database.query(`
      SELECT COUNT(DISTINCT recent.user_key)::int AS returning_7d
      FROM launch_events recent
      WHERE recent.event_name = 'dashboard_opened'
        AND recent.created_at >= now() - interval '7 days'
        AND recent.user_key IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM launch_events prior
          WHERE prior.user_key = recent.user_key
            AND prior.event_name = 'dashboard_opened'
            AND prior.created_at < now() - interval '7 days'
      )
    `),
    database.query(`
      WITH first_visits AS (
        SELECT user_key, MIN(event_date) AS first_date
        FROM launch_events
        WHERE event_name = 'dashboard_opened' AND user_key IS NOT NULL
        GROUP BY user_key
      )
      SELECT
        COUNT(*) FILTER (WHERE first_date <= CURRENT_DATE - 7)::int AS cohort_7d_eligible,
        COUNT(*) FILTER (WHERE first_date <= CURRENT_DATE - 7 AND EXISTS (
          SELECT 1 FROM launch_events revisit
          WHERE revisit.user_key = first_visits.user_key
            AND revisit.event_name = 'dashboard_opened'
            AND revisit.event_date BETWEEN first_visits.first_date + 7 AND first_visits.first_date + 13
        ))::int AS cohort_7d_retained,
        COUNT(*) FILTER (WHERE first_date <= CURRENT_DATE - 28)::int AS cohort_28d_eligible,
        COUNT(*) FILTER (WHERE first_date <= CURRENT_DATE - 28 AND EXISTS (
          SELECT 1 FROM launch_events revisit
          WHERE revisit.user_key = first_visits.user_key
            AND revisit.event_name = 'dashboard_opened'
            AND revisit.event_date BETWEEN first_visits.first_date + 28 AND first_visits.first_date + 34
        ))::int AS cohort_28d_retained
      FROM first_visits
    `),
    database.query(`
      SELECT event_name, COUNT(DISTINCT user_key)::int AS members, COUNT(*)::int AS active_days
      FROM launch_events
      WHERE created_at >= now() - interval '28 days'
        AND event_name IN ('cash_flow_viewed', 'investments_viewed', 'retirement_viewed', 'accounts_viewed', 'net_worth_history_explored', 'cash_flow_drilldown', 'cash_flow_month_selected', 'cash_flow_expanded', 'investment_allocation_filtered', 'holding_reconciliation_started', 'account_group_opened', 'debt_plan_opened', 'debt_strategy_selected', 'retirement_milestone_opened', 'goal_created', 'net_worth_card_viewed', 'goal_card_viewed', 'cash_flow_overview_viewed', 'monthly_cash_flow_viewed', 'investment_holdings_viewed', 'investment_allocation_viewed', 'retirement_outlook_viewed', 'retirement_spending_targets_viewed', 'debt_payoff_viewed')
      GROUP BY event_name
      ORDER BY count DESC, event_name ASC
    `)
  ]);
  return { ...summary.rows[0], returning_7d: returning.rows[0].returning_7d, ...cohorts.rows[0], featureEvents: features.rows };
}

// Atomically consume a bounded action inside a fixed window. This is used for
// provider-cost controls and remains effective across deploys and replicas.
export async function consumeRateLimit({ scope, subjectKey, windowMs, limit, now = Date.now() }) {
  if (!/^[a-z0-9_.-]{1,80}$/.test(scope)) throw new Error('Invalid rate-limit scope.');
  if (!/^[a-f0-9]{64}$/.test(subjectKey)) throw new Error('Invalid rate-limit subject.');
  if (!Number.isInteger(windowMs) || windowMs < 1_000 || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid rate-limit configuration.');
  const windowStarted = new Date(Math.floor(now / windowMs) * windowMs);
  const result = await getPool().query(
    `INSERT INTO rate_limit_counters (scope, subject_key, window_started, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (scope, subject_key, window_started) DO UPDATE
       SET count = rate_limit_counters.count + 1
       WHERE rate_limit_counters.count < $4
     RETURNING count`,
    [scope, subjectKey, windowStarted, limit]
  );
  return result.rowCount > 0;
}

export async function deleteDatabaseStore(userKey) {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM launch_events WHERE user_key = $1', [userKey]);
    await client.query('DELETE FROM financial_stores WHERE user_key = $1', [userKey]);
    await client.query('INSERT INTO audit_events (id, user_key, event_type) VALUES ($1, $2, $3)', [crypto.randomUUID(), userKey, 'account_deleted']);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}
