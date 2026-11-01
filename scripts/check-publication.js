'use strict';

// Scan the actual Git index, or an extracted public artifact. Never print secret values.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseConfigText } = require('../lib/config');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
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
function check(name, bytes) {
  const base = path.posix.basename(name);
  const forbidden = /(^|\/)(?:\.git|\.ssh|\.aws|dist|node_modules|MvSDKLog|logs)(\/|$)/i.test(name)
    || (/^config(?:\..*)?\.json(?:\..*)?$/i.test(base) && base !== 'config.example.json')
    || (/^\.env(?:\.|$)/i.test(base) && base !== '.env.example')
    || /^(?:credentials|secrets)/i.test(base)
    || /\.(?:exe|dll|piplug|zip|7z|gz|log|pem|key|p12|pfx|bak|old|tmp|pid)$/i.test(base)
    || ['.models-upstream.json', 'status.json'].includes(base);
  if (forbidden) failures.push(`${name}: private/generated file is not publishable`);
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
}
let count = 0;
if (process.argv[2] === '--directory' && process.argv[3]) {
  const directory = path.resolve(process.argv[3]);
  function walk(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) { failures.push(`${name}: symlink forbidden`); continue; }
      if (entry.isDirectory()) walk(full, name + '/');
      else { check(name, fs.readFileSync(full)); count++; }
    }
  }
  walk(directory);
} else if (process.argv.length === 2) {
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
} else {
  throw new Error('Usage: node scripts/check-publication.js [--directory DIRECTORY]');
}
if (!count) failures.push('No publishable files found');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication scan passed: ${count} files; local credential comparison ${credentials.length ? 'enabled' : 'unavailable (no populated local config)'}.`);
  console.log('Heuristic checks do not replace a manual security review.');
}
