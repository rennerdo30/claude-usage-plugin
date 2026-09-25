#!/usr/bin/env node
// UserPromptSubmit hook: tells Claude where usage stands when it matters.
//
// The hook itself only reads a cache file, so prompts never wait on it.
// When the cache is stale it starts a detached copy of this script with
// --refresh, which runs `claude -p "/usage"` and rewrites the cache.

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
const LOCK_FILE = path.join(DATA_DIR, 'refresh.lock');

const CACHE_TTL_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const STALE_NOTE_MS = 15 * 60 * 1000;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const THRESHOLDS = [50, 75, 90];

// Set on the nested `claude -p "/usage"` so it never re-enters this hook.
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

function startRefreshIfStale(cache) {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return;
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

function levelOf(pct) {
  return THRESHOLDS.filter((t) => pct >= t).length;
}

function describe(w) {
  const name = w.kind === 'session' ? '5-hour window' : `weekly (${w.scope})`;
  return `${name} ${w.pct}%${w.resets ? ` (resets ${w.resets})` : ''}`;
}

function advice(level) {
  switch (level) {
    case 0:
      return '';
    case 1:
      return ' Prefer lean approaches.';
    case 2:
      return ' Check with the user before starting large tasks.';
    default:
      return ' Do not start new large work; finish the current unit and leave it resumable.';
  }
}

function buildNotice(cache, sessionId) {
  if (!cache || !cache.available) return null;

  // Per-model weekly lines only matter for that model, so they don't set the level.
  const main = cache.windows.filter((w) => w.kind === 'session' || w.scope === 'all models');
  if (main.length === 0) return null;
  const top = Math.max(...main.map((w) => w.pct));
  const level = levelOf(top);

  const sessions = readJson(SESSIONS_FILE, {});
  const prev = sessions[sessionId];
  const changed =
    !prev ||
    prev.level !== level ||
    // Near the limit, every new reading is worth passing on.
    (level >= THRESHOLDS.length && prev.top !== top);

  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (now - s.at > SESSION_MAX_AGE_MS) delete sessions[id];
  }
  sessions[sessionId] = { level, top, at: now };
  writeJson(SESSIONS_FILE, sessions);

  if (!changed) return null;

  const age = now - cache.fetchedAt;
  const ageNote = age > STALE_NOTE_MS ? ` [reading is ${Math.round(age / 60000)} min old]` : '';
  const others = cache.windows.filter((w) => !main.includes(w) && w.pct >= THRESHOLDS[0]);
  return (
    `Usage: ${[...main, ...others].map(describe).join(', ')}.${advice(level)}${ageNote}` +
    ' (from the usage-check plugin; run the check-usage skill for details)'
  );
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

  const cache = readJson(CACHE_FILE, null);
  startRefreshIfStale(cache);

  const notice = buildNotice(cache, input.session_id || 'unknown');
  if (notice) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: notice,
        },
      })
    );
  }
}

try {
  main();
} catch {
  // A usage notice is never worth breaking the user's prompt over.
}
process.exitCode = 0;
