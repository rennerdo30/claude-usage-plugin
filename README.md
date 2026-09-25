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

The plugin adds a `check-usage` skill. Claude uses it:

- before large or long-running work, such as big refactors, many subagents or long autonomous loops
- when you ask about usage, limits or reset times

You can also invoke it directly with `/usage-check:check-usage`.

Depending on the numbers, Claude carries on as normal, suggests a smaller scope, or wraps up and leaves the work in a resumable state before the limit hits.

## Requirements

- Claude Code, logged in with a Pro, Max, Team or Enterprise subscription. With an API key there are no plan limits to check.
- The `claude` command on your `PATH`.

## Windows note

In Git Bash, MSYS rewrites `/usage` into a Windows path. The skill uses `MSYS_NO_PATHCONV=1 claude -p "/usage"` there. From PowerShell, `claude -p "/usage"` works as is.

## License

MIT
