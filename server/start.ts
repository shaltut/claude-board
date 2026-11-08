// pnpm start: build the UI once if it's missing, then run the server.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const root = join(import.meta.dirname, '..');
if (!existsSync(join(root, 'web', 'dist', 'index.html'))) {
  if (!existsSync(join(root, 'web', 'node_modules'))) execSync('pnpm -C web install', { cwd: root, stdio: 'inherit' });
  execSync('pnpm -C web build', { cwd: root, stdio: 'inherit' });
}
process.chdir(root);
const { start } = await import('./main.ts');
await start();
