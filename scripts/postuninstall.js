'use strict';

const installer = require('../src/installer');

try {
  installer.disable();
  process.stderr.write('FuzzRun hooks removed. Restart your terminal if needed.\n');
} catch (err) {
  process.stderr.write(`fuzzrun: postuninstall cleanup failed: ${err.message}\n`);
}
