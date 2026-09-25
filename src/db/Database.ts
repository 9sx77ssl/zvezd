import { Database as BunDatabase, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { ensureParentDir } from '../core/fs';
import type { Logger } from '../core/logger';

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'create_issuances',
    sql: `
      CREATE TABLE IF NOT EXISTS issuances (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id       INTEGER NOT NULL,
        post_id         INTEGER NOT NULL UNIQUE,
        poster_user_id  INTEGER NOT NULL,
        poster_username TEXT    NOT NULL,
        tg_link         TEXT,
        tg_chat_id      TEXT,
        tg_message_id   INTEGER,
        status          TEXT    NOT NULL,
        skip_reason     TEXT,
        error           TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        comment_id      INTEGER,
        star_sent_at    INTEGER,
        commented_at    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_issuances_status ON issuances(status);
      CREATE INDEX IF NOT EXISTS idx_issuances_poster ON issuances(poster_user_id);
    `,
  },
  {
    version: 2,
    name: 'create_app_state',
    sql: `
      CREATE TABLE IF NOT EXISTS app_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'add_star_baseline',
    sql: `
      ALTER TABLE issuances ADD COLUMN tg_baseline INTEGER;
    `,
  },
];

/**
 * Owns the SQLite connection, applies migrations and exposes safe helpers.
 * The underlying connection is kept private; all access goes through this API.
 */
export class Database {
  private readonly db: BunDatabase;
  private closed = false;

  constructor(
    path: string,
    private readonly logger: Logger,
  ) {
    if (path !== ':memory:') {
      ensureParentDir(path);
    }

    this.db = new BunDatabase(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = new Set(
      this.db
        .query<{ version: number }, []>('SELECT version FROM schema_migrations')
        .all()
        .map((row) => row.version),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      const apply = this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now());
      });

      apply();
      this.logger.info('Applied database migration', {
        version: migration.version,
        name: migration.name,
      });
    }
  }

  query<T, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<T, P> {
    return this.db.query(sql) as unknown as Statement<T, P>;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
