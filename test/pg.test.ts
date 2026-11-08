import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { ensurePg } from '../db/pg.ts';

test('ensurePg creates the cluster when .pgdata is missing', { timeout: 120_000 }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cb-pg-')), '.pgdata');
  const pgCtl = join(process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin', 'pg_ctl.exe');
  try {
    ensurePg(dir, 5439);
    const sql = postgres('postgres://cb@127.0.0.1:5439/postgres', { onnotice: () => {} });
    const [r] = await sql`select current_user as u`;
    await sql.end();
    assert.equal(r.u, 'cb');
  } finally {
    spawnSync(pgCtl, ['-D', dir, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});
