'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'fuzzrun.js');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fuzzrun-test-'));
}

function runFuzzrun(args, envOverrides) {
  const env = { ...process.env, ...envOverrides };
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    encoding: 'utf8',
    env
  });
}

test('skips install banner when FUZZRUN_SKIP_ENABLE=1', () => {
  const home = makeTempHome();
  try {
    const result = runFuzzrun(
      [process.execPath, '-e', "process.stdout.write('ok')"],
      {
        FUZZRUN_SKIP_ENABLE: '1',
        HOME: home,
        USERPROFILE: home
      }
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'ok');
    assert.ok(!result.stderr.includes('FuzzRun is automatically enabled'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('prints a friendly message when the command is missing', () => {
  const home = makeTempHome();
  const missing = 'fuzzrun-missing-command-zz9';
  try {
    const result = runFuzzrun([missing], {
      FUZZRUN_SKIP_ENABLE: '1',
      HOME: home,
      USERPROFILE: home,
      PATH: ''
    });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`fuzzrun: command not found: ${missing}`));
    assert.ok(!result.stderr.includes('spawnSync'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
