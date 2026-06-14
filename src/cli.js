#!/usr/bin/env node
// FuzzRun: minimal auto-correct runner for mistyped commands/subcommands.
// Runs the command once; if it fails, tries a high-confidence fix (edit distance 1 or CLI suggestion)
// and re-runs automatically.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('./installer');

const MAX_DISTANCE = Number.isFinite(Number(process.env.FUZZRUN_MAX_DISTANCE))
  ? Math.max(1, Number(process.env.FUZZRUN_MAX_DISTANCE))
  : 1;

// --- Output styling (zero-dependency ANSI) -------------------------------
const USE_COLOR =
  !process.env.NO_COLOR &&
  process.env.FUZZRUN_NO_COLOR !== '1' &&
  (process.stderr.isTTY || process.env.FUZZRUN_FORCE_COLOR === '1');

function paint(code, text) {
  return USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const cyan = (t) => paint('36', t);
const yellow = (t) => paint('33', t);
const BOLT = USE_COLOR ? '⚡ ' : '';

// --- Runtime modes -------------------------------------------------------
// Dry-run: detect and report the fix but never run the corrected command.
let DRY_RUN = process.env.FUZZRUN_DRY_RUN === '1';

const DEFAULT_PRIORITY_BASES = [
  'git',
  'npm',
  'yarn',
  'pnpm',
  'node',
  'python',
  'python3',
  'pip',
  'pip3',
  'docker',
  'kubectl',
  'gh',
  'go',
  'cargo',
  'dotnet',
  'java',
  'mvn',
  'gradle'
];
const ENV_PRIORITY_BASES = (process.env.FUZZRUN_PREFER_BASES || '')
  .split(',')
  .map((value) => normalizeToken(value).trim())
  .filter(Boolean);
const PRIORITY_BASES = new Set([...DEFAULT_PRIORITY_BASES, ...ENV_PRIORITY_BASES]);

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

// Common long flags per base, used for fuzzy flag correction. Dangerous flags
// are intentionally omitted so we never auto-correct *into* a destructive flag.
const COMMON_FLAGS = {
  git: [
    '--message',
    '--all',
    '--amend',
    '--branch',
    '--verbose',
    '--quiet',
    '--patch',
    '--set-upstream',
    '--no-edit',
    '--global',
    '--list',
    '--oneline',
    '--graph',
    '--staged',
    '--cached'
  ],
  npm: [
    '--save',
    '--save-dev',
    '--save-exact',
    '--global',
    '--production',
    '--legacy-peer-deps',
    '--workspace',
    '--workspaces',
    '--package-lock',
    '--prefix'
  ],
  docker: [
    '--detach',
    '--interactive',
    '--tty',
    '--name',
    '--volume',
    '--publish',
    '--env',
    '--file',
    '--network',
    '--restart',
    '--workdir'
  ],
  kubectl: ['--namespace', '--output', '--selector', '--filename', '--context', '--all-namespaces'],
  gh: ['--repo', '--web', '--title', '--body', '--label', '--assignee', '--milestone']
};

const SAFE_SUBCOMMAND_BASES = new Set(Object.keys(COMMON_SUBCOMMANDS));
const SAFE_FLAG_BASES = new Set(Object.keys(COMMON_FLAGS));
const ALLOW_ANY_SUBCOMMANDS = process.env.FUZZRUN_ALLOW_ANY_SUBCOMMANDS === '1';
const SCRIPT_BASES = new Set(['npm', 'yarn', 'pnpm']);
const RISKY_ARG_PATTERNS = [
  /^-f$/,
  /^-rf$/,
  /^-fr$/,
  /^--force$/i,
  /^--hard$/i,
  /^--delete$/i,
  /^--purge$/i,
  /^--no-preserve-root$/i
];
const SCRIPT_ERROR_PATTERNS = [
  /missing script/i,
  /unknown script/i,
  /script.*not found/i,
  /couldn'?t find.*script/i,
  /command ".*" not found/i
];
const FLAG_ERROR_PATTERNS = [
  /unknown option/i,
  /unrecognized option/i,
  /invalid option/i,
  /unknown flag/i,
  /unknown switch/i,
  /did you mean/i,
  /no such option/i
];
const GIT_PATHSPEC_PATTERN = /pathspec .* did not match/i;

const suggestionPatterns = [
  /The most similar command is\s+([^\s]+)/i,
  /The most similar commands are:\s*\n\s*([^\s]+)/i,
  /Did you mean\s+['"]?([A-Za-z0-9:_-]+)['"]?\??/i,
  /Unknown command\s+['"]?([A-Za-z0-9:_-]+)['"]?\??/i,
  /Perhaps you meant\s+['"]?([A-Za-z0-9:_-]+)['"]?\??/i
];

function getStatePath() {
  return path.join(os.homedir(), '.fuzzrun', 'state.json');
}

function readState() {
  try {
    const raw = fs.readFileSync(getStatePath(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function writeState(next) {
  try {
    const filePath = getStatePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    // Best-effort only.
  }
}

function updateState(patch) {
  const state = readState() || {};
  const next = { ...state, ...patch };
  writeState(next);
  return next;
}

// In-memory copy of persisted state, loaded once. Used for learning + stats.
const STATE = readState() || {};

// Record an accepted correction so we can learn typo->fix preferences and
// power `fuzzrun stats`.
function recordFix(kind, fromToken, toToken) {
  try {
    STATE.totalFixes = (STATE.totalFixes || 0) + 1;
    STATE.byKind = STATE.byKind || {};
    STATE.byKind[kind] = (STATE.byKind[kind] || 0) + 1;
    STATE.history = STATE.history || {};
    const key = normalizeToken(fromToken);
    const entry = STATE.history[key] || { from: fromToken, to: toToken, count: 0 };
    entry.to = toToken;
    entry.count += 1;
    entry.kind = kind;
    entry.last = new Date().toISOString();
    STATE.history[key] = entry;
    STATE.firstFixAt = STATE.firstFixAt || entry.last;
    writeState(STATE);
  } catch (err) {
    // Best-effort only.
  }
}

// If the user has accepted a correction for this exact typo before, return the
// normalized target so we can break ambiguous ties in its favor.
function learnedChoiceFor(target) {
  const entry = STATE.history && STATE.history[normalizeToken(target)];
  return entry && entry.to ? normalizeToken(entry.to) : null;
}

function showInstallBannerOnce() {
  if (process.env.FUZZRUN_SKIP_ENABLE === '1') return;
  const state = readState() || {};
  if (state.bannerShown || state.disabled) return;
  const message =
    state.enableSucceeded === false
      ? 'FuzzRun auto-enable failed during install. Run "fuzzrun enable" to activate.\n'
      : 'FuzzRun is automatically enabled. Run "fuzzrun disable" to deactivate.\n';
  process.stderr.write(message);
  state.bannerShown = true;
  if (typeof state.enableSucceeded === 'undefined') {
    state.enableSucceeded = true;
  }
  writeState(state);
}

function normalizeToken(value) {
  return String(value || '').toLowerCase();
}

function damerauLevenshtein(a, b, maxDistance = 2) {
  const aNorm = normalizeToken(a);
  const bNorm = normalizeToken(b);
  if (aNorm === bNorm) return 0;
  if (Math.abs(aNorm.length - bNorm.length) > maxDistance) {
    return maxDistance + 1;
  }
  const dp = Array.from({ length: aNorm.length + 1 }, () => new Array(bNorm.length + 1).fill(0));
  for (let i = 0; i <= aNorm.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= bNorm.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= aNorm.length; i += 1) {
    let rowMin = maxDistance + 1;
    for (let j = 1; j <= bNorm.length; j += 1) {
      const cost = aNorm[i - 1] === bNorm[j - 1] ? 0 : 1;
      let value = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && aNorm[i - 1] === bNorm[j - 2] && aNorm[i - 2] === bNorm[j - 1]) {
        value = Math.min(value, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
  }
  return dp[aNorm.length][bNorm.length];
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

function normalizePowerShellGetPrefix(command) {
  if (!command) return command;
  const lowered = normalizeToken(command);
  if (!lowered.startsWith('get-')) return command;
  if (PATH_COMMANDS.has(command) || PATH_COMMANDS.has(lowered)) return command;
  const stripped = command.slice(4);
  if (!stripped) return command;
  if (PATH_COMMANDS.has(stripped)) return stripped;
  const match = findBestMatch(PATH_COMMANDS, stripped, MAX_DISTANCE);
  if (match) return stripped;
  return command;
}

function findBestMatch(candidates, target, maxDistance = MAX_DISTANCE) {
  if (!candidates || !target) return null;
  let best = null;
  let bestDistance = maxDistance + 1;
  let ties = [];
  for (const candidate of candidates || []) {
    const dist = damerauLevenshtein(candidate, target, maxDistance);
    if (dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
      ties = [candidate];
    } else if (dist === bestDistance) {
      ties.push(candidate);
    }
  }
  if (!best || bestDistance > maxDistance) return null;
  if (ties.length > 1) {
    // Prefer a choice the user has accepted before for this exact typo.
    const learned = learnedChoiceFor(target);
    if (learned) {
      const learnedHits = ties.filter((value) => normalizeToken(value) === learned);
      if (learnedHits.length === 1) {
        return { match: learnedHits[0], distance: bestDistance };
      }
    }
    const preferred = ties.filter((value) => PRIORITY_BASES.has(normalizeToken(value)));
    if (preferred.length === 1) {
      return { match: preferred[0], distance: bestDistance };
    }
    return null;
  }
  return { match: best, distance: bestDistance };
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

// Ask a yes/no question synchronously on the controlling terminal. Defaults to
// "yes" when we cannot prompt (no TTY), so non-interactive use is unaffected.
function confirm(question) {
  if (!process.stdin.isTTY) return true;
  process.stderr.write(`${question} ${dim('[Y/n]')} `);
  const buf = Buffer.alloc(16);
  try {
    const bytes = fs.readSync(0, buf, 0, buf.length, null);
    const answer = buf.toString('utf8', 0, bytes).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } catch (err) {
    return true;
  }
}

// Confidence-tiered: distance-1 fixes auto-run; weaker (distance >= 2) fixes ask
// first. FUZZRUN_PROMPT=1 forces a prompt for every fix; FUZZRUN_YES=1 never asks.
function shouldPrompt(distance) {
  if (DRY_RUN) return false;
  if (process.env.FUZZRUN_YES === '1') return false;
  if (process.env.FUZZRUN_PROMPT === '1') return true;
  return typeof distance === 'number' && distance >= 2;
}

function announceFix(fromDisplay, toDisplay) {
  const verb = DRY_RUN ? 'would correct' : 'auto-correcting';
  const arrow = cyan('->');
  process.stderr.write(
    `${BOLT}${dim('fuzzrun:')} ${verb} ${dim(fromDisplay)} ${arrow} ${bold(green(toDisplay))}\n`
  );
}

// Single chokepoint for applying a correction: announces it, honors dry-run and
// the confidence prompt, records the fix for learning/stats, then runs it.
function executeCorrection(command, args, meta) {
  announceFix(meta.fromDisplay, meta.toDisplay);
  if (DRY_RUN) {
    return { code: 0, stdout: '', stderr: '', dryRun: true };
  }
  if (shouldPrompt(meta.distance) && !confirm('Run it?')) {
    process.stderr.write(`${dim('fuzzrun: skipped.')}\n`);
    return { code: 130, stdout: '', stderr: '', declined: true };
  }
  recordFix(meta.kind, meta.fromTok, meta.toTok);
  return run(command, args);
}

function hasRiskyArgs(args) {
  return args.some((arg) => RISKY_ARG_PATTERNS.some((pattern) => pattern.test(arg)));
}

function tryBaseCorrection(command, args) {
  if (hasRiskyArgs(args)) return null;
  const suggestion = findBestMatch(PATH_COMMANDS, command, MAX_DISTANCE);
  if (suggestion && !DANGEROUS_BASE.has(suggestion.match) && suggestion.match !== command) {
    const result = executeCorrection(suggestion.match, args, {
      kind: 'base',
      fromDisplay: command,
      toDisplay: suggestion.match,
      fromTok: command,
      toTok: suggestion.match,
      distance: suggestion.distance
    });
    return {
      command: suggestion.match,
      args,
      result
    };
  }
  return null;
}

function trySubcommandCorrection(command, args, combinedOutput) {
  if (!SAFE_SUBCOMMAND_BASES.has(command) && !ALLOW_ANY_SUBCOMMANDS) return null;
  if (!args.length) return null;
  const attemptedSub = args[0];
  if (attemptedSub.startsWith('-')) return null;
  if (hasRiskyArgs(args)) return null;
  const fromOutput = parseSuggestion(combinedOutput);
  const candidates = COMMON_SUBCOMMANDS[command] || [];
  const fromDict = findBestMatch(candidates, attemptedSub, MAX_DISTANCE);
  const outputDistance = fromOutput
    ? damerauLevenshtein(fromOutput, attemptedSub, MAX_DISTANCE)
    : MAX_DISTANCE + 1;
  const choice = outputDistance <= MAX_DISTANCE ? fromOutput : fromDict ? fromDict.match : null;
  const distance = outputDistance <= MAX_DISTANCE ? outputDistance : fromDict ? fromDict.distance : undefined;

  if (choice && choice !== attemptedSub && damerauLevenshtein(choice, attemptedSub, MAX_DISTANCE) <= MAX_DISTANCE) {
    return executeCorrection(command, [choice, ...args.slice(1)], {
      kind: 'subcommand',
      fromDisplay: `${command} ${attemptedSub}`,
      toDisplay: `${command} ${choice}`,
      fromTok: attemptedSub,
      toTok: choice,
      distance
    });
  }
  return null;
}

function isFlagError(output) {
  return FLAG_ERROR_PATTERNS.some((pattern) => pattern.test(output));
}

// Correct a single mistyped long flag (e.g. `git commit --mesage` -> `--message`).
function tryFlagCorrection(command, args, combinedOutput) {
  if (!SAFE_FLAG_BASES.has(command)) return null;
  if (!isFlagError(combinedOutput)) return null;
  if (hasRiskyArgs(args)) return null;
  const candidates = (COMMON_FLAGS[command] || []).filter(
    (flag) => !RISKY_ARG_PATTERNS.some((pattern) => pattern.test(flag))
  );
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.split('=')[0];
    if (candidates.includes(name)) continue;
    if (RISKY_ARG_PATTERNS.some((pattern) => pattern.test(name))) continue;
    const match = findBestMatch(candidates, name, MAX_DISTANCE);
    if (match) {
      const fixedArgs = args.slice();
      fixedArgs[i] = arg.includes('=')
        ? `${match.match}=${arg.slice(arg.indexOf('=') + 1)}`
        : match.match;
      return executeCorrection(command, fixedArgs, {
        kind: 'flag',
        fromDisplay: `${command} ${name}`,
        toDisplay: `${command} ${match.match}`,
        fromTok: name,
        toTok: match.match,
        distance: match.distance
      });
    }
  }
  return null;
}

function findPackageJson(startDir) {
  let current = startDir;
  while (current && current !== path.dirname(current)) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return null;
}

function getPackageScripts(cwd) {
  const pkgPath = findPackageJson(cwd);
  if (!pkgPath) return [];
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.keys(parsed.scripts || {});
  } catch (err) {
    return [];
  }
}

function isScriptError(output) {
  return SCRIPT_ERROR_PATTERNS.some((pattern) => pattern.test(output));
}

function tryScriptCorrection(command, args, combinedOutput) {
  if (!SCRIPT_BASES.has(command)) return null;
  if (args.length < 2) return null;
  if (args[0] !== 'run') return null;
  const scriptName = args[1];
  if (!scriptName || scriptName.startsWith('-')) return null;
  if (!isScriptError(combinedOutput)) return null;
  if (hasRiskyArgs(args)) return null;

  const scripts = getPackageScripts(process.cwd());
  const match = findBestMatch(scripts, scriptName, MAX_DISTANCE);
  if (match) {
    return executeCorrection(command, ['run', match.match, ...args.slice(2)], {
      kind: 'script',
      fromDisplay: `${command} run ${scriptName}`,
      toDisplay: `${command} run ${match.match}`,
      fromTok: scriptName,
      toTok: match.match,
      distance: match.distance
    });
  }
  return null;
}

function getGitBranches() {
  const result = spawnSync('git', ['branch', '--format=%(refname:short)'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function tryGitBranchCorrection(command, args, combinedOutput) {
  if (command !== 'git') return null;
  if (args.length < 2) return null;
  const subcommand = args[0];
  if (subcommand !== 'checkout' && subcommand !== 'switch') return null;
  const branch = args[1];
  if (!branch || branch.startsWith('-')) return null;
  if (!GIT_PATHSPEC_PATTERN.test(combinedOutput)) return null;
  if (hasRiskyArgs(args)) return null;

  const branches = getGitBranches();
  const match = findBestMatch(branches, branch, MAX_DISTANCE);
  if (match) {
    return executeCorrection(command, [subcommand, match.match, ...args.slice(2)], {
      kind: 'branch',
      fromDisplay: `${command} ${subcommand} ${branch}`,
      toDisplay: `${command} ${subcommand} ${match.match}`,
      fromTok: branch,
      toTok: match.match,
      distance: match.distance
    });
  }
  return null;
}

function formatDuration(fromIso) {
  if (!fromIso) return null;
  const start = Date.parse(fromIso);
  if (Number.isNaN(start)) return null;
  const days = Math.max(0, Math.floor((Date.now() - start) / 86400000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function printStats() {
  const state = readState() || {};
  const total = state.totalFixes || 0;
  const heading = bold(cyan(`${BOLT}FuzzRun stats`));
  if (!total) {
    process.stdout.write(`${heading}\n  No corrections recorded yet. Go make some typos!\n`);
    return;
  }
  const since = formatDuration(state.firstFixAt);
  const lines = [heading];
  lines.push(`  ${bold(String(total))} commands rescued${since ? dim(` over the last ${since}`) : ''}.`);

  const byKind = state.byKind || {};
  const kinds = Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a]);
  if (kinds.length) {
    lines.push('  ' + dim('by type: ') + kinds.map((k) => `${k} ${bold(String(byKind[k]))}`).join(', '));
  }

  const history = state.history || {};
  const top = Object.values(history)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (top.length) {
    lines.push('  ' + dim('top typos:'));
    for (const entry of top) {
      lines.push(
        `    ${dim(entry.from || '?')} ${cyan('->')} ${green(entry.to || '?')} ${dim(`x${entry.count}`)}`
      );
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  let argv = process.argv.slice(2);
  if (!argv.length) {
    process.stderr.write('Usage: fuzzrun <command> [args...]\n');
    process.exit(1);
  }

  showInstallBannerOnce();

  let action = argv[0];

  // `fuzzrun explain <command...>` = dry-run: show the fix without running it.
  if (action === 'explain' || action === '--dry-run') {
    DRY_RUN = true;
    argv = argv.slice(1);
    if (!argv.length) {
      process.stderr.write('Usage: fuzzrun explain <command> [args...]\n');
      process.exit(1);
    }
    action = argv[0];
  }

  if (action === 'enable') {
    const results = installer.enable({});
    const updated = results.some((item) => item.updated);
    process.stdout.write(updated ? 'FuzzRun enabled. Restart your shell to apply changes.\n' : 'FuzzRun already enabled.\n');
    updateState({ disabled: false, enableSucceeded: true });
    process.exit(0);
  }
  if (action === 'disable') {
    const results = installer.disable();
    const updated = results.some((item) => item.updated);
    process.stdout.write(updated ? 'FuzzRun disabled. Restart your shell to apply changes.\n' : 'FuzzRun already disabled.\n');
    updateState({ disabled: true });
    process.exit(0);
  }
  if (action === 'status') {
    const results = installer.status();
    for (const item of results) {
      process.stdout.write(`${item.enabled ? 'enabled' : 'disabled'}: ${item.path}\n`);
    }
    process.exit(0);
  }
  if (action === 'stats') {
    printStats();
    process.exit(0);
  }

  const state = readState() || {};
  if (!state.disabled && process.env.FUZZRUN_SKIP_ENABLE !== '1') {
    try {
      const status = installer.status();
      const anyEnabled = status.some((item) => item.enabled);
      if (!anyEnabled) {
        const results = installer.enable({});
        const updated = results.some((item) => item.updated);
        if (updated) {
          process.stdout.write('FuzzRun auto-enabled. Restart your shell to apply changes.\n');
        }
      }
    } catch (err) {
      process.stderr.write(`fuzzrun: auto-enable failed: ${err.message}\n`);
    }
  }

  let baseCommand = argv[0];
  const rest = argv.slice(1);
  baseCommand = normalizePowerShellGetPrefix(baseCommand);
  const firstRun = run(baseCommand, rest);

  if (firstRun.error && firstRun.error.code === 'ENOENT') {
    const corrected = tryBaseCorrection(baseCommand, rest);
    if (corrected) {
      const { result } = corrected;
      if (result.declined) {
        process.exit(result.code);
      }
      if (result.dryRun) {
        process.exit(0);
      }
      if (result.code !== 0) {
        const combinedOutput = `${result.stderr}\n${result.stdout}`;
        const correctedSub = trySubcommandCorrection(corrected.command, corrected.args, combinedOutput);
        if (correctedSub) {
          process.stdout.write(correctedSub.stdout);
          process.stderr.write(correctedSub.stderr);
          process.exit(correctedSub.code);
        }
        const correctedScript = tryScriptCorrection(corrected.command, corrected.args, combinedOutput);
        if (correctedScript) {
          process.stdout.write(correctedScript.stdout);
          process.stderr.write(correctedScript.stderr);
          process.exit(correctedScript.code);
        }
        const correctedFlag = tryFlagCorrection(corrected.command, corrected.args, combinedOutput);
        if (correctedFlag) {
          process.stdout.write(correctedFlag.stdout);
          process.stderr.write(correctedFlag.stderr);
          process.exit(correctedFlag.code);
        }
        const correctedBranch = tryGitBranchCorrection(corrected.command, corrected.args, combinedOutput);
        if (correctedBranch) {
          process.stdout.write(correctedBranch.stdout);
          process.stderr.write(correctedBranch.stderr);
          process.exit(correctedBranch.code);
        }
      }
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.code);
    }
    process.stderr.write(`fuzzrun: command not found: ${baseCommand}\n`);
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

  const correctedScript = tryScriptCorrection(baseCommand, rest, combinedOutput);
  if (correctedScript) {
    process.stdout.write(correctedScript.stdout);
    process.stderr.write(correctedScript.stderr);
    process.exit(correctedScript.code);
  }

  const correctedFlag = tryFlagCorrection(baseCommand, rest, combinedOutput);
  if (correctedFlag) {
    process.stdout.write(correctedFlag.stdout);
    process.stderr.write(correctedFlag.stderr);
    process.exit(correctedFlag.code);
  }

  const correctedBranch = tryGitBranchCorrection(baseCommand, rest, combinedOutput);
  if (correctedBranch) {
    process.stdout.write(correctedBranch.stdout);
    process.stderr.write(correctedBranch.stderr);
    process.exit(correctedBranch.code);
  }

  process.stdout.write(firstRun.stdout);
  process.stderr.write(firstRun.stderr);
  process.exit(firstRun.code);
}

if (require.main === module) {
  main();
}

module.exports = { main };
