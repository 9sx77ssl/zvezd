import type { Database } from '../Database';

/** Minimal persistent key/value store for cross-run bookkeeping. */
export class StateRepository {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM app_state WHERE key = ?')
      .get(key);
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .query(`
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, Date.now());
  }

  getBool(key: string): boolean {
    return this.get(key) === 'true';
  }

  setBool(key: string, value: boolean): void {
    this.set(key, value ? 'true' : 'false');
  }
}
