'use strict';

const installer = require('../src/installer');

const skip = process.env.FUZZRUN_SKIP_ENABLE === '1';

if (skip) {
  process.stdout.write('fuzzrun: auto-enable skipped\n');
  process.exit(0);
}

try {
  installer.enable({});
  process.stdout.write('FuzzRun is automatically enabled. Run "fuzzrun disable" to deactivate.\n');
} catch (err) {
  process.stdout.write(`fuzzrun: auto-enable failed: ${err.message}\n`);
}
