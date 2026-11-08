// Starts the private Postgres 16 cluster in .pgdata if it isn't running.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PGDATA = join(ROOT, '.pgdata');
const BIN = process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin';
const pgCtl = join(BIN, 'pg_ctl.exe');

export function ensurePg(): void {
  if (spawnSync(pgCtl, ['-D', PGDATA, 'status'], { stdio: 'ignore' }).status === 0) return;
  const r = spawnSync(pgCtl, ['-D', PGDATA, '-o', '-p 5434', '-l', join(PGDATA, 'server.log'), '-w', 'start'], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not start Postgres in ${PGDATA}: ${r.stderr || r.stdout}`);
}
