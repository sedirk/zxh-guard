'use strict';

// Scan the actual Git index, a slim artifact, or a full package. Never print secret values.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseConfigText } = require('../lib/config');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

// Exact upstream artifacts allowed in a full package. Pinning hashes is what makes
// skipping the generic "no binaries/archives" filename rule safe.
const THIRD_PARTY = new Map([
  ['bin/zju-connect.exe', 'AEE7D8DBBF4DB98FBFF2B36D657094D95F3F6209DC3168914C62AEA01A8732BE'],
  ['third_party/zju-connect-v1.3.1-source.zip', 'FA131DDA15A053E4D3D51F2BA0B79278B5129AF6FA7E5AFFC05EAFC2ECA825AB'],
]);

const args = process.argv.slice(2);
const full = args.includes('--full');
const directoryFlag = args.indexOf('--directory');
const directory = directoryFlag >= 0 ? args[directoryFlag + 1] : '';
const allowedThirdParty = new Set(['third_party/zju-connect-v1.3.1-source.zip']);
if (full) allowedThirdParty.add('bin/zju-connect.exe');

const credentials = [];
const localConfig = path.join(root, 'config.json');
if (fs.existsSync(localConfig)) {
  const config = parseConfigText(fs.readFileSync(localConfig, 'utf8'));
  for (const key of ['studentId', 'password', 'apiKey']) {
    const value = config[key];
    if (typeof value === 'string' && value.length >= 4) {
      credentials.push(...new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64')]));
    }
  }
}
const failures = [];
const seen = new Set();
function check(name, bytes) {
  seen.add(name);
  const base = path.posix.basename(name);
  const isThirdParty = allowedThirdParty.has(name);
  const forbidden = /(^|\/)(?:\.git|\.ssh|\.aws|dist|node_modules|MvSDKLog|logs)(\/|$)/i.test(name)
    || (/^config(?:\..*)?\.json(?:\..*)?$/i.test(base) && base !== 'config.example.json')
    || (/^\.env(?:\.|$)/i.test(base) && base !== '.env.example')
    || /^(?:credentials|secrets)/i.test(base)
    || /\.(?:exe|dll|piplug|zip|7z|gz|log|pem|key|p12|pfx|bak|old|tmp|pid)$/i.test(base)
    || ['.models-upstream.json', 'status.json'].includes(base);
  if (forbidden && !isThirdParty) failures.push(`${name}: private/generated file is not publishable`);
  if (isThirdParty) {
    const expected = THIRD_PARTY.get(name);
    if (!expected || sha256(bytes) !== expected) failures.push(`${name}: third-party artifact hash mismatch`);
    return;
  }
  if (credentials.some((value) => bytes.includes(Buffer.from(value)))) {
    failures.push(`${name}: matches a local credential (value suppressed)`);
  }
  const text = bytes.toString('utf8');
  if (/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    failures.push(`${name}: potential token/private key (value suppressed)`);
  }
  if (base === 'config.example.json') {
    const config = JSON.parse(text.replace(/^\uFEFF/, ''));
    for (const key of ['studentId', 'password', 'apiKey']) {
      if (config[key] !== '') failures.push(`${name}: ${key} must be an empty string`);
    }
  }
  if (base === 'LICENSE' && (!/GNU AFFERO GENERAL PUBLIC LICENSE/.test(text) || !/Version 3, 19 November 2007/.test(text))) {
    failures.push(`${name}: must contain the AGPL-3.0 license text`);
  }
  if (base === 'THIRD_PARTY_NOTICES.md' && (!/zju-connect v1\.3\.1/i.test(text) || !/AGPL-3\.0/i.test(text) || !/Corresponding Source|source archive/i.test(text))) {
    failures.push(`${name}: must document the bundled zju-connect v1.3.1 source and AGPL terms`);
  }
  if (name === 'third_party/README.md' && (!/FA131DDA15A053E4D3D51F2BA0B79278B5129AF6FA7E5AFFC05EAFC2ECA825AB/.test(text) || !/AEE7D8DBBF4DB98FBFF2B36D657094D95F3F6209DC3168914C62AEA01A8732BE/.test(text))) {
    failures.push(`${name}: must pin the source and binary hashes`);
  }
}
let count = 0;
if (directory) {
  const base = path.resolve(directory);
  function walk(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) { failures.push(`${name}: symlink forbidden`); continue; }
      if (entry.isDirectory()) walk(fullPath, name + '/');
      else { check(name, fs.readFileSync(fullPath)); count++; }
    }
  }
  walk(base);
} else if (args.length === 0) {
  const entries = git('ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    const [metadata, name] = entry.split('\t');
    const [mode, object, stage] = metadata.split(' ');
    if (!/^100(?:644|755)$/.test(mode) || stage !== '0') failures.push(`${name}: unsafe index entry`);
    check(name, git('cat-file', 'blob', object));
    count++;
  }
  for (const name of ['config.json', 'subdir/config.json', '.env', 'config.json.bak', 'bin/zju-connect.exe', 'dist/release.piplug']) {
    try { git('check-ignore', '--no-index', '-q', name); }
    catch { failures.push(`${name}: missing ignore rule`); }
  }
  const ignoredSource = git(
    'ls-files', '--others', '--ignored', '--exclude-standard', '--',
    'third_party/zju-connect-v1.3.1-source.zip',
  ).toString('utf8').trim();
  if (ignoredSource) failures.push('third_party/zju-connect-v1.3.1-source.zip: source archive must be tracked, not ignored');
} else {
  throw new Error('Usage: node scripts/check-publication.js [--directory DIRECTORY] [--full]');
}
if (!seen.has('third_party/zju-connect-v1.3.1-source.zip')) failures.push('missing pinned zju-connect source archive');
if (!seen.has('LICENSE')) failures.push('missing AGPL-3.0 LICENSE');
if (!seen.has('THIRD_PARTY_NOTICES.md')) failures.push('missing THIRD_PARTY_NOTICES.md');
if (full) {
  for (const name of ['bin/zju-connect.exe', 'third_party/README.md']) {
    if (!seen.has(name)) failures.push(`full package missing ${name}`);
  }
}
if (!count) failures.push('No publishable files found');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication scan passed: ${count} files; full=${full}; local credential comparison ${credentials.length ? 'enabled' : 'unavailable (no populated local config)'}.`);
  console.log('Heuristic checks do not replace a manual security review.');
}
