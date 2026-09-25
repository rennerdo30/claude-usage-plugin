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

const THRESHOLDS = [90, 95];
// At or above this, every agent is told to stop and document its work.
const STOP_AT = Number(process.env.USAGE_CHECK_STOP_AT) || 99;

const CACHE_TTL_MS = 5 * 60 * 1000;
// Near the limit, usage moves fast, so readings are refreshed more often.
const CACHE_TTL_HIGH_MS = 60 * 1000;
const HIGH_REFRESH_AT = 90;
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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60 * 1000;
// A dated reset further than this before the reading belongs to the next year.
const YEAR_ROLLOVER_MS = 180 * DAY_MS;

// Wall-clock parts of utcMs in the given IANA zone (or local time without one).
function wallClock(utcMs, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone || undefined,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// Converts a wall-clock time in a zone to a UTC timestamp.
function zonedToUtc(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (utcMs) => {
    const w = wallClock(utcMs, zone);
    return Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second) - utcMs;
  };
  const guess = wall - offsetAt(wall);
  return wall - offsetAt(guess);
}

// "Sep 26, 2:20am (Asia/Tokyo)", "Sep 27, 4pm (Asia/Tokyo)" or "2:19pm (Asia/Tokyo)".
// Returns the reset as a timestamp, taking the first match after the reading, or null.
function resetTime(text, readingMs) {
  const m = /^(?:([a-z]{3})[a-z]* (\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?$/i.exec(
    (text || '').trim()
  );
  if (!m) return null;
  try {
    const zone = m[6] || null;
    let hour = Number(m[3]);
    const minute = Number(m[4] || 0);
    if (m[5]) hour = (hour % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
    const ref = wallClock(readingMs, zone);
    if (m[1]) {
      const month = MONTHS.indexOf(m[1].toLowerCase());
      if (month < 0) return null;
      let at = zonedToUtc(ref.year, month, Number(m[2]), hour, minute, zone);
      if (at < readingMs - YEAR_ROLLOVER_MS) at = zonedToUtc(ref.year + 1, month, Number(m[2]), hour, minute, zone);
      return at;
    }
    let at = zonedToUtc(ref.year, ref.month, ref.day, hour, minute, zone);
    if (at < readingMs) at += DAY_MS;
    return at;
  } catch {
    // Unknown time zone or similar: treat the reset time as unknown.
    return null;
  }
}

// True once the window's reset time has passed, so its percentage is out of date.
function hasReset(w, cache) {
  const at = resetTime(w.resets, cache.fetchedAt);
  return at !== null && Date.now() >= at;
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
  const ttl = top >= HIGH_REFRESH_AT ? CACHE_TTL_HIGH_MS : CACHE_TTL_MS;
  const anyReset = cache && cache.available && cache.windows.some((w) => hasReset(w, cache));
  if (cache && !anyReset && Date.now() - cache.fetchedAt < ttl) return;
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
  // A window whose reset time has passed starts again from zero.
  return main.length ? Math.max(...main.map((w) => (hasReset(w, cache) ? 0 : w.pct))) : -1;
}

function levelOf(pct) {
  if (pct >= STOP_AT) return THRESHOLDS.length + 1;
  return THRESHOLDS.filter((t) => pct >= t).length;
}

function describe(w, cache) {
  const name = w.kind === 'session' ? '5-hour window' : `weekly (${w.scope})`;
  if (hasReset(w, cache)) {
    return `${name} has reset (was ${w.pct}%, reset time ${w.resets} has passed; a fresh reading is on its way)`;
  }
  return `${name} ${w.pct}%${w.resets ? ` (resets ${w.resets})` : ''}`;
}

function summary(cache) {
  const main = mainWindows(cache);
  const others = cache.windows.filter((w) => !main.includes(w) && w.pct >= THRESHOLDS[0] && !hasReset(w, cache));
  const age = Date.now() - cache.fetchedAt;
  const ageNote = age > STALE_NOTE_MS ? ` [reading is ${Math.round(age / 60000)} min old]` : '';
  return `Usage: ${[...main, ...others].map((w) => describe(w, cache)).join(', ')}.${ageNote}`;
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
      return ' No need to change plans.';
    case 1:
      return ' Prefer lean approaches, and check with the user before starting large tasks.';
    case 2:
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
