import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

// CB_TEST_DB lets parallel worktrees test without wiping each other's data.
export const TEST_URL = `postgres://cb@127.0.0.1:5434/${process.env.CB_TEST_DB ?? 'claude_board_test'}`;
process.env.CB_DATABASE_URL = TEST_URL;

let ready = false;

/** Applies setup to the test DB (once per process) and wipes all cb tables. */
export async function freshDb() {
  if (!ready) {
    execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
    ready = true;
  }
  const sql = postgres(TEST_URL, { onnotice: () => {} });
  const tables = await sql`select tablename from pg_tables where schemaname = 'cb'`;
  if (tables.length) await sql.unsafe(`truncate ${tables.map((t) => 'cb.' + t.tablename).join(', ')} restart identity cascade`);
  return sql;
}
