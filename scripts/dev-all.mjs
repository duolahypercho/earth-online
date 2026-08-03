import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['server/multiplayer-server.mjs'], { stdio: 'inherit' });
const viteBin = new URL('../node_modules/.bin/vite', import.meta.url).pathname;
const vite = spawn(viteBin, ['--port', '5173', '--strictPort'], { stdio: 'inherit' });

function shutdown() {
  server.kill('SIGTERM');
  vite.kill('SIGTERM');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

vite.on('exit', () => {
  server.kill('SIGTERM');
});
