## FuzzRun (prototype)

Auto-correct mistyped commands/subcommands and re-run them automatically (no prompt) when the fix is high-confidence (edit distance 1 or the CLI provides a single suggestion). Base command corrections skip dangerous commands like `rm` or `mv`.

### Quick run

```
node bin/fuzzrun.js git commmmit -m "msg"
```

Install (npm):

```
npm i -g fuzzrunx
```

On global install, FuzzRun auto-enables shell hooks and will print:
`FuzzRun is automatically enabled. Run "fuzzrun disable" to deactivate.`

If you want to skip auto-enable, set `FUZZRUN_SKIP_ENABLE=1` during install.

### Bash/Zsh hook (auto-run on typos)

Add to your shell rc:

```bash
FUZZRUN_BIN="/absolute/path/to/bin/fuzzrun.js"
fuzzrun() { node "$FUZZRUN_BIN" "$@"; }
command_not_found_handle() { fuzzrun "$@"; }
git() { fuzzrun git "$@"; } # optional: wrap git to auto-fix subcommands
```

Notes: `command_not_found_handle` is bash-only; on zsh use `command_not_found_handler`. Keep `FUZZRUN_BIN` absolute.

### PowerShell hook

Append to `Documents\PowerShell\Microsoft.PowerShell_profile.ps1`:

```powershell
$fuzzrun = "C:\Users\HP\fuzzRun\bin\fuzzrun.js" # update path
function global:fuzzrun { node $fuzzrun @args }
$ExecutionContext.InvokeCommand.CommandNotFoundAction = {
    param($commandName, $eventArgs)
    fuzzrun $commandName @($eventArgs.Arguments)
}
function global:git { fuzzrun git @args } # optional git wrapper
```

### Manage hooks
- `fuzzrun enable` (add hooks to your shell profile)
- `fuzzrun disable` (remove hooks)
- `fuzzrun status` (show which profiles are enabled)

### How it works
- Runs the command once; if it fails with "command not found" or "unknown subcommand", tries a one-edit-away fix or the CLI's own suggestion and re-runs automatically.
- Uses Damerau-Levenshtein (handles transposed letters) and refuses ambiguous matches.
- Skips auto-run when risky flags are present (`--force`, `--hard`, `-rf`, etc.) and blocks dangerous bases (`rm`, `mv`, `dd`, etc.).
- Subcommand suggestions are preloaded for popular CLIs (git, npm/yarn/pnpm, pip, docker, kubectl, gh) plus "did you mean" parsing.
- Context-aware fixes for `git checkout/switch <branch>` and `npm/yarn/pnpm run <script>` after a failure.

### Config
- `FUZZRUN_MAX_DISTANCE=1` (set to 2 if you want more aggressive matching)
- `FUZZRUN_ALLOW_ANY_SUBCOMMANDS=1` (allow subcommand fixes for any base that prints suggestions)
- `FUZZRUN_PREFER_BASES=git,npm,docker` (breaks ties in favor of preferred commands)

### Limits
- Only one retry; only unique matches; no prompt.
- For safety, does not auto-correct to dangerous bases (`rm`, `mv`, `dd`, etc.).
