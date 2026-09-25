---
name: check-usage
description: Check how much of the user's Claude subscription usage is left (5-hour session window and weekly limits) by running the built-in /usage command non-interactively. Use before starting large or long-running work (big refactors, many subagents, long autonomous loops), when the user asks about usage, limits, quota or when they reset, or when a session has been running for a long time.
allowed-tools: Bash(claude -p "/usage"), Bash(MSYS_NO_PATHCONV=1 claude -p "/usage"), PowerShell(claude -p "/usage")
---

# Check usage

Claude Code's `/usage` command works in print mode. It runs locally, doesn't need a model call, and prints the same numbers as the interactive `/usage` screen.

## Run it

Pick the form that matches the shell:

- **Bash on macOS/Linux:** `claude -p "/usage"`
- **Git Bash on Windows:** `MSYS_NO_PATHCONV=1 claude -p "/usage"`. Without the variable, MSYS rewrites `/usage` into a Windows path like `C:/Program Files/Git/usage`, and the text is sent as a normal prompt instead.
- **PowerShell:** `claude -p "/usage"`

Run exactly one of these commands, with nothing added. They are pre-approved only in this exact form.

## Read the output

The lines that matter look like this:

```
Current session: 94% used · resets Sep 25, 9:09pm (Asia/Tokyo)
Current week (all models): 96% used · resets Sep 29, 1:59pm (Asia/Tokyo)
Current week (Fable): 4% used · resets Sep 29, 1:59pm (Asia/Tokyo)
```

- **Current session** is the rolling 5-hour window.
- **Current week (all models)** is the weekly limit. It's usually the one that really blocks work, because it takes days to reset.
- Per-model weekly lines, such as **Current week (Fable)**, only matter when working on that model.
- The section after that ("What's contributing to your limits usage?") explains what is using up the quota. Mention it only if it's relevant or the user asks.

If the output says the session is using an API key instead of a subscription, there are no plan limits to report. Say so and stop.

## Act on it

Use the highest percentage among the lines that apply:

- **Below 50%:** carry on. Don't mention it unless asked.
- **50–75%:** carry on, but prefer lean approaches. For example, search directly instead of starting subagents.
- **75–90%:** before starting a large task, tell the user the numbers and the reset time, and propose a smaller scope or a checkpoint.
- **Above 90%:** don't start new large work. Finish the current unit, leave the work in a resumable state (commit or write notes on what's done and what's next), and tell the user when the limit resets.

When reporting, keep it to one or two lines. For example: "Usage: 5-hour window 94% (resets 9:09pm), weekly 96% (resets Sep 29)."

Don't check more often than needed. This plugin's hook already adds a "Usage: ..." line to the context when a threshold is crossed or a window resets. If a recent line like that is in the context, trust it. Run the check yourself only when you need fresh numbers, such as right before a big task, or when the user asks.
