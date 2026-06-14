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

test('stats reports nothing recorded on a fresh state', () => {
  const home = makeTempHome();
  try {
    const result = runFuzzrun(['stats'], {
      FUZZRUN_SKIP_ENABLE: '1',
      HOME: home,
      USERPROFILE: home
    });

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('No corrections recorded yet'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('explain previews a base fix without running it and records nothing', () => {
  const home = makeTempHome();
  try {
    const result = runFuzzrun(['explain', 'nodee', '-e', "process.stdout.write('SHOULD_NOT_RUN')"], {
      FUZZRUN_SKIP_ENABLE: '1',
      HOME: home,
      USERPROFILE: home
    });

    assert.ok(result.stderr.includes('would correct'));
    assert.ok(result.stderr.includes('nodee'));
    assert.ok(result.stderr.includes('node'));
    // Dry-run must neither run the command nor persist any fix.
    assert.ok(!result.stdout.includes('SHOULD_NOT_RUN'));
    const statePath = path.join(home, '.fuzzrun', 'state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.ok(!state.totalFixes);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('auto-corrects a mistyped base command and records it for stats', () => {
  const home = makeTempHome();
  try {
    const env = { FUZZRUN_SKIP_ENABLE: '1', HOME: home, USERPROFILE: home, FUZZRUN_YES: '1' };
    const result = runFuzzrun(['nodee', '-e', "process.stdout.write('CORRECTED_OK')"], env);

    assert.ok(result.stderr.includes('auto-correcting'));
    assert.ok(result.stdout.includes('CORRECTED_OK'));

    const stats = runFuzzrun(['stats'], env);
    assert.ok(stats.stdout.includes('rescued'));
    assert.ok(stats.stdout.includes('nodee'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
