import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Ensures the parent directory of a file path exists.
 * No-op for in-memory paths and Bun SQLite URIs.
 */
export function ensureParentDir(filePath: string): void {
  if (filePath === ':memory:' || filePath.startsWith('file:') || filePath.startsWith('sqlite:')) {
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
}
