'use strict';

const fs = require('fs');

const TIMEOUT_MS = 20000;
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** Tiny concurrency pool: run fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

function authHeader(cfg) {
  return 'Basic ' + Buffer.from(cfg.jira.email + ':' + cfg.jira.token).toString('base64');
}

/**
 * fetch against Jira. Returns the Response (res.ok already handled unless
 * its status is listed in okStatuses, which the caller then inspects).
 */
async function jiraFetch(cfg, method, urlPath, body, okStatuses) {
  const url = cfg.jira.baseUrl + urlPath;
  const headers = { Authorization: authHeader(cfg), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && !(okStatuses && okStatuses.includes(res.status))) {
    const shortPath = urlPath.split('?')[0];
    throw new Error('Jira ' + method + ' ' + shortPath + ' failed: HTTP ' + res.status);
  }
  return res;
}

/**
 * Run a JQL search, handling both the new (POST /search/jql + nextPageToken)
 * and old (POST /search + startAt) endpoints. Returns raw issue objects.
 */
async function searchJql(cfg, jql, fields, maxTotal) {
  // Try the new endpoint first.
  let issues = [];
  let res = await jiraFetch(cfg, 'POST', '/rest/api/3/search/jql', {
    jql,
    maxResults: Math.min(maxTotal, 100),
    fields,
  }, [404]);

  if (res.status !== 404) {
    let data = await res.json();
    issues = issues.concat(data.issues || []);
    while (data.nextPageToken && issues.length < maxTotal) {
      res = await jiraFetch(cfg, 'POST', '/rest/api/3/search/jql', {
        jql,
        maxResults: Math.min(maxTotal - issues.length, 100),
        fields,
        nextPageToken: data.nextPageToken,
      });
      data = await res.json();
      issues = issues.concat(data.issues || []);
    }
    return issues.slice(0, maxTotal);
  }

  // Fallback: older API with startAt pagination.
  let startAt = 0;
  for (;;) {
    const r = await jiraFetch(cfg, 'POST', '/rest/api/3/search', {
      jql,
      startAt,
      maxResults: Math.min(maxTotal - issues.length, 100),
      fields,
    });
    const data = await r.json();
    const page = data.issues || [];
    issues = issues.concat(page);
    startAt += page.length;
    if (issues.length >= maxTotal || page.length === 0 || startAt >= (data.total || 0)) break;
  }
  return issues.slice(0, maxTotal);
}

/** Recursively collect `text` properties from an ADF node tree → plain text. */
function adfToText(node) {
  const parts = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  })(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * ADF → plain text preserving paragraph breaks: 'paragraph', 'heading' and
 * 'listItem' boundaries become '\n'. Whitespace is collapsed within lines.
 */
function adfToMultilineText(node) {
  const BLOCKS = new Set(['paragraph', 'heading', 'listItem']);
  const lines = [];
  let cur = [];
  function flush() {
    const line = cur.join(' ').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    cur = [];
  }
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n.text === 'string') cur.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (BLOCKS.has(n.type)) flush();
  })(node);
  flush();
  return lines.join('\n');
}

function adfBodyToText(body, maxLen) {
  try {
    if (typeof body === 'string') {
      return body.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, maxLen);
    }
    return adfToMultilineText(body).slice(0, maxLen);
  } catch (_) {
    return '';
  }
}

function commentText(body) {
  try {
    if (typeof body === 'string') return body.replace(/\s+/g, ' ').trim().slice(0, 200) || '[comment]';
    const text = adfToText(body);
    return text || '[comment]';
  } catch (_) {
    return '[comment]';
  }
}

/**
 * Build an ADF document from plain text: one paragraph node per non-empty
 * line (blank lines — including consecutive ones — are collapsed away).
 */
function textToAdf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('Empty comment text');
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  };
}

// Backwards status transition (e.g. QA → back to in-progress) detection.
const REGRESSION_TO_RE = /en cours|to do|à faire|open|reopen|backlog/i;
const REGRESSION_FROM_RE = /qa|merge|deploy|review|test|pull request/i;
function isRegression(from, to) {
  return REGRESSION_FROM_RE.test(String(from || '')) && REGRESSION_TO_RE.test(String(to || ''));
}

function isAfter(dateIso, sinceIso) {
  const t = Date.parse(dateIso);
  const s = Date.parse(sinceIso);
  return Number.isFinite(t) && Number.isFinite(s) && t > s;
}

// ---------------------------------------------------------------------------

async function fetchMyTickets(cfg) {
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
  const fields = ['summary', 'status', 'priority', 'issuetype', 'updated', 'assignee'];
  const issues = await searchJql(cfg, jql, fields, 50);
  return issues.map((issue) => {
    const f = issue.fields || {};
    return {
      key: issue.key,
      summary: f.summary || '',
      status: (f.status && f.status.name) || '',
      statusCategory: (f.status && f.status.statusCategory && f.status.statusCategory.key) || '',
      priority: (f.priority && f.priority.name) || '',
      type: (f.issuetype && f.issuetype.name) || '',
      url: cfg.jira.baseUrl + '/browse/' + issue.key,
      updated: f.updated || '',
      assigneeName: (f.assignee && f.assignee.displayName) || '',
    };
  });
}

// Rough, explainable difficulty heuristic used only when the ticket carries
// no story points: longer descriptions and "investigation-shaped" wording
// bump the estimate up a notch; nothing here is a substitute for real triage.
function estimateDifficulty(f) {
  const points = f.customfield_10016 || f.customfield_10004; // common Jira Cloud story-point field ids
  if (typeof points === 'number') {
    if (points <= 2) return 'easy';
    if (points <= 5) return 'medium';
    return 'hard';
  }
  const text = (f.description && JSON.stringify(f.description)) || '';
  const len = text.length;
  const heavy = /investigat|regression|multiple|migrat|refactor|architecture/i.test(text);
  if (heavy || len > 4000) return 'hard';
  if (len > 1200) return 'medium';
  return 'easy';
}

async function fetchBacklogTickets(cfg) {
  // Recently groomed backlog only — sorting by creation date surfaces
  // years-old orphaned tickets nobody actually wants to pick up.
  const jql = 'assignee is EMPTY AND statusCategory = "To Do" AND type in (Bug, Story) ' +
    'AND updated >= "-90d" ORDER BY updated DESC';
  const fields = ['summary', 'issuetype', 'created', 'updated', 'project', 'description', 'customfield_10016', 'customfield_10004'];
  const issues = await searchJql(cfg, jql, fields, 40);
  return issues.map((issue) => {
    const f = issue.fields || {};
    return {
      key: issue.key,
      summary: f.summary || '',
      type: (f.issuetype && f.issuetype.name) || '',
      project: (f.project && f.project.key) || issue.key.split('-')[0],
      created: f.created || '',
      updated: f.updated || f.created || '',
      difficulty: estimateDifficulty(f),
      url: cfg.jira.baseUrl + '/browse/' + issue.key,
    };
  });
}

async function assignToMe(cfg, key) {
  await jiraFetch(cfg, 'PUT', '/rest/api/3/issue/' + key + '/assignee',
    { accountId: cfg.jira.myAccountId }, [204]);
}

// buildWatchlist result cache — the JQL search + readdir only need to run
// every 10 minutes, not on every 30-second poll.
const WATCHLIST_TTL_MS = 10 * 60 * 1000;
let watchlistCache = { at: 0, keys: null };

async function buildWatchlist(cfg) {
  if (watchlistCache.keys && Date.now() - watchlistCache.at < WATCHLIST_TTL_MS) {
    return watchlistCache.keys.slice();
  }

  const keys = new Set();

  const jql = '(assignee = currentUser() OR assignee WAS currentUser() OR reporter = currentUser()) AND updated >= "-14d"';
  const issues = await searchJql(cfg, jql, ['summary'], 100);
  for (const issue of issues) {
    if (issue.key) keys.add(issue.key);
  }

  try {
    const entries = fs.readdirSync(cfg.ticketsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && KEY_RE.test(ent.name)) keys.add(ent.name);
    }
  } catch (_) {
    // tickets dir missing — fine
  }

  const result = Array.from(keys);
  watchlistCache = { at: Date.now(), keys: result };
  return result.slice();
}

async function fetchIssueComments(cfg, key) {
  const res = await jiraFetch(
    cfg, 'GET',
    '/rest/api/3/issue/' + encodeURIComponent(key) + '/comment?orderBy=-created&maxResults=20'
  );
  const data = await res.json();
  return data.comments || [];
}

async function fetchIssueActivity(cfg, key, sinceIso) {
  const res = await jiraFetch(
    cfg, 'GET',
    '/rest/api/3/issue/' + encodeURIComponent(key) + '?expand=changelog&fields=summary,comment,status',
    undefined,
    [404]
  );
  if (res.status === 404) return []; // deleted / no permission — skip silently

  const issue = await res.json();
  const f = issue.fields || {};
  const title = key + ' — ' + (f.summary || '');
  const url = cfg.jira.baseUrl + '/browse/' + key;
  const out = [];

  // Comments — the issue endpoint returns only the last page; if there are
  // more than that, refetch the most recent ones explicitly.
  let comments = (f.comment && f.comment.comments) || [];
  if (f.comment && typeof f.comment.total === 'number' && f.comment.total > comments.length) {
    comments = await fetchIssueComments(cfg, key);
  }
  for (const c of comments) {
    const authorId = c.author && c.author.accountId;
    if (authorId === cfg.jira.myAccountId) continue;
    if (!isAfter(c.created, sinceIso)) continue;
    out.push({
      id: 'jira:' + key + ':comment:' + c.id,
      source: 'jira',
      kind: 'comment',
      key,
      title,
      author: (c.author && c.author.displayName) || 'Unknown',
      date: c.created,
      text: commentText(c.body),
      url,
    });
  }

  // Changelog histories → status / assign notifications.
  const histories = (issue.changelog && issue.changelog.histories) || [];
  for (const h of histories) {
    const authorId = h.author && h.author.accountId;
    if (authorId === cfg.jira.myAccountId) continue;
    if (!isAfter(h.created, sinceIso)) continue;
    const author = (h.author && h.author.displayName) || 'Unknown';
    for (const item of h.items || []) {
      if (item.field === 'status') {
        const notif = {
          id: 'jira:' + key + ':hist:' + h.id + ':status',
          source: 'jira',
          kind: 'status',
          key,
          title,
          author,
          date: h.created,
          text: (item.fromString || '?') + ' → ' + (item.toString || '?'),
          from: item.fromString || '',
          to: item.toString || '',
          url,
        };
        if (isRegression(item.fromString, item.toString)) notif.regression = true;
        out.push(notif);
      } else if (item.field === 'assignee') {
        out.push({
          id: 'jira:' + key + ':hist:' + h.id + ':assign',
          source: 'jira',
          kind: 'assign',
          key,
          title,
          author,
          date: h.created,
          text: 'Assigned to ' + (item.toString || 'Unassigned'),
          to: item.toString || 'Unassigned',
          url,
        });
      }
    }
  }

  return out;
}

/**
 * Cheap pre-filter: one small JQL search per 100 keys returns only the keys
 * updated since sinceIso — only those need a changelog/comment fetch.
 * If a pre-filter search fails (bad key in the chunk, API error, ...), fall
 * back to fetching every key of that chunk rather than dropping activity.
 */
async function prefilterUpdatedKeys(cfg, keys, sinceIso) {
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return keys.slice();
  const minutes = Math.ceil((Date.now() - sinceMs) / 60000) + 2;
  if (!(minutes > 0)) return keys.slice();

  const updated = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    try {
      const jql = 'key in (' + chunk.join(',') + ') AND updated >= "-' + minutes + 'm"';
      const issues = await searchJql(cfg, jql, ['key'], chunk.length);
      for (const issue of issues) {
        if (issue.key) updated.push(issue.key);
      }
    } catch (_) {
      // Pre-filter failed for this chunk — fetch all of its keys instead.
      updated.push(...chunk);
    }
  }
  return updated;
}

async function fetchActivity(cfg, keys, sinceIso) {
  const active = await prefilterUpdatedKeys(cfg, keys, sinceIso);
  const lists = await pool(active, 5, (key) => fetchIssueActivity(cfg, key, sinceIso));
  return lists.flat();
}

async function fetchTicketDetail(cfg, key) {
  const res = await jiraFetch(
    cfg, 'GET',
    '/rest/api/3/issue/' + encodeURIComponent(key) +
      '?fields=summary,description,status,priority,issuetype,reporter,assignee,created,updated,comment'
  );
  const issue = await res.json();
  const f = issue.fields || {};

  // Comments: last 10, oldest → newest. The issue payload only carries the
  // last page; if there are more comments than that, fetch the real last page.
  let comments = (f.comment && f.comment.comments) || [];
  const total = (f.comment && f.comment.total) || 0;
  if (total > comments.length) {
    const startAt = Math.max(0, total - 10);
    const cRes = await jiraFetch(
      cfg, 'GET',
      '/rest/api/3/issue/' + encodeURIComponent(key) +
        '/comment?orderBy=created&startAt=' + startAt + '&maxResults=10'
    );
    const cData = await cRes.json();
    comments = cData.comments || [];
  }
  comments = comments.slice(-10).map((c) => ({
    id: c.id,
    author: (c.author && c.author.displayName) || 'Unknown',
    date: c.created,
    text: adfBodyToText(c.body, 1000) || '[comment]',
  }));

  return {
    key: issue.key || key,
    summary: f.summary || '',
    status: (f.status && f.status.name) || '',
    statusCategory: (f.status && f.status.statusCategory && f.status.statusCategory.key) || '',
    priority: (f.priority && f.priority.name) || '',
    type: (f.issuetype && f.issuetype.name) || '',
    reporter: (f.reporter && f.reporter.displayName) || '',
    assignee: (f.assignee && f.assignee.displayName) || '',
    created: f.created || '',
    updated: f.updated || '',
    url: cfg.jira.baseUrl + '/browse/' + (issue.key || key),
    description: adfBodyToText(f.description, 3000),
    comments,
  };
}

async function postComment(cfg, key, text) {
  const body = textToAdf(text); // throws on empty/blank-only text
  const urlPath = '/rest/api/3/issue/' + encodeURIComponent(key) + '/comment';
  const res = await fetch(cfg.jira.baseUrl + urlPath, {
    method: 'POST',
    headers: {
      Authorization: authHeader(cfg),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let snippet = '';
    try { snippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch (_) { /* ignore */ }
    throw new Error(
      'Jira POST ' + urlPath + ' failed: HTTP ' + res.status + (snippet ? ' — ' + snippet : '')
    );
  }
  return res.json();
}

module.exports = {
  fetchMyTickets, buildWatchlist, fetchActivity, fetchTicketDetail, postComment,
  fetchBacklogTickets, assignToMe,
};
