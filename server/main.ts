import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
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

// Guests (Omar, Iman) reach the board through a tunnel. Default-deny: a request that isn't plainly
// local needs a user link, and a user reaches only their own questions and tasks.
// ponytail: a secret link is the whole login (Ahmed asked for simple); real auth if this goes beyond a few people.
const isLocal = (c: Context) => !c.req.header('x-forwarded-for') && !c.req.header('x-forwarded-host') && !c.req.header('cf-connecting-ip')
  && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(c.req.header('host') ?? 'localhost');
async function guestOf(c: Context) {
  const t = getCookie(c, 'cb_user');
  if (!t) return null;
  const [u] = await sql`select name, display from cb.users where token = ${t}`;
  return (u as { name: string; display: string } | undefined) ?? null;
}

app.use('*', async (c, next) => {
  const token = c.req.query('u');
  if (!token) return next();
  const [u] = await sql`select name from cb.users where token = ${token}`;
  if (!u) return c.text('This link is not valid any more. Ask Ahmed for a new one.', 401);
  setCookie(c, 'cb_user', token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 90 * 86_400 });
  return c.redirect('/', 302);
});

app.use('/api/*', async (c, next) => {
  // CSRF: a browser always sends Origin on a cross-site POST; a page elsewhere must not drive the board.
  const origin = c.req.header('origin');
  if (c.req.method !== 'GET' && origin) {
    const host = (() => { try { return new URL(origin).host } catch { return '' } })();
    if (host !== c.req.header('host') && host !== c.req.header('x-forwarded-host')) return c.json({ ok: false, error: 'cross-site request refused' }, 403);
  }
  const local = isLocal(c);
  if (c.req.path === '/api/whoami') {
    if (local) return c.json({ role: 'local' });
    const u = await guestOf(c);
    return c.json(u ? { role: 'guest', user: u } : { role: 'anonymous' });
  }
  if (local) return next();
  const u = await guestOf(c);
  if (!u) return c.json({ ok: false, error: 'open the link Ahmed sent you' }, 401);
  if (c.req.path === '/api/stream') return next();
  if (c.req.path === '/api/me') return c.json(await q.me(u.name));
  const fn = c.req.method === 'POST' && /^\/api\/rpc\/(answer|log)$/.exec(c.req.path)?.[1];
  if (!fn) return c.json({ ok: false, error: 'not available to guests' }, 403);
  const args = (await c.req.json().catch(() => null)) ?? {};
  const id = Number(String(fn === 'answer' ? args.id : args.task_id ?? '').replace(/^[#q]/i, ''));
  if (!Number.isSafeInteger(id)) return c.json({ ok: false, error: 'not a valid id' }, 400);
  const [mine] = fn === 'answer'
    ? await sql`select project from cb.questions where id = ${id} and assigned_to = ${u.name}`
    : await sql`select project from cb.tasks where id = ${id} and assignee = ${u.name}`;
  if (!mine) return c.json({ ok: false, error: fn === 'answer' ? 'that question is not assigned to you' : 'that task is not assigned to you' }, 403);
  try {
    const safe = fn === 'answer' ? { id: String(id), answer: args.answer, actor: u.name }
      : { project: mine.project, summary: args.summary, task_id: String(id), actor: u.name };
    return c.json({ ok: true, result: await callFn(fn, safe) });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 400);
  }
});

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
app.get('/api/users', async (c) => c.json(await sql`select name, display from cb.users order by name`));
app.get('/api/sessions', async (c) => c.json(await q.sessions(opt(c.req.query('project')))));
app.get('/api/huddles', async (c) => c.json(await q.huddles(opt(c.req.query('project')))));
app.get('/api/huddles/:id', async (c) => {
  const r = await q.huddle(Number(c.req.param('id')));
  return r ? c.json(r) : c.json({ ok: false, error: 'not found' }, 404);
});

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

export async function start() {
  const { ensurePg } = await import('../db/pg.ts');
  ensurePg();
  const port = Number(process.env.PORT ?? 4747);
  const hostname = process.env.HOST ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, () => console.log(`Claude Board: http://localhost:${port}`));
}

if (import.meta.main) await start();
