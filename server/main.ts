import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sql } from './db.ts';
import { callFn, RpcError } from './rpc.ts';
import * as q from './queries.ts';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'web', 'dist');

export const app = new Hono();
const opt = (v?: string) => (v ? v : undefined);

app.post('/api/rpc/:fn', async (c) => {
  try {
    const args = await c.req.json().catch(() => ({}));
    return c.json({ ok: true, result: await callFn(c.req.param('fn'), args ?? {}) });
  } catch (e: any) {
    const status = e instanceof RpcError ? e.status : e?.name === 'PostgresError' ? 400 : 500;
    return c.json({ ok: false, error: e?.message ?? String(e) }, status as 400);
  }
});

app.get('/api/projects', async (c) => c.json(await q.projects()));
app.get('/api/tasks', async (c) => c.json(await q.tasks(opt(c.req.query('project')), opt(c.req.query('status')))));
app.get('/api/tasks/:id', async (c) => {
  const r = await q.task(Number(c.req.param('id')));
  return r ? c.json(r) : c.json({ ok: false, error: 'not found' }, 404);
});
app.get('/api/questions', async (c) => c.json(await q.questions(opt(c.req.query('project')), opt(c.req.query('status')))));
app.get('/api/events', async (c) => {
  const f = c.req.query();
  return c.json(await q.events({ project: opt(f.project), actor: opt(f.actor), kind: opt(f.kind), since: opt(f.since),
    before: opt(f.before), q: opt(f.q), limit: f.limit ? Number(f.limit) : undefined }));
});
app.get('/api/today', async (c) => {
  const since = c.req.query('since') || new Date(Date.now() - 86_400_000).toISOString();
  return c.json(await q.today(opt(c.req.query('project')), since));
});
app.get('/api/last-seen', async (c) => c.json(await q.lastSeen()));

// Live updates: one LISTEN connection fanned out to every open page.
type Client = (table: string) => void;
const clients = new Set<Client>();
let listening: Promise<unknown> | null = null;
function ensureListen() {
  listening ??= sql.listen('cb', (table) => clients.forEach((send) => send(table)));
  return listening;
}

app.get('/api/stream', async (c) => {
  await ensureListen();
  return streamSSE(c, async (stream) => {
    const send: Client = (table) => { stream.writeSSE({ event: 'change', data: table }).catch(() => {}); };
    clients.add(send);
    stream.onAbort(() => clients.delete(send));
    await stream.writeSSE({ event: 'hello', data: 'ok' });
    while (!stream.aborted) {
      await stream.sleep(25_000);
      await stream.write(': ping\n\n').catch(() => {});
    }
    clients.delete(send);
  });
});

// The built UI, with SPA fallback.
app.use('/*', serveStatic({ root: relative(process.cwd(), DIST) || '.' }));
app.get('*', (c) =>
  existsSync(join(DIST, 'index.html'))
    ? c.html(readFileSync(join(DIST, 'index.html'), 'utf8'))
    : c.text('UI not built yet: run `pnpm build`', 503));

if (import.meta.main) {
  const { ensurePg } = await import('../db/pg.ts');
  ensurePg();
  const port = Number(process.env.PORT ?? 4747);
  const hostname = process.env.HOST ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, () => console.log(`Claude Board → http://localhost:${port}`));
}
