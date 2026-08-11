'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULTS = {
  jiraBaseUrl: 'https://tesipro.atlassian.net',
  workspace: 'pmsweb',
  repos: ['backend', 'frontend'],
  pollIntervalMs: 30000,
  ignoreAuthors: ['UlysesSuite', 'CloudPMS'],
};

// Legacy bootstrap (first machine only): Yacine's jira_grabber script.
const LEGACY_JIRA_SCRIPT = path.join(
  process.env.USERPROFILE || '',
  'IdeaProjects', 'tickets', '_scripts', 'jira_grabber.py'
);

function configPath(userDataDir) {
  return path.join(userDataDir, 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function gitCredentialFill(host) {
  const res = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) return null;
  const out = {};
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out.password ? out : null;
}

function gitConfigValue(key) {
  const res = spawnSync('git', ['config', '--global', key], { encoding: 'utf8', windowsHide: true });
  return res.status === 0 ? (res.stdout || '').trim() : '';
}

function guessLocalRepos() {
  const base = path.join(process.env.USERPROFILE || '', 'IdeaProjects');
  return ['backend', 'frontend']
    .map((n) => path.join(base, n))
    .filter((p) => fs.existsSync(path.join(p, '.git')));
}

function guessTicketsDir() {
  const p = path.join(process.env.USERPROFILE || '', 'IdeaProjects', 'tickets');
  return fs.existsSync(p) ? p : null;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`GET ${new URL(url).pathname} failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function jiraAuthHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function testJira(baseUrl, email, token) {
  try {
    const me = await fetchJson(`${baseUrl}/rest/api/3/myself`, {
      Authorization: jiraAuthHeader(email, token),
      Accept: 'application/json',
    });
    return { ok: true, accountId: me.accountId, displayName: me.displayName };
  } catch (e) {
    return { ok: false, error: e.status === 401 ? 'Email ou token Jira invalide' : e.message };
  }
}

async function testBitbucket(token, workspace, repo) {
  try {
    const me = await fetchJson('https://api.bitbucket.org/2.0/user', {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    });
    await fetchJson(`https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}?fields=name`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    });
    return { ok: true, uuid: me.uuid, displayName: me.display_name };
  } catch (e) {
    return {
      ok: false,
      error: e.status === 401 ? 'Token Bitbucket invalide' :
        e.status === 403 || e.status === 404 ? `Pas d'accès au repo ${workspace}/${repo}` : e.message,
    };
  }
}

function resolveBitbucketToken(stored) {
  if (stored.bitbucket && stored.bitbucket.authMode === 'token' && stored.bitbucket.token) {
    return stored.bitbucket.token;
  }
  const cred = gitCredentialFill('bitbucket.org');
  return cred ? cred.password : null;
}

function legacyBootstrap() {
  if (!fs.existsSync(LEGACY_JIRA_SCRIPT)) return null;
  let src;
  try {
    src = fs.readFileSync(LEGACY_JIRA_SCRIPT, 'utf8');
  } catch (_) {
    return null;
  }
  const token = /API_TOKEN\s*=\s*"([^"]+)"/.exec(src);
  const email = /JIRA_EMAIL\s*=\s*"([^"]+)"/.exec(src);
  const base = /JIRA_BASE_URL\s*=\s*"([^"]+)"/.exec(src);
  if (!token || !email || !base) return null;
  return {
    jira: { baseUrl: base[1], email: email[1], token: token[1] },
    bitbucket: { workspace: DEFAULTS.workspace, repos: DEFAULTS.repos.slice(), authMode: 'git-credential' },
    gitAuthor: gitConfigValue('user.name'),
    localRepos: guessLocalRepos(),
    ticketsDir: guessTicketsDir(),
    pollIntervalMs: DEFAULTS.pollIntervalMs,
    ignoreAuthors: DEFAULTS.ignoreAuthors.slice(),
  };
}

/**
 * Validates a setup payload against both APIs; on success writes config.json
 * (identity included) and returns { ok: true }. On failure returns per-service results.
 */
async function saveSetup(userDataDir, payload) {
  const jiraBaseUrl = String(payload.jiraBaseUrl || DEFAULTS.jiraBaseUrl).replace(/\/+$/, '');
  const jiraEmail = String(payload.jiraEmail || '').trim();
  const jiraToken = String(payload.jiraToken || '').trim();
  const workspace = String(payload.workspace || DEFAULTS.workspace).trim();
  const repos = Array.isArray(payload.repos) && payload.repos.length
    ? payload.repos.map(String) : DEFAULTS.repos.slice();
  const manualBbToken = String(payload.bbToken || '').trim();

  const jira = jiraEmail && jiraToken
    ? await testJira(jiraBaseUrl, jiraEmail, jiraToken)
    : { ok: false, error: 'Email et token Jira requis' };

  let bbToken = manualBbToken;
  let bbAuthMode = 'token';
  if (!bbToken) {
    const cred = gitCredentialFill('bitbucket.org');
    bbToken = cred ? cred.password : null;
    bbAuthMode = 'git-credential';
  }
  const bitbucket = bbToken
    ? await testBitbucket(bbToken, workspace, repos[0])
    : { ok: false, error: 'Aucun token Bitbucket (ni Git credential manager, ni manuel)' };

  if (!jira.ok || !bitbucket.ok) {
    return { ok: false, jira, bitbucket };
  }

  const stored = {
    jira: { baseUrl: jiraBaseUrl, email: jiraEmail, token: jiraToken },
    bitbucket: {
      workspace,
      repos,
      authMode: bbAuthMode,
      ...(bbAuthMode === 'token' ? { token: manualBbToken } : {}),
    },
    identity: {
      jiraAccountId: jira.accountId,
      bbUuid: bitbucket.uuid,
      displayName: bitbucket.displayName || jira.displayName,
    },
    gitAuthor: gitConfigValue('user.name'),
    localRepos: guessLocalRepos(),
    ticketsDir: guessTicketsDir(),
    pollIntervalMs: DEFAULTS.pollIntervalMs,
    ignoreAuthors: DEFAULTS.ignoreAuthors.slice(),
  };
  writeJson(configPath(userDataDir), stored);
  return { ok: true, jira, bitbucket };
}

/**
 * Loads runtime config. Returns { needsSetup: true } when no usable config exists.
 * Runtime shape consumed by services:
 * { jira: {baseUrl, email, token, myAccountId}, bitbucket: {workspace, repos, token, myUuid},
 *   ticketsDir, pollIntervalMs, ignoreAuthors, localRepos, gitAuthor }
 */
async function loadConfig(userDataDir) {
  let stored = readJson(configPath(userDataDir));

  if (!stored) {
    stored = legacyBootstrap();
    if (stored) writeJson(configPath(userDataDir), stored);
  }
  if (!stored || !stored.jira || !stored.jira.email || !stored.jira.token) {
    return { needsSetup: true };
  }

  const bbToken = resolveBitbucketToken(stored);
  if (!bbToken) return { needsSetup: true, setupError: 'Token Bitbucket introuvable' };

  let identity = stored.identity || {};
  if (!identity.jiraAccountId || !identity.bbUuid) {
    const [jira, bb] = await Promise.all([
      testJira(stored.jira.baseUrl, stored.jira.email, stored.jira.token),
      testBitbucket(bbToken, stored.bitbucket.workspace, stored.bitbucket.repos[0]),
    ]);
    if (!jira.ok || !bb.ok) {
      return {
        needsSetup: true,
        setupError: [jira.ok ? null : `Jira: ${jira.error}`, bb.ok ? null : `Bitbucket: ${bb.error}`]
          .filter(Boolean).join(' — '),
      };
    }
    identity = { jiraAccountId: jira.accountId, bbUuid: bb.uuid, displayName: bb.displayName };
    stored.identity = identity;
    writeJson(configPath(userDataDir), stored);
  }

  return {
    jira: {
      baseUrl: stored.jira.baseUrl,
      email: stored.jira.email,
      token: stored.jira.token,
      myAccountId: identity.jiraAccountId,
    },
    bitbucket: {
      workspace: stored.bitbucket.workspace,
      repos: stored.bitbucket.repos.slice(),
      token: bbToken,
      myUuid: identity.bbUuid,
    },
    ticketsDir: stored.ticketsDir || null,
    pollIntervalMs: Number(stored.pollIntervalMs) || DEFAULTS.pollIntervalMs,
    ignoreAuthors: Array.isArray(stored.ignoreAuthors) ? stored.ignoreAuthors : DEFAULTS.ignoreAuthors.slice(),
    localRepos: Array.isArray(stored.localRepos) ? stored.localRepos : [],
    gitAuthor: stored.gitAuthor || gitConfigValue('user.name'),
  };
}

module.exports = { loadConfig, saveSetup, DEFAULTS };
