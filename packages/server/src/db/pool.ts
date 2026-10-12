import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool: PgPool, types } = pg;

types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));
export interface DatabaseOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
  applicationName?: string;
}
export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  ping(): Promise<void>;
  raw(): Pool;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new PgPool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: options.applicationName ?? 'pagefreeze',

    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on('error', (error) => {
    console.error('[pagefreeze] idle database client error', error.message);
  });

  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> {
      return pool.query<T>(text, params as never[]);
    },

    async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async end(): Promise<void> {
      await pool.end();
    },

    async ping(): Promise<void> {
      await pool.query('SELECT 1');
    },

    raw: () => pool,
  };
}
