'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = 'state.json';

function defaultState() {
  return { lastPollIso: null, dismissed: [], notifications: [], collapsed: false };
}

/**
 * Load state from <dir>/state.json. Never throws: corrupt or missing file
 * yields the clean default. Extra fields found in the file are preserved.
 */
function loadState(dir) {
  const def = defaultState();
  try {
    const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return def;
    const state = { ...def, ...parsed };
    if (typeof state.lastPollIso !== 'string') state.lastPollIso = null;
    if (!Array.isArray(state.dismissed)) state.dismissed = [];
    if (!Array.isArray(state.notifications)) state.notifications = [];
    return state;
  } catch (_) {
    return def;
  }
}

/**
 * Save state as pretty JSON, atomically (write temp file, then rename).
 * Creates the directory if missing.
 */
function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, STATE_FILE);
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    // On Windows rename can fail if the target is locked; clean up the temp file.
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Dedupe incoming notifications by id against existing + dismissed,
 * prepend the genuinely-new ones, sort by date DESC, cap at 200.
 * Returns { state, freshOnes }.
 */
function mergeNotifications(state, incoming) {
  const existing = Array.isArray(state.notifications) ? state.notifications : [];
  const dismissed = Array.isArray(state.dismissed) ? state.dismissed : [];
  const seen = new Set();
  for (const n of existing) seen.add(n.id);
  for (const id of dismissed) seen.add(id);

  const freshOnes = [];
  for (const n of Array.isArray(incoming) ? incoming : []) {
    if (!n || typeof n.id !== 'string' || seen.has(n.id)) continue;
    seen.add(n.id);
    freshOnes.push(n);
  }

  const merged = freshOnes.concat(existing);
  merged.sort((a, b) => {
    const ta = Date.parse(a.date) || 0;
    const tb = Date.parse(b.date) || 0;
    return tb - ta;
  });

  const newState = { ...state, notifications: merged.slice(0, 200) };
  return { state: newState, freshOnes };
}

module.exports = { loadState, saveState, mergeNotifications };
