## FuzzRun (prototype)

Auto-correct mistyped commands/subcommands and re-run them automatically (no prompt) when the fix is high-confidence (edit distance 1 or the CLI provides a single suggestion). Base command corrections skip dangerous commands like `rm` or `mv`.

### Quick run

```
node tools/fuzzrun/cli.js git commmmit -m "msg"
```

### Bash/Zsh hook (auto-run on typos)

Add to your shell rc:

```bash
FUZZRUN_BIN="/absolute/path/to/tools/fuzzrun/cli.js"
fuzzrun() { node "$FUZZRUN_BIN" "$@"; }
command_not_found_handle() { fuzzrun "$@"; }
git() { fuzzrun git "$@"; } # optional: wrap git to auto-fix subcommands
```

Notes: `command_not_found_handle` is bash-only; on zsh use `command_not_found_handler`. Keep `FUZZRUN_BIN` absolute.

### PowerShell hook

Append to `Documents\PowerShell\Microsoft.PowerShell_profile.ps1`:

```powershell
$fuzzrun = "C:\Users\HP\Downloads\Nexios\tools\fuzzrun\cli.js" # update path
function global:fuzzrun { node $fuzzrun @args }
$ExecutionContext.InvokeCommand.CommandNotFoundAction = {
    param($commandName, $eventArgs)
    fuzzrun $commandName @($eventArgs.Arguments)
}
function global:git { fuzzrun git @args } # optional git wrapper
```

### How it works
- Runs the command once; if it fails with “command not found” or “unknown subcommand,” tries a one-edit-away fix or the CLI’s own suggestion and re-runs automatically.
- Base command suggestions come from executables on your `PATH` (safe-listed to avoid destructive commands).
- Subcommand suggestions are preloaded for popular CLIs (git, npm/yarn/pnpm, pip, docker, kubectl, gh) plus “did you mean” parsing.

### Limits
- Only one retry; only edit-distance 1; no prompt.
- For safety, does not auto-correct to dangerous bases (`rm`, `mv`, `dd`, etc.).
