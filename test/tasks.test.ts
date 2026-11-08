import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freshDb } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

test('setup twice keeps rows', async () => {
  const sql = await db();
  await sql`insert into cb.projects(slug, name) values ('demo','Demo')`;
  execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
  const [r] = await sql`select count(*)::int n from cb.projects`;
  assert.equal(r.n, 1);
});
