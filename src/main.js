'use strict';

const { app, BrowserWindow, ipcMain, shell, screen, Notification, clipboard, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveSetup } = require('./config');
const jira = require('./services/jira');
const bitbucket = require('./services/bitbucket');
const local = require('./services/local');
const { loadState, saveState, mergeNotifications } = require('./services/state');

const EXPANDED_W = 400;
const COLLAPSED_W = 36;

let win = null;
let tray = null;
let quitting = false;
let cfg = null;
let state = null;
let pollTimer = null;
let polling = false;
let collapsed = false;
let snapshotCache = { tickets: [], prs: [], notifications: [], unread: 0, lastSync: null, polling: false, errors: [] };

function userDataDir() {
  return app.getPath('userData');
}

// One-time migration from the old app identity ("workdock" → "ulysesdock").
function migrateLegacyUserData() {
  try {
    const dir = userDataDir();
    const legacy = path.join(path.dirname(dir), 'workdock');
    if (dir === legacy || !fs.existsSync(legacy)) return;
    for (const f of ['state.json', 'config.json']) {
      const src = path.join(legacy, f);
      const dst = path.join(dir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  } catch (_) { /* best effort */ }
}

function buildSnapshot(extra) {
  const notifications = (state && state.notifications) || [];
  snapshotCache = {
    tickets: snapshotCache.tickets,
    prs: snapshotCache.prs,
    notifications,
    unread: notifications.length,
    lastSync: state && state.lastPollIso,
    polling,
    errors: snapshotCache.errors,
    needsSetup: !!(cfg && cfg.needsSetup),
    setupError: (cfg && cfg.setupError) || null,
    ...(extra || {}),
  };
  return snapshotCache;
}

function pushSnapshot() {
  if (win && !win.isDestroyed()) win.webContents.send('snapshot:update', buildSnapshot());
}

async function poll() {
  if (polling || !cfg || cfg.needsSetup) return;
  polling = true;
  pushSnapshot();
  const errors = [];
  const sinceIso = state.lastPollIso || new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  let tickets = snapshotCache.tickets;
  let prs = snapshotCache.prs;
  let incoming = [];

  try {
    tickets = await jira.fetchMyTickets(cfg);
  } catch (e) {
    errors.push('Jira tickets: ' + e.message);
  }
  try {
    prs = await bitbucket.fetchMyPRs(cfg);
  } catch (e) {
    errors.push('Bitbucket PRs: ' + e.message);
  }
  let activityOk = true;
  try {
    const watchlist = await jira.buildWatchlist(cfg);
    incoming = incoming.concat(await jira.fetchActivity(cfg, watchlist, sinceIso));
  } catch (e) {
    activityOk = false;
    errors.push('Jira activity: ' + e.message);
  }
  try {
    const openPrs = prs.filter((p) => p.state === 'OPEN');
    incoming = incoming.concat(await bitbucket.fetchPRActivity(cfg, openPrs, sinceIso));
  } catch (e) {
    activityOk = false;
    errors.push('PR activity: ' + e.message);
  }

  try {
    const ignored = (cfg.ignoreAuthors || []).map((a) => a.toLowerCase());
    incoming = incoming.filter((n) => !ignored.includes(String(n.author || '').toLowerCase()));

    const { state: newState, freshOnes } = mergeNotifications(state, incoming);
    state = newState;
    // Only advance the watermark when both activity fetches succeeded, so an
    // outage window is re-scanned on recovery instead of silently skipped.
    if (activityOk) state.lastPollIso = new Date().toISOString();
    saveState(userDataDir(), state);

    for (const n of freshOnes.slice(0, 5)) {
      try {
        const toast = new Notification({ title: n.title, body: (n.text || n.kind).slice(0, 120), silent: false });
        toast.on('click', () => {
          if (typeof n.url === 'string' && /^https:\/\//.test(n.url)) shell.openExternal(n.url);
        });
        toast.show();
      } catch (_) { /* toasts are best-effort */ }
    }
  } catch (e) {
    errors.push('State: ' + e.message);
  } finally {
    polling = false;
    buildSnapshot({ tickets, prs, errors });
    pushSnapshot();
  }
}

function applyBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const w = collapsed ? COLLAPSED_W : EXPANDED_W;
  win.setBounds({ x: area.x + area.width - w, y: area.y, width: w, height: area.height });
}

function createWindow() {
  win = new BrowserWindow({
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    title: 'UlysesDock',
    backgroundColor: '#1b1e24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyBounds();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    if (!state.hidden || (cfg && cfg.needsSetup)) win.show();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      setHidden(true);
    }
  });
}

function setHidden(hidden) {
  if (!win || win.isDestroyed()) return;
  if (hidden) {
    win.hide();
  } else {
    applyBounds();
    win.show();
    win.focus();
  }
  state.hidden = hidden;
  saveState(userDataDir(), state);
  updateTrayMenu();
}

function toggleVisible() {
  setHidden(win && win.isVisible());
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = win && !win.isDestroyed() && win.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Masquer (Alt+K)' : 'Afficher (Alt+K)', click: () => toggleVisible() },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('UlysesDock — Alt+K');
  tray.on('click', () => toggleVisible());
  updateTrayMenu();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, cfg.pollIntervalMs);
}

// Single instance: a second launch just reveals the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) setHidden(false);
});

app.whenReady().then(async () => {
  migrateLegacyUserData();
  state = loadState(userDataDir());
  collapsed = !!state.collapsed;
  cfg = await loadConfig(userDataDir()).catch((e) => ({ needsSetup: true, setupError: e.message }));
  const ignoredAtBoot = ((cfg && cfg.ignoreAuthors) || []).map((a) => a.toLowerCase());
  state.notifications = state.notifications.filter(
    (n) => !ignoredAtBoot.includes(String(n.author || '').toLowerCase())
  );

  ipcMain.handle('snapshot:get', () => buildSnapshot());
  ipcMain.handle('notif:dismiss', (_e, id) => {
    state.dismissed.push(id);
    if (state.dismissed.length > 2000) state.dismissed = state.dismissed.slice(-2000);
    state.notifications = state.notifications.filter((n) => n.id !== id);
    saveState(userDataDir(), state);
    pushSnapshot();
  });
  ipcMain.handle('notif:dismissAll', () => {
    state.dismissed = state.dismissed.concat(state.notifications.map((n) => n.id)).slice(-2000);
    state.notifications = [];
    saveState(userDataDir(), state);
    pushSnapshot();
  });
  ipcMain.handle('poll:refresh', () => poll());
  ipcMain.handle('open:external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('window:setCollapsed', (_e, v) => {
    collapsed = !!v;
    state.collapsed = collapsed;
    saveState(userDataDir(), state);
    applyBounds();
  });
  ipcMain.handle('app:quit', () => setHidden(true));
  ipcMain.handle('ticket:detail', (_e, key) => {
    if (!cfg || cfg.needsSetup) throw new Error('Configuration incomplète');
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(String(key))) throw new Error('Invalid ticket key');
    return jira.fetchTicketDetail(cfg, String(key));
  });
  ipcMain.handle('ticket:comment', async (_e, key, text) => {
    if (!cfg || cfg.needsSetup) throw new Error('Configuration incomplète');
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(String(key))) throw new Error('Invalid ticket key');
    const body = String(text || '').trim();
    if (!body) throw new Error('Empty comment');
    await jira.postComment(cfg, String(key), body);
    return true;
  });
  ipcMain.handle('standup:get', () =>
    cfg && !cfg.needsSetup ? local.getStandup(cfg) : { sinceIso: null, sinceLabel: 'hier', commits: [] }
  );
  ipcMain.handle('clipboard:copy', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('setup:save', async (_e, payload) => {
    const result = await saveSetup(userDataDir(), payload || {});
    if (result.ok) {
      cfg = await loadConfig(userDataDir());
      if (!cfg.needsSetup) startPolling();
      pushSnapshot();
    }
    return result;
  });

  createWindow();
  createTray();
  if (!globalShortcut.register('Alt+K', toggleVisible)) {
    console.error('Alt+K global shortcut could not be registered (already in use?)');
  }
  if (!cfg.needsSetup) startPolling();
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
});
