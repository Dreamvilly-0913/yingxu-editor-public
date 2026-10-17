"use strict";
// Reproducible portable CPU runtime; all downloads are pinned and hash checked.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'tools/asr');
const setup = path.join(root, 'work/asr-setup');
const sources = [
  { name: 'whisper-bin-x64.zip', kind: 'archive', bytes: 8573270, sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip' },
  { name: 'ggml-base.bin', kind: 'model', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin' },
  { name: 'ggml-silero-v6.2.0.bin', kind: 'model', bytes: 885098, sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin' },
  { name: 'whisper.cpp-MIT.txt', kind: 'license', sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d', url: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5130/LICENSE' },
  { name: 'silero-vad-MIT.txt', kind: 'license', sha256: '2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daF5697cfb785e925520b'.toLowerCase(), url: 'https://raw.githubusercontent.com/snakers4/silero-vad/1e261b036686cd0017d500ee96acd1c4ba572a9d/LICENSE' },
  { name: 'whisper-model-MIT.txt', kind: 'license', sha256: 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d', url: 'https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE' }
];
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function acquire(source) {
  const target = path.join(source.kind === 'archive' ? setup : source.kind === 'license' ? path.join(destination, 'licenses') : destination, source.name);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && await hash(target) === source.sha256) { console.log(`Verified existing ${source.name}`); return target; }
  console.log(`Downloading ${source.name}`);
  const response = await fetch(source.url, { signal: AbortSignal.timeout(15 * 60 * 1000), headers: { 'User-Agent': 'Yingxu-ASR-Setup/0.2.0' } });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${source.name}: HTTP ${response.status}`);
  const temp = target + '.download';
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
    if (source.bytes && (await fsp.stat(temp)).size !== source.bytes) throw new Error(`Unexpected size: ${source.name}`);
    if (await hash(temp) !== source.sha256) throw new Error(`SHA256 mismatch: ${source.name}`);
    await fsp.rename(temp, target);
  } finally { await fsp.rm(temp, { force: true }); }
  return target;
}
async function walk(directory) {
  const files = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file)); else if (entry.isFile()) files.push(file);
  }
  return files;
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This installer pins the Windows x64 CPU build.');
  await fsp.mkdir(setup, { recursive: true }); await fsp.mkdir(destination, { recursive: true });
  const acquired = [];
  for (const source of sources) acquired.push(await acquire(source));
  const extracted = await fsp.mkdtemp(path.join(setup, 'extract-'));
  try {
    const quote = s => `'${s.replace(/'/g, "''")}'`;
    const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(acquired[0])}, ${quote(extracted)})`;
    const expand = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' });
    if (expand.status !== 0) throw new Error(`Archive extraction failed: ${expand.stderr}`);
    for (const file of await walk(extracted)) {
      const name = path.basename(file);
      if (name === 'whisper-cli.exe' || name === 'whisper.dll' || /^ggml.*\.dll$/i.test(name)) await fsp.copyFile(file, path.join(destination, name));
    }
    const check = spawnSync(path.join(destination, 'whisper-cli.exe'), ['--help'], { cwd: destination, windowsHide: true, encoding: 'utf8' });
    if (check.status !== 0 || !`${check.stderr}${check.stdout}`.includes('--vad-model')) throw new Error('The installed CLI or its DLL dependencies did not start.');
    const files = [];
    for (const file of (await walk(destination)).filter(f => path.basename(f) !== 'manifest.json')) files.push({ path: path.relative(destination, file).replace(/\\/g, '/'), bytes: (await fsp.stat(file)).size, sha256: await hash(file) });
    await fsp.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ engine: 'whisper.cpp', version: '1.9.4', build: 'b5130', platform: 'win32-x64-cpu', model: 'Whisper base multilingual', vad: 'Silero VAD 6.2.0', sources, files }, null, 2));
    console.log(`Installed and verified ${files.length} portable ASR files.`);
  } finally { await fsp.rm(extracted, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sources };
