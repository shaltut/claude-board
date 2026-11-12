// Starts the private Postgres 16 cluster in .pgdata if it isn't running; creates it if missing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PGDATA = join(ROOT, '.pgdata');
const BIN = process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin';
const pgCtl = join(BIN, 'pg_ctl.exe');

/** The private cluster is this repo's Windows Postgres: a board on Linux (the VPS's container) or pointed at another
 *  machine's database (CB_DATABASE_URL) has nothing to start. */
export function ownsPg(url: string): boolean {
  const u = new URL(url);
  return process.platform === 'win32' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname) && (u.port || '5432') === '5434';
}

export function ensurePg(dir = PGDATA, port = 5434): void {
  // Already serving on the port (the main checkout's cluster, seen from a worktree): use it.
  if (spawnSync(join(BIN, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' }).status === 0) return;
  if (!existsSync(join(dir, 'PG_VERSION'))) {
    const i = spawnSync(join(BIN, 'initdb.exe'), ['-D', dir, '-U', 'cb', '--auth=trust', '-E', 'UTF8'], { stdio: 'pipe', encoding: 'utf8' });
    if (i.status !== 0) throw new Error(`could not create Postgres cluster in ${dir}: ${i.stderr || i.stdout}`);
  }
  if (spawnSync(pgCtl, ['-D', dir, 'status'], { stdio: 'ignore' }).status === 0) return;
  // stdio 'ignore': the postmaster inherits pg_ctl's handles, so a pipe here never closes and spawnSync hangs.
  const log = join(dir, 'server.log');
  const r = spawnSync(pgCtl, ['-D', dir, '-o', `-p ${port}`, '-l', log, '-w', 'start'], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`could not start Postgres in ${dir}; see ${log}`);
}
