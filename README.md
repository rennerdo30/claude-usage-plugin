# claude-usage-plugin

A Claude Code plugin that lets Claude check how much of your subscription usage is left (the 5-hour session window and the weekly limits) and adjust its work to fit.

It runs Claude Code's own `/usage` command in print mode (`claude -p "/usage"`). It doesn't read your credentials or call any undocumented API.

## Install

```
/plugin marketplace add rennerdo30/claude-usage-plugin
/plugin install usage-check@claude-usage
```

Marketplace URL: `https://github.com/rennerdo30/claude-usage-plugin`

## What it does

**Automatic notices (hook).** On each prompt, a `UserPromptSubmit` hook tells Claude where usage stands, but only when it matters:

- at the start of a session
- when the 5-hour or weekly usage crosses 50%, 75% or 90%
- when a window resets
- above 90%, whenever a new reading comes in

It looks like this in Claude's context:

```
Usage: 5-hour window 94% (resets Sep 25, 9:09pm), weekly (all models) 96% (resets Sep 29, 1:59pm). Do not start new large work; finish the current unit and leave it resumable.
```

**Stop before the limit (hooks, subagents included).** At 99% of the 5-hour or weekly limit, every agent is told to stop and hand off its work:

- **Subagents** get the notice after their next tool call, and new subagents get it as soon as they start. They finish only what's in progress, then end with a handoff: what they did, what's left, which files they touched, and anything half-done.
- **The main agent** is told to start no new work, tell running subagents to stop, save the work state (a commit or a handoff note), and tell you when the limit resets.

Each agent gets the notice once, with a reminder every 2 minutes if it keeps working. To stop at a different percentage, set the environment variable `USAGE_CHECK_STOP_AT`, e.g. `USAGE_CHECK_STOP_AT=97`. Readings are at most 5 minutes old, and at most 1 minute old once usage is above 90%. If your agents burn through quota fast, a slightly lower value gives them room to finish the handoff.

The hooks only read a cache file, so they never make Claude wait. When the reading is older than 5 minutes (1 minute above 90%), it refreshes it in the background by running `claude -p "/usage"`. The cache lives in the plugin's data directory.

**On-demand check (skill).** The `check-usage` skill runs the same command when Claude wants fresh numbers. Claude uses it:

- before large or long-running work, such as big refactors, many subagents or long autonomous loops
- when you ask about usage, limits or reset times

You can also invoke it directly with `/usage-check:check-usage`.

Depending on the numbers, Claude carries on as normal, suggests a smaller scope, or wraps up and leaves the work in a resumable state before the limit hits.

## Requirements

- Claude Code, logged in with a Pro, Max, Team or Enterprise subscription. With an API key there are no plan limits to check.
- The `claude` command on your `PATH`.
- Node.js on your `PATH` for the hook. It has no npm dependencies.

## Windows note

In Git Bash, MSYS rewrites `/usage` into a Windows path. The skill uses `MSYS_NO_PATHCONV=1 claude -p "/usage"` there. From PowerShell, `claude -p "/usage"` works as is.

## License

MIT
