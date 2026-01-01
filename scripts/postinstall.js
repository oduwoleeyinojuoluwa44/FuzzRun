'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('../src/installer');

const skip = process.env.FUZZRUN_SKIP_ENABLE === '1';

function getStatePath() {
  return path.join(os.homedir(), '.fuzzrun', 'state.json');
}

function writeState(next) {
  const filePath = getStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
}

if (skip) {
  process.stderr.write('fuzzrun: auto-enable skipped\n');
  process.exit(0);
}

const foregroundScripts =
  process.env.npm_config_foreground_scripts === 'true' ||
  process.env.npm_config_foreground_scripts === '1';

try {
  installer.enable({});
  process.stderr.write('FuzzRun is automatically enabled. Run "fuzzrun disable" to deactivate.\n');
  writeState({ bannerShown: foregroundScripts, enableSucceeded: true });
} catch (err) {
  process.stderr.write(`fuzzrun: auto-enable failed: ${err.message}\n`);
  writeState({ bannerShown: false, enableSucceeded: false, lastError: err.message });
}
