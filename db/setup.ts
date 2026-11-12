// Creates the database if missing and applies schema.sql (idempotent).
// --test targets claude_board_test. Without --test, also puts bin/ on the user PATH (main checkout only, #373).
import postgres from 'postgres';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { ensurePg, ownsPg } from './pg.ts';
import { databaseUrl } from '../server/db.ts';

const ROOT = join(import.meta.dirname, '..');
const isTest = process.argv.includes('--test');
const url = new URL(isTest ? `postgres://cb@127.0.0.1:5434/${process.env.CB_TEST_DB ?? 'claude_board_test'}` : databaseUrl());
const dbName = url.pathname.slice(1);

if (ownsPg(url.toString())) ensurePg();

const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { onnotice: () => {} });
const [exists] = await admin`select 1 from pg_database where datname = ${dbName}`;
if (!exists) await admin.unsafe(`create database "${dbName}"`);
await admin.end();

const sql = postgres(url.toString(), { onnotice: () => {} });
await sql.file(join(ROOT, 'db', 'schema.sql'));
await sql.end();

// A worktree's .git is a file: its bin/ is a dev copy and must not shadow the live cb on PATH (#373).
const isWorktree = statSync(join(ROOT, '.git'), { throwIfNoEntry: false })?.isFile() ?? false;
if (!isTest && !isWorktree && process.platform === 'win32') addBinToPath();
console.log(`claude-board: ${dbName} ready`);

function addBinToPath() {
  const bin = join(ROOT, 'bin');
  let current = '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' });
    current = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/)?.[1]?.trim() ?? '';
  } catch {}
  if (current.toLowerCase().split(';').includes(bin.toLowerCase())) return;
  const next = current ? `${current};${bin}` : bin;
  execFileSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f'], { stdio: 'ignore' });
  console.log(`added ${bin} to your user PATH — open a new terminal to use \`cb\``);
}
