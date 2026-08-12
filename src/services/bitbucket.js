'use strict';

const API = 'https://api.bitbucket.org';
const TIMEOUT_MS = 20000;

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

async function bbFetch(cfg, url, okStatuses) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + cfg.bitbucket.token,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && !(okStatuses && okStatuses.includes(res.status))) {
    let shortPath = url;
    try { shortPath = new URL(url).pathname; } catch (_) { /* keep full url */ }
    throw new Error('Bitbucket GET ' + shortPath + ' failed: HTTP ' + res.status);
  }
  return res;
}

/** Normalize a Bitbucket uuid by stripping surrounding braces. */
function bareUuid(uuid) {
  return String(uuid || '').replace(/[{}]/g, '');
}

function isMe(cfg, user) {
  return !!user && bareUuid(user.uuid) === bareUuid(cfg.bitbucket.myUuid);
}

function isAfter(dateIso, sinceIso) {
  const t = Date.parse(dateIso);
  const s = Date.parse(sinceIso);
  return Number.isFinite(t) && Number.isFinite(s) && t > s;
}

function repoBase(cfg, repo) {
  return API + '/2.0/repositories/' + cfg.bitbucket.workspace + '/' + repo;
}

/** True when the event author's display_name or nickname is in cfg.ignoreAuthors. */
function isIgnoredAuthor(cfg, user) {
  const list = cfg.ignoreAuthors || [];
  if (!user || list.length === 0) return false;
  const dn = String(user.display_name || '').toLowerCase();
  const nn = String(user.nickname || '').toLowerCase();
  return list.some((a) => {
    const low = String(a).toLowerCase();
    return low === dn || low === nn;
  });
}

/** Build the PR shape from a Bitbucket PR payload (list or detail). */
function mapPR(repo, pr) {
  const participants = pr.participants || [];
  return {
    reviewState: null,
    lastHumanComment: null,
    id: pr.id,
    repo,
    title: pr.title || '',
    url: (pr.links && pr.links.html && pr.links.html.href) || '',
    sourceBranch: (pr.source && pr.source.branch && pr.source.branch.name) || '',
    destBranch: (pr.destination && pr.destination.branch && pr.destination.branch.name) || '',
    created: pr.created_on || '',
    updated: pr.updated_on || '',
    state: pr.state || '',
    commentCount: pr.comment_count || 0,
    taskCount: pr.task_count || 0,
    approvals: participants.filter((p) => p.approved === true).length,
    requestedChanges: participants.filter((p) => p.state === 'changes_requested').length,
  };
}

/**
 * Newest non-deleted, NON-RESOLVED comment on a PR whose author is not a bot
 * (cfg.ignoreAuthors). My own comments DO count (isMine: true).
 *
 * Bitbucket marks a resolved thread by the PRESENCE of a `resolution` key on
 * the thread's top-level comment (the key is absent on unresolved ones).
 * Replies inherit their root comment's resolution. Resolved threads are
 * answered feedback — they must not flag a PR as awaiting a reply.
 *
 * Returns { last, hadResolvedThreads } — the second flag distinguishes
 * "feedback existed but was all addressed" from "nobody ever commented".
 * First page of comments sorted newest-first is enough.
 */
async function fetchLastHumanComment(cfg, repo, id) {
  const res = await bbFetch(
    cfg,
    repoBase(cfg, repo) + '/pullrequests/' + id + '/comments?pagelen=50&sort=-created_on',
    [404]
  );
  if (res.status === 404) return { last: null, hadResolvedThreads: false };
  const data = await res.json();
  const all = data.values || [];
  const byId = new Map(all.map((c) => [c.id, c]));

  const isResolved = (c) => {
    let node = c;
    for (let hops = 0; node && hops < 20; hops++) {
      if (!node.parent) return 'resolution' in node;
      node = byId.get(node.parent.id);
    }
    // Root is on an older page we didn't fetch — treat as unresolved (safe default).
    return false;
  };

  let last = null;
  let hadResolvedThreads = false;
  for (const c of all) {
    if (c.deleted) continue;
    if (isIgnoredAuthor(cfg, c.user)) continue;
    if (isResolved(c)) {
      hadResolvedThreads = true;
      continue;
    }
    if (!last) {
      last = {
        author: (c.user && c.user.display_name) || 'Unknown',
        date: c.created_on || '',
        isMine: isMe(cfg, c.user),
      };
    }
  }
  return { last, hadResolvedThreads };
}

/** Review-state precedence: awaiting_me > approved > awaiting_reviewers > unreviewed. */
function computeReviewState(approvals, lastHumanComment, hadResolvedThreads) {
  if (lastHumanComment && !lastHumanComment.isMine) return 'awaiting_me';
  if (approvals >= 1) return 'approved';
  // Either I spoke last, or all feedback threads were resolved — ball is with reviewers.
  if (lastHumanComment || hadResolvedThreads) return 'awaiting_reviewers';
  return 'unreviewed';
}

// ---------------------------------------------------------------------------

// Cache of full OPEN-PR objects keyed 'repo#id' → { updated, pr }. When the
// list payload's updated_on matches the cached value, the detail and comment
// fetches are skipped and the cached PR (including reviewState /
// lastHumanComment) is reused — comment-only activity bumps updated_on in
// Bitbucket, so an unchanged updated_on means nothing to recompute.
// Steady-state polls are just the list requests.
const prDetailCache = new Map();

async function fetchMyPRs(cfg) {
  const openListed = [];
  const closed = [];

  for (const repo of cfg.bitbucket.repos) {
    // Open PRs — follow all pages.
    const qOpen = 'author.uuid="' + cfg.bitbucket.myUuid + '" AND state="OPEN"';
    let url = repoBase(cfg, repo) + '/pullrequests?q=' + encodeURIComponent(qOpen) + '&pagelen=50';
    while (url) {
      const res = await bbFetch(cfg, url);
      const data = await res.json();
      for (const pr of data.values || []) openListed.push({ repo, pr });
      url = data.next || null;
    }

    // Recently closed PRs — one page only, no detail fetch.
    const qClosed = 'author.uuid="' + cfg.bitbucket.myUuid + '" AND (state="MERGED" OR state="DECLINED")';
    const resClosed = await bbFetch(
      cfg,
      repoBase(cfg, repo) + '/pullrequests?q=' + encodeURIComponent(qClosed) + '&sort=-updated_on&pagelen=20'
    );
    const dataClosed = await resClosed.json();
    for (const pr of dataClosed.values || []) closed.push(mapPR(repo, pr));
  }

  // Full detail per open PR (list payload lacks participants) plus its
  // review state, unless the cached copy is still current.
  const open = await pool(openListed, 4, async ({ repo, pr }) => {
    const cacheKey = repo + '#' + pr.id;
    const cached = prDetailCache.get(cacheKey);
    if (cached && cached.updated === pr.updated_on) return cached.pr;
    const res = await bbFetch(cfg, repoBase(cfg, repo) + '/pullrequests/' + pr.id);
    const full = mapPR(repo, await res.json());
    const { last, hadResolvedThreads } = await fetchLastHumanComment(cfg, repo, pr.id);
    full.lastHumanComment = last;
    full.reviewState = computeReviewState(full.approvals, last, hadResolvedThreads);
    prDetailCache.set(cacheKey, { updated: pr.updated_on, pr: full });
    return full;
  });

  // Evict cache entries for PRs no longer open (merged/declined/removed).
  const openKeys = new Set(openListed.map(({ repo, pr }) => repo + '#' + pr.id));
  for (const key of prDetailCache.keys()) {
    if (!openKeys.has(key)) prDetailCache.delete(key);
  }

  const prs = open.concat(closed);
  prs.sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
  return prs;
}

async function fetchSinglePRActivity(cfg, pr, sinceIso) {
  const res = await bbFetch(
    cfg,
    repoBase(cfg, pr.repo) + '/pullrequests/' + pr.id + '/activity?pagelen=30',
    [404]
  );
  if (res.status === 404) return [];
  const data = await res.json();
  const out = [];
  const key = pr.repo + '#' + pr.id;
  const title = pr.repo + ' PR #' + pr.id + ' — ' + pr.title;

  for (const entry of data.values || []) {
    if (entry.comment) {
      const c = entry.comment;
      if (c.deleted) continue;
      if (isMe(cfg, c.user) || isIgnoredAuthor(cfg, c.user)) continue;
      if (!isAfter(c.created_on, sinceIso)) continue;
      out.push({
        id: 'bb:' + pr.repo + ':' + pr.id + ':comment:' + c.id,
        source: 'bitbucket',
        kind: 'pr-comment',
        key,
        title,
        author: (c.user && c.user.display_name) || 'Unknown',
        date: c.created_on,
        text: ((c.content && c.content.raw) || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        url: pr.url,
      });
    } else if (entry.approval) {
      const a = entry.approval;
      if (isMe(cfg, a.user) || isIgnoredAuthor(cfg, a.user)) continue;
      if (!isAfter(a.date, sinceIso)) continue;
      out.push({
        id: 'bb:' + pr.repo + ':' + pr.id + ':approval:' + bareUuid(a.user && a.user.uuid) + ':' + a.date,
        source: 'bitbucket',
        kind: 'pr-approval',
        key,
        title,
        author: (a.user && a.user.display_name) || 'Unknown',
        date: a.date,
        text: 'approved the pull request',
        url: pr.url,
      });
    } else if (entry.changes_requested) {
      const cr = entry.changes_requested;
      if (isMe(cfg, cr.user) || isIgnoredAuthor(cfg, cr.user)) continue;
      if (!isAfter(cr.date, sinceIso)) continue;
      out.push({
        id: 'bb:' + pr.repo + ':' + pr.id + ':changes:' + bareUuid(cr.user && cr.user.uuid) + ':' + cr.date,
        source: 'bitbucket',
        kind: 'pr-changes',
        key,
        title,
        author: (cr.user && cr.user.display_name) || 'Unknown',
        date: cr.date,
        text: 'requested changes',
        url: pr.url,
      });
    }
    // entries with `update` are ignored
  }
  return out;
}

async function fetchPRActivity(cfg, prs, sinceIso) {
  // A PR whose updated_on is not strictly after sinceIso cannot have new
  // activity — skip its activity fetch entirely (main passes only OPEN PRs,
  // but be defensive about state too).
  const active = prs.filter((pr) => pr.state === 'OPEN' && isAfter(pr.updated, sinceIso));
  const lists = await pool(active, 4, (pr) => fetchSinglePRActivity(cfg, pr, sinceIso));
  return lists.flat();
}

module.exports = { fetchMyPRs, fetchPRActivity };
