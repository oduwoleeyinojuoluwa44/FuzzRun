'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_START = '# >>> fuzzrun start';
const MARKER_END = '# <<< fuzzrun end';

const WRAP_BASES = ['git', 'npm', 'yarn', 'pnpm', 'pip', 'docker', 'kubectl', 'gh'];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BLOCK_REGEX = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\s*`, 'g');

function getPackageRoot(explicitRoot) {
  if (explicitRoot) return explicitRoot;
  return path.resolve(__dirname, '..');
}

function getBinPath(packageRoot) {
  return path.resolve(packageRoot, 'bin', 'fuzzrun.js');
}

function getProfileTargets() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const roots = new Set([path.join(home, 'Documents')]);
    const oneDriveRoots = [
      process.env.OneDrive,
      process.env.OneDriveConsumer,
      process.env.OneDriveCommercial
    ].filter(Boolean);
    for (const root of oneDriveRoots) {
      roots.add(path.basename(root).toLowerCase() === 'documents' ? root : path.join(root, 'Documents'));
    }
    const targets = [];
    for (const root of roots) {
      targets.push(path.join(root, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'));
      targets.push(path.join(root, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'));
    }
    return [...new Set(targets)];
  }
  return [path.join(home, '.bashrc'), path.join(home, '.zshrc')];
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function stripBlock(content) {
  return content.replace(BLOCK_REGEX, '').trimEnd();
}

function buildPowerShellSnippet(binPath) {
  const lines = [
    MARKER_START,
    `$fuzzrun = "${binPath}"`,
    '$global:FuzzRunLastLine = $null',
    'if (Get-Module -ListAvailable -Name PSReadLine) {',
    '    try {',
    '        Import-Module PSReadLine -ErrorAction SilentlyContinue | Out-Null',
    '        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {',
    '            param($key, $arg)',
    '            $line = $null',
    '            $cursor = $null',
    '            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)',
    '            $global:FuzzRunLastLine = $line',
    '            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()',
    '        }',
    '    } catch {}',
    '}',
    'function global:fuzzrun { node $fuzzrun @args }',
    '$ExecutionContext.InvokeCommand.CommandNotFoundAction = {',
    '    param($commandName, $eventArgs)',
    '    $cmd = $commandName',
    '    $fzArgs = @($eventArgs.Arguments)',
    '    $line = $global:FuzzRunLastLine',
    '    $global:FuzzRunLastLine = $null',
    '    if (-not $line -and $eventArgs.CommandLine) {',
    '        $line = $eventArgs.CommandLine',
    '    }',
    '    if (-not $line -and $eventArgs.CommandScriptBlock) {',
    '        $line = $eventArgs.CommandScriptBlock.ToString()',
    '    }',
    '    if (-not $line) {',
    '        $history = Get-History -Count 1 -ErrorAction SilentlyContinue',
    '        if ($history) { $line = $history.CommandLine }',
    '    }',
    '    $argv = @()',
    '    if ($line) {',
    '        $tokens = [System.Management.Automation.PSParser]::Tokenize($line, [ref]$null)',
    "        foreach ($token in $tokens) {",
    "            if ($token.Type -in @('Command','CommandArgument','CommandParameter','String','Number')) {",
    '                $argv += $token.Content',
    '            }',
    '        }',
    '    }',
    '    if ($argv.Count -gt 0) {',
    '        $cmd = $argv[0]',
    '    }',
    '    if ($argv.Count -gt 1) {',
    '        $fzArgs = $argv[1..($argv.Count - 1)]',
    '    }',
    '    $eventArgs.CommandScriptBlock = { fuzzrun $cmd @fzArgs }.GetNewClosure()',
    '    $eventArgs.StopSearch = $true',
    '}'
  ];
  lines.push(`$__fuzzrunBases = @(${WRAP_BASES.map((base) => `'${base}'`).join(', ')})`);
  lines.push('foreach ($base in $__fuzzrunBases) {');
  lines.push('    $resolved = Get-Command $base -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -eq "Application" } | Select-Object -First 1');
  lines.push('    if ($resolved) {');
  lines.push('        $cmdName = $base');
  lines.push('        Set-Item -Path ("Function:$cmdName") -Value { fuzzrun $cmdName @args }.GetNewClosure()');
  lines.push('    }');
  lines.push('}');
  lines.push(MARKER_END, '');
  return lines.join('\n');
}

function buildUnixSnippet(binPath) {
  const lines = [
    MARKER_START,
    `FUZZRUN_BIN="${binPath}"`,
    'fuzzrun() { node "$FUZZRUN_BIN" "$@"; }',
    'command_not_found_handle() { fuzzrun "$@"; }',
    'command_not_found_handler() { fuzzrun "$@"; }'
  ];
  for (const base of WRAP_BASES) {
    lines.push(`${base}() { fuzzrun ${base} "$@"; }`);
  }
  lines.push(MARKER_END, '');
  return lines.join('\n');
}

function updateProfile(filePath, snippet) {
  const exists = fs.existsSync(filePath);
  const content = exists ? fs.readFileSync(filePath, 'utf8') : '';
  const cleaned = stripBlock(content);
  const spacer = cleaned.length ? '\n\n' : '';
  const nextContent = `${cleaned}${spacer}${snippet}`;
  ensureDir(filePath);
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return { updated: content !== nextContent, path: filePath };
}

function removeProfileSnippet(filePath) {
  if (!fs.existsSync(filePath)) {
    return { updated: false, path: filePath };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const cleaned = stripBlock(content);
  if (cleaned === content) {
    return { updated: false, path: filePath };
  }
  ensureDir(filePath);
  fs.writeFileSync(filePath, cleaned ? `${cleaned}\n` : '', 'utf8');
  return { updated: true, path: filePath };
}

function pickTargets() {
  const targets = getProfileTargets();
  if (process.platform === 'win32') {
    return targets;
  }
  const existing = targets.filter((target) => fs.existsSync(target));
  if (existing.length) return existing;
  return [targets[0]];
}

function enable({ packageRoot } = {}) {
  const root = getPackageRoot(packageRoot);
  const binPath = getBinPath(root);
  const targets = pickTargets();
  const snippet = process.platform === 'win32' ? buildPowerShellSnippet(binPath) : buildUnixSnippet(binPath);
  return targets.map((target) => updateProfile(target, snippet));
}

function disable() {
  const targets = getProfileTargets().filter((target) => fs.existsSync(target));
  return targets.map((target) => removeProfileSnippet(target));
}

function status() {
  const targets = getProfileTargets();
  return targets.map((target) => {
    if (!fs.existsSync(target)) {
      return { path: target, enabled: false };
    }
    const content = fs.readFileSync(target, 'utf8');
    return { path: target, enabled: content.includes(MARKER_START) && content.includes(MARKER_END) };
  });
}

module.exports = {
  enable,
  disable,
  status
};
