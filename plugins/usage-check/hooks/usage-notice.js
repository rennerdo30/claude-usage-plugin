#!/usr/bin/env node
// Usage hooks for the usage-check plugin.
//
//   UserPromptSubmit  tells the main agent where usage stands when it matters.
//   SubagentStart     tells a new subagent to stop early when usage is critical.
//   PostToolUse       tells any agent, subagents included, to stop when critical.
//
// The hooks only read a cache file, so they never make Claude wait. When the
// cache is stale, a detached copy of this script runs with --refresh, which
// calls `claude -p "/usage"` and rewrites the cache.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA ||
  path.join(os.homedir(), '.claude', 'plugins', 'data', 'usage-check');
const CACHE_FILE = path.join(DATA_DIR, 'usage.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const STOPS_FILE = path.join(DATA_DIR, 'stops.json');
const LOCK_FILE = path.join(DATA_DIR, 'refresh.lock');

const THRESHOLDS = [50, 75, 90];
// At or above this, every agent is told to stop and document its work.
const STOP_AT = Number(process.env.USAGE_CHECK_STOP_AT) || 99;

const CACHE_TTL_MS = 5 * 60 * 1000;
// Near the limit, usage moves fast, so readings are refreshed more often.
const CACHE_TTL_HIGH_MS = 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const STALE_NOTE_MS = 15 * 60 * 1000;
// An agent that keeps working past the stop notice is reminded this often.
const STOP_REPEAT_MS = 2 * 60 * 1000;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Set on the nested `claude -p "/usage"` so it never re-enters these hooks.
const GUARD_ENV = 'USAGE_CHECK_REFRESHING';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function pruneOld(map, now) {
  for (const [id, s] of Object.entries(map)) {
    if (now - s.at > SESSION_MAX_AGE_MS) delete map[id];
  }
}

// "Current session: 94% used · resets Sep 25, 9:09pm (Asia/Tokyo)"
function parseUsage(text) {
  const windows = [];
  const re = /^\s*Current (session|week(?: \(([^)]+)\))?):\s*(\d+)% used(?:\s*·\s*resets (.+?))?\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    const isSession = m[1] === 'session';
    windows.push({
      kind: isSession ? 'session' : 'week',
      scope: isSession ? null : m[2] || 'all models',
      pct: Number(m[3]),
      resets: m[4] || null,
    });
  }
  return windows;
}

function refresh() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let output = '';
  let error = null;
  try {
    // Through a shell so it works whether `claude` is an .exe or an npm .cmd
    // shim. cmd.exe and sh both pass "/usage" through untouched.
    output = execSync('claude -p "/usage"', {
      encoding: 'utf8',
      timeout: 60 * 1000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [GUARD_ENV]: '1', MSYS_NO_PATHCONV: '1' },
    });
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 500);
  }
  const windows = parseUsage(output);
  writeJson(CACHE_FILE, {
    fetchedAt: Date.now(),
    windows,
    // No usage lines usually means API-key auth, where plan limits don't apply.
    available: windows.length > 0,
    error,
  });
}

function startRefreshIfStale(cache, top) {
  const ttl = top >= THRESHOLDS[THRESHOLDS.length - 1] ? CACHE_TTL_HIGH_MS : CACHE_TTL_MS;
  if (cache && Date.now() - cache.fetchedAt < ttl) return;
  try {
    const lock = fs.statSync(LOCK_FILE);
    if (Date.now() - lock.mtimeMs < LOCK_STALE_MS) return;
  } catch {
    // No lock, go ahead.
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const child = spawn(process.execPath, [__filename, '--refresh'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, [GUARD_ENV]: '1' },
  });
  child.unref();
}

// Per-model weekly lines only matter for that model, so they don't set the level.
function mainWindows(cache) {
  if (!cache || !cache.available) return [];
  return cache.windows.filter((w) => w.kind === 'session' || w.scope === 'all models');
}

function topPct(cache) {
  const main = mainWindows(cache);
  return main.length ? Math.max(...main.map((w) => w.pct)) : -1;
}

function levelOf(pct) {
  if (pct >= STOP_AT) return THRESHOLDS.length + 1;
  return THRESHOLDS.filter((t) => pct >= t).length;
}

function describe(w) {
  const name = w.kind === 'session' ? '5-hour window' : `weekly (${w.scope})`;
  return `${name} ${w.pct}%${w.resets ? ` (resets ${w.resets})` : ''}`;
}

function summary(cache) {
  const main = mainWindows(cache);
  const others = cache.windows.filter((w) => !main.includes(w) && w.pct >= THRESHOLDS[0]);
  const age = Date.now() - cache.fetchedAt;
  const ageNote = age > STALE_NOTE_MS ? ` [reading is ${Math.round(age / 60000)} min old]` : '';
  return `Usage: ${[...main, ...others].map(describe).join(', ')}.${ageNote}`;
}

const STOP_SUBAGENT =
  'The usage limit is about to be reached. Stop now: do not start any new step. ' +
  'Finish only what you are in the middle of if it takes one or two more tool calls, ' +
  'then end your turn with a handoff: what you did, what is left, the files you ' +
  'touched, and anything half-done. Your final message is all that survives, so put ' +
  'the handoff there.';

const STOP_MAIN =
  'The usage limit is about to be reached. Stop now: do not start new work or new ' +
  'subagents. Tell any running subagents to stop and report their progress (use ' +
  'SendMessage for background agents). Then save the state of the work so it can be ' +
  'resumed after the reset: commit or write a short handoff note covering what is ' +
  'done, what is left, and where. Finally, tell the user when the limit resets.';

function advice(level) {
  switch (level) {
    case 0:
      return '';
    case 1:
      return ' Prefer lean approaches.';
    case 2:
      return ' Check with the user before starting large tasks.';
    case 3:
      return ' Do not start new large work; finish the current unit and leave it resumable.';
    default:
      return ` ${STOP_MAIN}`;
  }
}

function withSource(text) {
  return `${text} (from the usage-check plugin)`;
}

// UserPromptSubmit: only when the level changed for this session, or near the limit.
function promptNotice(cache, input) {
  const top = topPct(cache);
  if (top < 0) return null;
  const level = levelOf(top);
  const sessionId = input.session_id || 'unknown';

  const now = Date.now();
  const sessions = readJson(SESSIONS_FILE, {});
  const prev = sessions[sessionId];
  const changed =
    !prev || prev.level !== level || (level >= THRESHOLDS.length && prev.top !== top);
  pruneOld(sessions, now);
  sessions[sessionId] = { level, top, at: now };
  writeJson(SESSIONS_FILE, sessions);

  if (!changed) return null;
  return withSource(`${summary(cache)}${advice(level)}`);
}

// SubagentStart / PostToolUse: only at the stop level, once per agent, with reminders.
function stopNotice(cache, input) {
  const top = topPct(cache);
  const stopping = top >= STOP_AT;
  const now = Date.now();
  const stops = readJson(STOPS_FILE, {});

  if (!stopping) {
    // Below the stop level (e.g. after a reset): forget old notices so the
    // next episode starts fresh. Skip the write when there's nothing to clear.
    if (Object.keys(stops).length) writeJson(STOPS_FILE, {});
    return null;
  }

  const isSubagent = Boolean(input.agent_id) || input.hook_event_name === 'SubagentStart';
  const key = `${input.session_id || 'unknown'}:${input.agent_id || 'main'}`;
  const prev = stops[key];
  if (prev && now - prev.at < STOP_REPEAT_MS) return null;
  pruneOld(stops, now);
  stops[key] = { at: now };
  writeJson(STOPS_FILE, stops);

  return withSource(`${summary(cache)} ${isSubagent ? STOP_SUBAGENT : STOP_MAIN}`);
}

function main() {
  if (process.argv.includes('--refresh')) {
    try {
      refresh();
    } finally {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {}
    }
    return;
  }

  if (process.env[GUARD_ENV]) return;

  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {}
  const event = input.hook_event_name || 'UserPromptSubmit';

  const cache = readJson(CACHE_FILE, null);
  startRefreshIfStale(cache, topPct(cache));

  const notice = event === 'UserPromptSubmit' ? promptNotice(cache, input) : stopNotice(cache, input);
  if (notice) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: notice,
        },
      })
    );
  }
}

try {
  main();
} catch {
  // A usage notice is never worth breaking the user's work over.
}
process.exitCode = 0;
