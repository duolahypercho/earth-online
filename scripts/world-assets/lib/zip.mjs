// Minimal ZIP reader for the world-asset vendoring pipeline.
// Reads the central directory and inflates STORE (0) and DEFLATE (8) entries.
// No writing, no encryption, no zip64 archives above 4 GB.

import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

export function listZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record: not a zip');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pos) !== CEN) throw new Error(`bad central directory entry ${i}`);
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    entries.push({ name, method, compressedSize, size, offset });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer, entry) {
  const local = entry.offset;
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const body = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return zlib.inflateRawSync(body);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}
