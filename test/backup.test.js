'use strict';

const { test, describe, before } = require('node:test');
const assert            = require('node:assert/strict');
const { spawn }         = require('node:child_process');
const fs                = require('node:fs');
const path              = require('node:path');
const pkg               = require('../package.json');

const ROOT = path.join(__dirname, '..');

// Minimal semver check for ranges like "^22.23.4 || ^24.22.1 || >=26.12.1".
const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
const gte   = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

const satisfies = (version, range) => range.split('||').map(s => s.trim()).some((part) => {
  const v = parse(version);
  if (part.startsWith('^'))  { const min = parse(part.slice(1)); return v[0] === min[0] && gte(v, min); }
  if (part.startsWith('>=')) return gte(v, parse(part.slice(2)));
  throw new Error(`Unsupported range: ${part}`);
});

test('engines.node range check works', () => {
  const range = '^22.23.4 || ^24.22.1 || >=26.12.1';
  for (const v of ['22.23.4', '24.22.1', '26.12.1', '27.0.0']) assert.ok(satisfies(v, range), v);
  for (const v of ['14.15.4', '20.19.0', '22.23.3', '24.22.0', '25.9.0', '26.12.0']) assert.ok(!satisfies(v, range), v);
});

test('running Node version satisfies engines.node (CVE-2026-111497)', () => {
  assert.ok(pkg.engines && pkg.engines.node, 'package.json must declare engines.node');
  assert.ok(satisfies(process.version, pkg.engines.node), `${process.version} does not satisfy ${pkg.engines.node}`);
});

test('scheduler starts with a clean log', async () => {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd : ROOT,
    env : { ...process.env, LOCAL_ENV: 'false', CRON_TIME: '0 0 1 1 *', CONFIG_FILE: path.join(__dirname, 'fixtures', 'config.json') },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`scheduler did not start\n${stdout}\n${stderr}`)), 10000);
    child.stdout.on('data', () => { if (stdout.includes('Next Schedule')) { clearTimeout(timer); resolve(); } });
  }).finally(() => child.kill('SIGTERM'));
  await new Promise((resolve) => child.on('close', resolve));

  const messages = stdout.trim().split('\n').map((l) => JSON.parse(l)).filter(e => e.level === 'info').map(e => e.message);
  assert.deepEqual(messages.slice(0, 2), ['Starting SOLR backup scheduler', 'CRON schedule: 0 0 1 1 *']);
  assert.match(messages[2], /^Next Schedule /);
  assert.equal(stderr, '', 'stderr must be empty (no warnings or deprecations)');
});

// Integration: a full backup cycle against a local Solr container and a local
// S3 fake. Needs the Docker socket and these env vars (see README "Testing"):
//   TEST_S3_ENDPOINT     e.g. http://dev-s3mock:9090 (never a real S3)
//   SOLR_CONTAINER_NAME  regex matching only the test Solr container
//   TEST_SOLR_CORES      comma separated cores expected in the backup (default: testcore)
const integration = process.env.TEST_S3_ENDPOINT && process.env.SOLR_CONTAINER_NAME;

describe('backup cycle (local Solr + S3 fake)', { skip: !integration && 'TEST_S3_ENDPOINT / SOLR_CONTAINER_NAME not set' }, () => {
  const bucket = process.env.S3_BUCKET        || 'solr-backup-test';
  const folder = process.env.S3_BUCKET_FOLDER || 'solr/test';
  const cores  = (process.env.TEST_SOLR_CORES || 'testcore').split(',');
  const env    = {
    ...process.env,
    S3_BUCKET        : bucket,
    S3_BUCKET_FOLDER : folder,
    CONFIG_FILE      : path.join(__dirname, 'fixtures', 'config.json'),
    LOCAL_ENV        : 'true',
    NODE_OPTIONS     : `--require ${path.join(__dirname, 'helpers', 's3-local.js')}`,
  };

  let s3;
  let existingKeys;
  let run;

  before(async () => {
    require('./helpers/s3-local.js');
    const AWS = require('aws-sdk');
    s3 = new AWS.S3({ ...require('./fixtures/config.json').awsAccessKeys.global, region: 'us-east-1' });

    await s3.createBucket({ Bucket: bucket }).promise().catch((e) => {
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(e.code)) throw e;
    });
    existingKeys = await listKeys();

    run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`backup timed out\n${stdout}\n${stderr}`)); }, 240000);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  });

  const listKeys = async () => (await s3.listObjects({ Bucket: bucket, Prefix: `${folder}/` }).promise()).Contents.map(o => o.Key);

  test('backup process exits 0 with a clean log', () => {
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.equal(run.stderr, '', 'stderr must be empty (no warnings or deprecations)');

    const entries = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const bad     = entries.filter(e => e.level !== 'info' && e.level !== 'debug');
    assert.deepEqual(bad, [], 'no warn/error log entries');

    const messages = entries.map(e => e.message);
    assert.ok(messages.includes(`Collections to backup: ${cores.length}`), messages.join('\n'));
    assert.ok(messages.includes('Finished Solr backup process'), messages.join('\n'));
  });

  test('uploads one Solr snapshot tar per core', async () => {
    const newKeys = (await listKeys()).filter(k => !existingKeys.includes(k));
    assert.equal(newKeys.length, cores.length, `new keys: ${newKeys.join(', ')}`);

    for (const core of cores) {
      const key = newKeys.find(k => new RegExp(`^${folder}/snapshot\\.${core}_\\d+\\.tar\\.gz$`).test(k));
      assert.ok(key, `no upload for core ${core} in ${newKeys.join(', ')}`);

      const { Body } = await s3.getObject({ Bucket: bucket, Key: key }).promise();
      const files    = tarEntries(Body);
      const prefix   = key.slice(folder.length + 1).replace(/\.tar\.gz$/, '');

      assert.ok(files.every(f => f.name.startsWith(`${prefix}/`)), `unexpected entries: ${files.map(f => f.name)}`);
      assert.ok(files.some(f => /\/segments_\w+$/.test(f.name) && f.size > 0), `no Lucene segments file in ${files.map(f => f.name)}`);
    }
  });

  test('removes the local temporary backup folder', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'backup-files')));
  });
});

// Lists entries of an uncompressed (ustar) archive as returned by the Docker archive API.
function tarEntries(buf) {
  const entries = [];
  let offset = 0;
  let longName;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const field  = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const size   = parseInt(field(124, 12).trim() || '0', 8);
    const type   = field(156, 1);
    const prefix = field(345, 155);
    let name     = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body   = buf.subarray(offset + 512, offset + 512 + size);

    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type !== 'x' && type !== 'g') {
      if (longName) { name = longName; longName = undefined; }
      entries.push({ name, size, type });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
