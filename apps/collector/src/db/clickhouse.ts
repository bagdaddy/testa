import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { config } from '../config.ts';

let _client: ClickHouseClient | null = null;

function client(): ClickHouseClient {
  if (!_client) {
    _client = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
      database: config.clickhouse.database,
      compression: { request: true, response: true },
      keep_alive: { enabled: true },
      request_timeout: 30_000,
    });
  }
  return _client;
}

/** Insert rows into an arbitrary table (JSONEachRow). No-op on empty input. */
export async function insertRows(table: string, rows: readonly object[]): Promise<void> {
  if (rows.length === 0) return;
  await client().insert({
    table,
    values: rows,
    format: 'JSONEachRow',
  });
}

/** Insert rows into the events_buffer table (JSONEachRow). */
export async function insertEvents(rows: readonly object[]): Promise<void> {
  await insertRows('events_buffer', rows);
}

/** Run a read query and return parsed rows. */
export async function query<T = unknown>(
  q: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const result = await client().query({
    query: q,
    ...(params !== undefined ? { query_params: params } : {}),
    format: 'JSONEachRow',
  });
  return (await result.json()) as T[];
}

/** Run a one-shot command (DDL / INSERT without rows). */
export async function command(q: string): Promise<void> {
  await client().command({ query: q });
}

/** Liveness check — `SELECT 1`. Used by the migration runner and health endpoints. */
export async function ping(): Promise<boolean> {
  const rows = await query<{ one: number }>('SELECT 1 AS one');
  return rows[0]?.one === 1;
}

/** Graceful shutdown. */
export async function close(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}

/** Test-only escape hatch: replace the singleton (e.g., with a stub). */
export function __setClientForTests(stub: ClickHouseClient | null): void {
  _client = stub;
}
