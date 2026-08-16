import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const BUILDER = path.join(ROOT, 'scripts/build-realmap-blind-ab.mjs');
const EXPECTED_SEED = 'sf-realmap-blind-ab-v2';
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sf-realmap-blind-ab-'));
const firstPath = path.join(tempRoot, 'first.html');
const secondPath = path.join(tempRoot, 'second.html');

async function build(name, outputPath) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BUILDER, '--out', outputPath], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(stderr, '', `${name} emitted stderr`);
  return {
    bytes: await readFile(outputPath),
    stdout,
  };
}

try {
  const source = await readFile(BUILDER, 'utf8');
  assert.doesNotMatch(source, /Math\.random\s*\(/, 'Blind A/B order must not depend on Math.random');
  assert.match(source, /function deterministicOrder\(pairId\)/, 'Blind A/B builder is missing deterministic pair ordering');
  assert.match(source, /axis: 'geography'/, 'Blind A/B builder has no geography pairs');
  assert.match(source, /axis: 'art'/, 'Blind A/B builder has no art pairs');

  const first = await build('first', firstPath);
  const second = await build('second', secondPath);
  assert.deepEqual(first.bytes, second.bytes, 'Fresh Blind A/B builds are not byte-identical');
  assert.match(first.stdout, new RegExp(`"blindOrderSeed": "${EXPECTED_SEED}"`));
  assert.match(first.stdout, /"geographyPairs": 3/);
  assert.match(first.stdout, /"artPairs": 2/);

  const html = first.bytes.toString('utf8');
  assert.match(html, new RegExp(`const blindOrderSeed = "${EXPECTED_SEED}"`));
  assert.match(html, /const storageKey = blindOrderSeed/);
  assert.match(html, /blindOrderSeed,\s*geography:/);

  console.log(JSON.stringify({
    result: 'Real-map blind A/B determinism verified',
    blindOrderSeed: EXPECTED_SEED,
    byteIdenticalFreshBuilds: true,
    geographyPairs: 3,
    artPairs: 2,
  }, null, 2));
} finally {
  await unlink(firstPath).catch(() => {});
  await unlink(secondPath).catch(() => {});
  await rmdir(tempRoot);
}
