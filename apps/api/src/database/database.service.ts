import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { migrations } from './migrations';
import { runMigrations } from './migrator';

/** Serialize a JS vector into pgvector's text format. */
export const toVector = (v: number[]): string => `[${v.join(',')}]`;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
  }

  async onModuleInit(): Promise<void> {
    const applied = await runMigrations(this.pool, migrations, { embeddingDim: this.cfg.embeddingDim });
    await this.checkEmbeddingDim();
    this.logger.log(
      `Schema ready (vector(${this.cfg.embeddingDim}))` +
        (applied.length ? `, applied ${applied.map((m) => `${m.id} ${m.name}`).join(', ')}` : ''),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The vector column's size is fixed when the table is created, so a different EMBEDDING_DIM must be refused. */
  private async checkEmbeddingDim(): Promise<void> {
    const dim = this.cfg.embeddingDim;
    const { rows } = await this.query<{ dim: number }>(
      `SELECT atttypmod AS dim FROM pg_attribute
        WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
    );
    if (rows[0]?.dim !== dim) {
      throw new Error(
        `chunks.embedding has ${rows[0]?.dim} dimensions but EMBEDDING_DIM=${dim}. ` +
          'Set EMBEDDING_DIM back to match, or follow "Changing the embedding dimension" in the README.',
      );
    }
  }
}
