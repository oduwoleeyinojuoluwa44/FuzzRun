#!/usr/bin/env node
// FuzzRun: minimal auto-correct runner for mistyped commands/subcommands.
// Runs the command once; if it fails, tries a high-confidence fix (edit distance 1 or CLI suggestion)
// and re-runs automatically.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DANGEROUS_BASE = new Set(['rm', 'mv', 'dd', 'shutdown', 'reboot', 'halt', 'poweroff']);

const COMMON_SUBCOMMANDS = {
  git: [
    'add',
    'bisect',
    'branch',
    'checkout',
    'clone',
    'commit',
    'diff',
    'fetch',
    'init',
    'log',
    'merge',
    'mv',
    'pull',
    'push',
    'rebase',
    'revert',
    'rm',
    'show',
    'stash',
    'status',
    'switch',
    'tag'
  ],
  npm: [
    'install',
    'init',
    'run',
    'test',
    'publish',
    'link',
    'login',
    'logout',
    'ci',
    'config',
    'cache',
    'start',
    'stop',
    'restart',
    'update',
    'outdated',
    'list',
    'prune',
    'exec',
    'root',
    'pack',
    'uninstall'
  ],
  yarn: [
    'add',
    'install',
    'remove',
    'run',
    'test',
    'init',
    'upgrade',
    'global',
    'dlx',
    'config',
    'list'
  ],
  pnpm: [
    'add',
    'install',
    'update',
    'remove',
    'run',
    'exec',
    'list',
    'publish',
    'install-test',
    'fetch'
  ],
  pip: ['install', 'uninstall', 'list', 'freeze', 'show', 'search', 'cache', 'config'],
  docker: [
    'build',
    'commit',
    'compose',
    'cp',
    'create',
    'diff',
    'events',
    'exec',
    'images',
    'info',
    'inspect',
    'kill',
    'load',
    'logs',
    'pause',
    'port',
    'ps',
    'pull',
    'push',
    'rename',
    'restart',
    'rm',
    'rmi',
    'run',
    'save',
    'start',
    'stats',
    'stop',
    'tag',
    'top',
    'unpause',
    'update',
    'version'
  ],
  kubectl: [
    'apply',
    'get',
    'describe',
    'delete',
    'logs',
    'exec',
    'create',
    'edit',
    'explain',
    'expose',
    'port-forward',
    'top',
    'cp',
    'scale',
    'rollout',
    'set',
    'explain',
    'label',
    'annotate',
    'cordon',
    'drain',
    'uncordon'
  ],
  gh: ['auth', 'repo', 'issue', 'pr', 'gist', 'alias', 'api', 'search', 'run', 'workflow', 'status', 'label']
};

const suggestionPatterns = [
  /The most similar command is\s+([^\s]+)/i,
  /The most similar commands are:\s*\n\s*([^\s]+)/i,
  /Did you mean\s+['"]?([A-Za-z0-9:_-]+)['"]?\??/i,
  /Unknown command\s+['"]?([A-Za-z0-9:_-]+)['"]?\??/i,
  /Perhaps you meant\s+['"]?([A-Za-z0-9:_-]+)['"]?\??/i
];

function levenshtein(a, b, maxDistance = 2) {
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let rowMin = maxDistance + 1;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (dp[i][j] < rowMin) rowMin = dp[i][j];
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
  }
  return dp[a.length][b.length];
}

function collectPathCommands() {
  const names = new Set();
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const allowedExts = new Set(
    (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .toLowerCase()
      .split(';')
      .filter(Boolean)
  );

  for (const entry of pathEntries) {
    try {
      const items = fs.readdirSync(entry, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) continue;
        if (process.platform === 'win32') {
          const ext = path.extname(item.name).toLowerCase();
          const base = path.basename(item.name, ext);
          if (!base) continue;
          if (ext && !allowedExts.has(ext)) continue;
          names.add(base);
        } else {
          names.add(item.name);
        }
      }
    } catch (err) {
      // Ignore unreadable PATH entries.
    }
  }
  return names;
}

const PATH_COMMANDS = collectPathCommands();

function bestMatch(candidates, target, maxDistance = 1) {
  let best = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates || []) {
    const dist = levenshtein(candidate, target, maxDistance);
    if (dist <= maxDistance && dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
      if (dist === 0) break;
    }
  }
  return best;
}

function parseSuggestion(text) {
  for (const pattern of suggestionPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe']
  });
  return {
    code: typeof result.status === 'number' ? result.status : result.error ? 1 : 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  };
}

function logFix(from, to) {
  process.stderr.write(`fuzzrun: auto-correcting "${from}" -> "${to}"\n`);
}

function tryBaseCorrection(command, args) {
  const suggestion = bestMatch(PATH_COMMANDS, command, 1);
  if (suggestion && !DANGEROUS_BASE.has(suggestion) && suggestion !== command) {
    logFix(command, suggestion);
    return run(suggestion, args);
  }
  return null;
}

function trySubcommandCorrection(command, args, combinedOutput) {
  if (!args.length) return null;
  const attemptedSub = args[0];
  const fromOutput = parseSuggestion(combinedOutput);
  const candidates = COMMON_SUBCOMMANDS[command] || [];
  const fromDict = bestMatch(candidates, attemptedSub, 1);
  const choice = fromOutput || fromDict;

  if (choice && choice !== attemptedSub && levenshtein(choice, attemptedSub, 1) <= 1) {
    logFix(`${command} ${attemptedSub}`, `${command} ${choice}`);
    return run(command, [choice, ...args.slice(1)]);
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    process.stderr.write('Usage: fuzzrun <command> [args...]\n');
    process.exit(1);
  }

  const baseCommand = argv[0];
  const rest = argv.slice(1);
  const firstRun = run(baseCommand, rest);

  if (firstRun.error && firstRun.error.code === 'ENOENT') {
    const corrected = tryBaseCorrection(baseCommand, rest);
    if (corrected) {
      process.stdout.write(corrected.stdout);
      process.stderr.write(corrected.stderr);
      process.exit(corrected.code);
    }
    process.stderr.write(firstRun.error.message ? `${firstRun.error.message}\n` : `fuzzrun: command not found: ${baseCommand}\n`);
    process.exit(firstRun.code);
  }

  if (firstRun.code === 0) {
    process.stdout.write(firstRun.stdout);
    process.stderr.write(firstRun.stderr);
    process.exit(0);
  }

  const combinedOutput = `${firstRun.stderr}\n${firstRun.stdout}`;
  const correctedSub = trySubcommandCorrection(baseCommand, rest, combinedOutput);
  if (correctedSub) {
    process.stdout.write(correctedSub.stdout);
    process.stderr.write(correctedSub.stderr);
    process.exit(correctedSub.code);
  }

  process.stdout.write(firstRun.stdout);
  process.stderr.write(firstRun.stderr);
  process.exit(firstRun.code);
}

main();
