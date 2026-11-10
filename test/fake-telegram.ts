// A stand-in for api.telegram.org: records every call, long-polls updates the test pushes. Never the real bot.
// As a script (node test/fake-telegram.ts 4751) it serves the browser check: POST /push {update} queues an
// update, GET /calls lists what the board sent.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Call = { method: string; body: any };

export async function fakeTelegram(port = 0) {
  const calls: Call[] = [];
  const updates: any[] = [];
  let nextUpdate = 1, nextMessage = 100;
  let wake: (() => void) | null = null;
  const reply = (res: any, result: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { ok: true, result } : { ok: false, description: result }));
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/push') { push(body); return reply(res, true); }
    if (req.url === '/calls') return reply(res, calls);
    const method = /^\/bot[^/]+\/(\w+)$/.exec(req.url ?? '')?.[1];
    if (!method) return reply(res, 'Not Found', 404);
    if (method === 'getMe') return reply(res, { id: 1, is_bot: true, username: 'test_board_bot' });
    if (method === 'getUpdates') {
      const ready = () => updates.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!ready().length) await new Promise<void>((r) => { wake = r; setTimeout(r, Math.min(body.timeout ?? 0, 1) * 1000); });
      wake = null;
      return reply(res, ready());
    }
    calls.push({ method, body });
    if (method === 'sendMessage') return reply(res, { message_id: nextMessage++, chat: { id: body.chat_id }, text: body.text });
    return reply(res, true);
  });
  function push(u: any) { updates.push({ update_id: nextUpdate++, ...u }); wake?.(); }
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, push, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

if (import.meta.main) {
  const f = await fakeTelegram(Number(process.argv[2] ?? 4751));
  console.log(`fake telegram: ${f.url}`);
}
