import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sql, dotenv, databaseUrl } from './db.ts';
import { callFn, RpcError } from './rpc.ts';
import * as q from './queries.ts';
import { reconcile, startTelegram, telegramConnect, telegramDisconnect, telegramStatus } from './telegram.ts';
import { startGithub } from './github.ts';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'web', 'dist');

type Who = { name: string; display: string; role: 'admin' | 'member' };
export const app = new Hono<{ Variables: { admin?: Who } }>();
// A read the database refuses (an unknown ?project= raises in cb.read_project) is a bad request, not a crash.
app.onError((e: any, c) => e?.name === 'PostgresError'
  ? c.json({ ok: false, error: e.message }, 400)
  : (console.error(e), c.json({ ok: false, error: 'server error' }, 500)));
const opt = (v?: string) => (v ? v : undefined);

// Default-deny. Everyone signs in (#1749): admins (Ahmed, the owner, is the user ahmed) get the whole board, by
// password; members (Omar, Iman) get only their own questions and tasks, by password or their private link.
// One exception keeps the board on Ahmed's PC working as it always has: a request plainly from this machine is his.
// That trust is off when the server listens beyond loopback (a container on 0.0.0.0: anyone reaching the port could
// send Host: localhost) and when CB_TRUST_LOCAL=0 (the VPS sets it).
const LOOPBACK = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/;
const trustLocal = () => process.env.CB_TRUST_LOCAL !== '0' && LOOPBACK.test(process.env.HOST ?? '127.0.0.1');
const isLocal = (c: Context<any>) => trustLocal() && !c.req.header('x-forwarded-for') && !c.req.header('x-forwarded-host') && !c.req.header('cf-connecting-ip')
  && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(c.req.header('host') ?? 'localhost');
async function userOf(c: Context<any>): Promise<Who | null> {
  const t = getCookie(c, 'cb_user');
  if (!t) return null;
  const [u] = await sql`select name, display, role from cb.users where token = ${t}`;
  return (u as Who | undefined) ?? null;
}
// The address a login is counted against: the hop our own proxy added (the last X-Forwarded-For entry), else a direct
// connection. Cloudflare's cf-connecting-ip only with CB_BEHIND_CLOUDFLARE=1 (a tunnel, or a proxied DNS record): when
// nginx is reachable directly, a client can send that header itself and get a fresh lockout on every try.
const clientIp = (c: Context<any>) => (process.env.CB_BEHIND_CLOUDFLARE === '1' && c.req.header('cf-connecting-ip')?.trim())
  || c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'direct';

app.use('*', async (c, next) => {
  const token = c.req.query('u');
  if (!token) return next();
  const [u] = await sql`select name, role from cb.users where token = ${token}`;
  if (!u) return c.text('This link is not valid any more. Ask Ahmed for a new one.', 401);
  // an admin's token is their cookie, never a link: a link in a chat or a browser history would be the whole board
  if (u.role === 'admin') return c.text('This link is for members: admins sign in with their password on the login page.', 401);
  signIn(c, token);
  return c.redirect('/', 302);
});
function signIn(c: Context<any>, token: string) {
  setCookie(c, 'cb_user', token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 90 * 86_400,
    secure: c.req.header('x-forwarded-proto') === 'https' }); // the tunnel is https; local dev is plain http
}
export const loginFails = new Map<string, { n: number; until: number; last: number }>();
// A failure count lives 2 minutes from its last try; a lock, until it runs out. The prune drops only those, so flooding
// the map with junk names can't reset a real count.
const stale = (f: { until: number; last: number }, now: number) => f.until ? f.until <= now : now - f.last > 120_000;
let loginWaits = 0;
// Guests with a project scope: only what is assigned to them, on a project Ahmed put them on.
const onTheirProjects = (user: string) => sql`project in (select project from cb.user_projects where user_name = ${user})`;

app.use('/api/*', async (c, next) => {
  // CSRF: a browser always sends Origin on a cross-site POST; a page elsewhere must not drive the board.
  const origin = c.req.header('origin');
  if (c.req.method !== 'GET' && origin) {
    const host = (() => { try { return new URL(origin).host } catch { return '' } })();
    if (host !== c.req.header('host') && host !== c.req.header('x-forwarded-host')) return c.json({ ok: false, error: 'cross-site request refused' }, 403);
  }
  // The login page (#315): name and password set the same cookie as the link. One answer for every failure,
  // after a second. A name is locked for 2 minutes after 5 tries without a success (counted before the
  // password check, so a parallel burst can't slip past), and at most 20 failures wait at once.
  // ponytail: in-memory, per process; lost on restart, which is fine for one board.
  if (c.req.path === '/api/login' && c.req.method === 'POST') {
    const b = (await c.req.json().catch(() => null)) ?? {};
    const name = typeof b.name === 'string' ? b.name.trim().toLowerCase() : '', pw = typeof b.password === 'string' ? b.password : '';
    const refuse = (status: 401 | 429) => c.json({ ok: false, error: "That name and password don't match." }, status);
    const now = Date.now(), key = `${name}|${clientIp(c)}`; // per name and address: a stranger can't lock Ahmed out
    if (loginFails.size > 1000) for (const [k, f] of loginFails) if (stale(f, now)) loginFails.delete(k);
    let f = loginFails.get(key);
    if (f && stale(f, now)) f = undefined; // the lock ran out, or the last miss was long ago: start counting again
    if (f?.until) return refuse(429);
    f ??= { n: 0, until: 0, last: now };
    f.last = now;
    if (++f.n >= 5) f.until = now + 120_000;
    loginFails.set(key, f);
    const [u] = name && pw ? await sql`select token from cb.users where name = ${name} and password is not null
                                         and password = public.crypt(${pw}, password)` : [];
    if (u) {
      loginFails.delete(key);
      signIn(c, u.token);
      return c.json({ ok: true });
    }
    if (loginWaits >= 20) return refuse(429);
    loginWaits++;
    try { await new Promise((r) => setTimeout(r, 1000)) } finally { loginWaits-- }
    return refuse(401);
  }
  if (c.req.path === '/api/logout' && c.req.method === 'POST') {
    deleteCookie(c, 'cb_user', { path: '/' });
    return c.json({ ok: true });
  }
  // Anyone signed in sets their own password: the current one is required once there is one (a member who signed
  // in by link sets a first one without).
  if (c.req.path === '/api/password' && c.req.method === 'POST') {
    const u = await userOf(c);
    if (!u) return c.json({ ok: false, error: 'sign in first' }, 401);
    const b = (await c.req.json().catch(() => null)) ?? {};
    if (typeof b.password !== 'string' || b.password.length < 8) return c.json({ ok: false, error: 'password: at least 8 characters' }, 400);
    const [row] = await sql`select password is not null as has, password = public.crypt(${typeof b.current === 'string' ? b.current : ''}, password) as ok
                              from cb.users where name = ${u.name}`;
    if (row?.has && !row.ok) return c.json({ ok: false, error: 'the current password is wrong' }, 400);
    const fresh = await sql.begin(async (tx) => {
      await tx`set local application_name = 'cb-web'`;
      await callFn('user_password', { name: u.name, password: b.password, actor: u.name }, tx);
      // an admin's cookie is their only credential besides the password: a new one ends every other sign-in (a
      // stolen cookie included). A member's token is also their link, which keeps working (New link ends it).
      if (u.role === 'admin') return (await tx`update cb.users set token = gen_random_uuid()::text where name = ${u.name} returning token`)[0].token as string;
    });
    if (fresh) signIn(c, fresh);
    return c.json({ ok: true });
  }
  const local = isLocal(c);
  if (c.req.path === '/api/whoami') {
    if (local) return c.json({ role: 'local' });
    const u = await userOf(c);
    if (!u) return c.json({ role: 'anonymous' });
    return c.json({ role: u.role === 'admin' ? 'admin' : 'guest', user: { name: u.name, display: u.display } });
  }
  if (local) return next();
  const u = await userOf(c);
  if (!u) return c.json({ ok: false, error: 'sign in first: the login page, or the link Ahmed sent you' }, 401);
  if (u.role === 'admin') { c.set('admin', u); return next(); }
  if (c.req.path === '/api/stream') return next();
  if (c.req.path === '/api/me') return c.json(await q.me(u.name, onTheirProjects(u.name)));
  const fn = c.req.method === 'POST' && /^\/api\/rpc\/(answer|send_back|log)$/.exec(c.req.path)?.[1];
  if (!fn) return c.json({ ok: false, error: 'not available to guests' }, 403);
  const args = (await c.req.json().catch(() => null)) ?? {};
  const id = Number(String(fn !== 'log' ? args.id : args.task_id ?? '').replace(/^[#q]/i, ''));
  if (!Number.isSafeInteger(id)) return c.json({ ok: false, error: 'not a valid id' }, 400);
  const [mine] = fn !== 'log'
    ? await sql`select project from cb.questions where id = ${id} and assigned_to = ${u.name} and ${onTheirProjects(u.name)}`
    : await sql`select project from cb.tasks where id = ${id} and assignee = ${u.name} and ${onTheirProjects(u.name)}`;
  if (!mine) return c.json({ ok: false, error: fn !== 'log' ? 'that question is not assigned to you' : 'that task is not assigned to you' }, 403);
  try {
    const safe = fn === 'answer' ? { id: String(id), answer: args.answer, actor: u.name }
      : fn === 'send_back' ? { id: String(id), reason: args.reason, note: args.note ?? null, actor: u.name }
      : { project: mine.project, summary: args.summary, task_id: String(id), actor: u.name };
    // cb.send_back and changing a delivered answer (#1346) are the dashboard's: the guest's question and name are checked above
    return c.json({ ok: true, result: fn !== 'log'
      ? await sql.begin(async (tx) => { await tx`set local application_name = 'cb-web'`; return callFn(fn, safe, tx); })
      : await callFn(fn, safe) });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 400);
  }
});

// The cb functions that take an actor, read from the schema once (it is applied before the server starts).
let actorFns: Promise<Set<string>> | null = null;
async function takesActor(fn: string) {
  actorFns ??= sql`select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'cb' and 'actor' = any(p.proargnames)`
    .then((r) => new Set(r.map((x: any) => x.proname as string)), (e) => { actorFns = null; throw e; });
  return (await actorFns).has(fn);
}
// Another admin's sign-in (password, token), role and removal are the owner's to change: otherwise any admin could
// reset Ahmed's password or rotate his token and sign in as him, or demote an admin, reset the now-member's password,
// promote them back and sign in as them. Anyone's own password goes through /api/password, which asks for the current one.
const ADMIN_GUARDED = new Set(['user_password', 'user_rotate', 'user_set_role', 'user_remove']);
async function signInRule(admin: Who, fn: string, args: Record<string, unknown>) {
  if (!ADMIN_GUARDED.has(fn)) return null;
  const target = String(args.name ?? '').trim().toLowerCase();
  if (fn === 'user_password' && target === admin.name) return 'your own password: the key icon at the top (it asks for the current one)';
  if (admin.name === 'ahmed' || target === admin.name) return null;
  const [t] = await sql`select role from cb.users where name = ${target}`;
  return t?.role === 'admin' ? "another admin's sign-in, role and removal are Ahmed's to change" : null;
}

app.post('/api/rpc/:fn', async (c) => {
  try {
    const args = (await c.req.json().catch(() => ({}))) ?? {};
    // Only the dashboard page acts as ahmed (cb.not_ahmed): a browser POST always carries Origin, and the
    // CSRF check above has made it this host. A script without Origin (curl from a session) is a session.
    // The CLI shares this pool and callFn, so the name is set per transaction here, not on the pool.
    // A signed-in admin is the dashboard, and acts as who signed in: the page's own actor is never trusted.
    const admin = c.get('admin'), fn = c.req.param('fn');
    if (admin && args && typeof args === 'object') {
      // every function with an actor argument gets the admin's name, given or not: several default it to 'ahmed'
      if (await takesActor(fn)) args.actor = admin.name;
      const refused = await signInRule(admin, fn, args);
      if (refused) return c.json({ ok: false, error: refused }, 403);
    }
    const result = admin || c.req.header('origin')
      ? await sql.begin(async (tx) => { await tx`set local application_name = 'cb-web'`; return callFn(fn, args ?? {}, tx); })
      : await callFn(fn, args ?? {});
    return c.json({ ok: true, result });
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
// No tokens or hashes here: the For picker and the assignee list use it, to offer people on the item's project.
// The owner is a user only to sign in: he is never one of the people work is handed to.
app.get('/api/users', async (c) => c.json(await sql`select u.name, u.display,
  array(select up.project from cb.user_projects up where up.user_name = u.name order by up.project) as projects
  from cb.users u where u.name <> 'ahmed' order by u.name`));
// Tokens: reachable only from this PC (the guest block above refuses every other path), and only from the
// dashboard page: a browser's own fetch says Sec-Fetch-Site: same-origin, curl and sessions send nothing.
// ponytail: a deterrent, not auth (any local process can send the header), like cb.not_ahmed. The link base is the CLI's.
app.get('/api/people', async (c) => {
  if (c.req.header('sec-fetch-site') !== 'same-origin') return c.json({ ok: false, error: 'the Users page only: open it on the dashboard' }, 403);
  return c.json({ public_url: (process.env.CB_PUBLIC_URL || dotenv('PUBLIC_URL') || '').replace(/\/$/, '') || null, people: await q.people() });
});
// Telegram answering (#683): pairing is the dashboard page's alone, as tokens are on /api/people (guests never get here).
// Another admin pairing their own chat would get Ahmed's questions and answer them as him: the owner's alone.
const pageOnly = (c: Context<any>) => c.req.header('sec-fetch-site') !== 'same-origin'
  ? c.json({ ok: false, error: 'Telegram pairing is on the dashboard only' }, 403)
  : c.get('admin') && c.get('admin').name !== 'ahmed' ? c.json({ ok: false, error: "Telegram pairing is Ahmed's: the bot is his" }, 403) : null;
app.get('/api/telegram', async (c) => pageOnly(c) ?? c.json(await telegramStatus()));
app.post('/api/telegram/connect', async (c) => {
  try { return pageOnly(c) ?? c.json(telegramConnect()); } catch (e: any) { return c.json({ ok: false, error: e.message }, 400); }
});
app.post('/api/telegram/disconnect', async (c) => pageOnly(c) ?? (await telegramDisconnect(), c.json({ ok: true })));
app.get('/api/sessions', async (c) => c.json(await q.sessions(opt(c.req.query('project')))));
app.get('/api/huddles', async (c) => c.json(await q.huddles(opt(c.req.query('project')))));
app.get('/api/epics', async (c) => c.json(await q.epics(opt(c.req.query('project')))));
// Shared memory (#167): live and proposed entries (all=1 adds superseded and retired). No project = every project.
// The dashboard page (a browser's own fetch says Sec-Fetch-Site: same-origin, as on /api/people) reads as Ahmed, so
// his "Waiting for you" includes flagged proposals; any other local read is a session's and doesn't see them.
// ponytail: a deterrent like /api/people, not auth.
// q= searches instead (mem_find: full text, best first); live=1 keeps live entries not past review (the "Already ruled" picker).
app.get('/api/memories', async (c) => {
  const q = opt(c.req.query('q')), project = opt(c.req.query('project')) ?? null, include_old = c.req.query('all') === '1';
  const [fn, args] = q ? ['mem_find', { q, project, include_old, live_only: c.req.query('live') === '1' }] : ['mem_list', { project, include_old }];
  return c.json(c.req.header('sec-fetch-site') === 'same-origin'
    ? await sql.begin(async (tx) => { await tx`set local application_name = 'cb-web'`; return callFn(fn, args, tx); })
    : await callFn(fn, args));
});
// How we'd know memory works (#553): the weekly metric and the Today card's counts. Guests never reach it (403 above).
app.get('/api/memory/stats', async (c) => {
  const [{ s }] = await sql`select cb.mem_stats(${opt(c.req.query('project')) ?? null}) as s`;
  return c.json(s);
});
app.get('/api/epics/:id', async (c) => {
  const r = await q.epic(Number(c.req.param('id')));
  return r ? c.json(r) : c.json({ ok: false, error: 'not found' }, 404);
});
app.get('/api/goals', async (c) => c.json(await q.goals(opt(c.req.query('project')))));
app.get('/api/goals/:id', async (c) => {
  const r = await q.goal(Number(c.req.param('id')));
  return r ? c.json(r) : c.json({ ok: false, error: 'not found' }, 404);
});
// Ahmed's asks (#936): open threads and those closed in the last day. Guests never reach it (default-deny above).
app.get('/api/asks', async (c) => c.json(await callFn('asks_list', { project: opt(c.req.query('project')) ?? null })));
app.get('/api/huddles/:id', async (c) => {
  const r = await q.huddle(Number(c.req.param('id')));
  return r ? c.json(r) : c.json({ ok: false, error: 'not found' }, 404);
});

// For Docker's healthcheck and an uptime monitor: no sign-in, and nothing but whether the database answers.
app.get('/healthz', async (c) => {
  try { await sql`select 1`; return c.json({ ok: true }); } catch { return c.json({ ok: false }, 503); }
});

// Live updates: one LISTEN connection fanned out to every open page.
type Client = (table: string) => void;
const clients = new Set<Client>();
let listening: Promise<unknown> | null = null, retry: ReturnType<typeof setTimeout> | null = null, wait = 1000;
const fan = (table: string) => clients.forEach((send) => send(table));
/** Never rejects: a failed LISTEN (the DB down at boot) is logged and retried with backoff, not cached, so the
 *  server stays up without live updates until it connects. 'listen' fans out on every (re)connect: what changed
 *  while the connection was down is caught up. listen is injectable for the test. */
export function ensureListen(listen = () => sql.listen('cb', fan, () => fan('listen'))) {
  listening ??= listen().then((r) => { wait = 1000; return r; }, (e: any) => {
    listening = null;
    console.error(`live updates: LISTEN failed (${e?.message ?? e}); retrying in ${wait / 1000}s`);
    retry ??= setTimeout(() => { retry = null; ensureListen(); }, wait);
    retry.unref?.();
    wait = Math.min(wait * 2, 60_000);
  });
  return listening;
}

app.get('/api/stream', async (c) => {
  await ensureListen();
  c.header('X-Accel-Buffering', 'no'); // nginx (the VPS's proxy) would otherwise hold the events back
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

// The built UI, with SPA fallback. index.html must revalidate or a release keeps serving the old bundle (#498);
// /assets/* names are content-hashed, so they never change.
// (serveStatic's onFound runs after the body is built, so a header set there is dropped.) /api routes answer
// before this middleware, so they are untouched; a missing asset falls through to index.html and gets no-cache.
app.use('/*', async (c, next) => {
  await next();
  if (c.res.headers.get('content-type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache');
  else if (c.req.path.startsWith('/assets/') && c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
});
app.use('/*', serveStatic({ root: relative(process.cwd(), DIST) || '.' }));
app.get('*', (c) =>
  existsSync(join(DIST, 'index.html'))
    ? c.html(readFileSync(join(DIST, 'index.html'), 'utf8'))
    : c.text('UI not built yet: run `pnpm build`', 503));

/** The Telegram bot (#683) rides the same LISTEN as the pages: a question change reconciles the chat. */
export async function startBot(token: string, api: string) {
  startTelegram({ token, api });
  clients.add((table) => { if (table === 'questions' || table === 'listen') reconcile(); });
  await ensureListen();
}

/** Telegram and the GitHub watch run once per board, not once per server: a second server on the same database (the
 *  PC's, started again after the move to the VPS) would double every GitHub card and fight over the bot's updates.
 *  The server holding a session advisory lock polls; another waits, and takes over within `every` if the first goes.
 *  Resolves with the reserved connection that holds the lock, once this server leads.
 *  ponytail: if that connection drops (Postgres restarted) the lock goes while this server keeps polling, so a waiting
 *  server can start too; a leader that re-checks its lock would close that, if two servers ever run on purpose. */
export async function lead(begin: () => void, every = 60_000, db: any = sql) {
  for (let waited = false; ; waited = true) {
    const conn = await db.reserve().catch(() => null);
    const [r] = conn ? await conn`select pg_try_advisory_lock(4747) as ok`.catch(() => [null]) : [null];
    if (r?.ok) { begin(); return conn; }
    conn?.release();
    if (!waited && r) console.log('another board server polls Telegram and GitHub for this database; this one serves pages, and takes over if it goes');
    await new Promise((res) => setTimeout(res, every).unref?.());
  }
}

export async function start() {
  const { ensurePg, ownsPg } = await import('../db/pg.ts');
  if (ownsPg(databaseUrl())) ensurePg();
  const port = Number(process.env.PORT ?? 4747);
  const hostname = process.env.HOST ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, () => console.log(`Claude Board: http://localhost:${port}`));
  const token = process.env.TELEGRAM_BOT_TOKEN || dotenv('TELEGRAM_BOT_TOKEN');
  void lead(() => {
    if (token) void startBot(token, process.env.TELEGRAM_API || dotenv('TELEGRAM_API') || 'https://api.telegram.org');
    startGithub(); // #1207: polls the repos `cb github` lists (none: nothing is called)
  });
}

if (import.meta.main) await start();
