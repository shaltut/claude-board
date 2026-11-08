import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** DATABASE_URL from CB_DATABASE_URL env, else the repo's .env (never cwd). */
export function databaseUrl(): string {
  if (process.env.CB_DATABASE_URL) return process.env.CB_DATABASE_URL;
  try {
    const env = readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8');
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return 'postgres://cb@127.0.0.1:5434/claude_board';
}

export function connect(url: string = databaseUrl()) {
  // int8 → Number: ids and counts stay well below 2^53 and must be JSON-friendly.
  return postgres(url, {
    onnotice: () => {}, max: 10,
    types: { int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } } as any,
  });
}

export const sql = connect();
