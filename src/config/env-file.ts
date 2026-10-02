import { readFileSync } from 'node:fs';

/** Extracts `FORUM_TOKEN` from `.env`-style text; `null` when missing/empty. */
export function parseEnvToken(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?FORUM_TOKEN\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = (match[1] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1).trim();
    }
    return value || null;
  }
  return null;
}

/**
 * Re-reads `FORUM_TOKEN` from disk. A dead token is replaced by editing the
 * file in place, so the bot polls it instead of requiring a restart.
 */
export function readEnvToken(path: string): string | null {
  try {
    return parseEnvToken(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
