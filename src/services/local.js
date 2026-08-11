'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TICKET_RE = /[A-Z][A-Z0-9]+-\d+/g;

/**
 * Standup window start: Monday → previous Friday 00:00 local,
 * any other day → yesterday 00:00 local.
 */
function standupSince(now) {
  const isMonday = now.getDay() === 1;
  const daysBack = isMonday ? 3 : 1;
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
  return { since, sinceLabel: isMonday ? 'vendredi' : 'hier' };
}

function gitLog(repoPath, sinceIso, author) {
  try {
    if (!fs.existsSync(repoPath)) return [];
    const res = spawnSync('git', [
      'log', '--all',
      '--since=' + sinceIso,
      '--author=' + author,
      '--no-merges',
      '--pretty=format:%H|%aI|%s',
    ], { cwd: repoPath, encoding: 'utf8', windowsHide: true });
    if (res.error || res.status !== 0 || !res.stdout) return [];

    const repo = path.basename(repoPath);
    const commits = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const hash = parts[0];
      const date = parts[1];
      const subject = parts.slice(2).join('|'); // subject may itself contain '|'
      commits.push({
        repo,
        hash: hash.slice(0, 10),
        date,
        subject,
        tickets: Array.from(new Set(subject.match(TICKET_RE) || [])),
      });
    }
    return commits;
  } catch (_) {
    return []; // git missing / not a repo / anything else — never throw
  }
}

function getStandup(cfg) {
  const { since, sinceLabel } = standupSince(new Date());
  const sinceIso = since.toISOString();

  let commits = [];
  for (const repoPath of cfg.localRepos || []) {
    commits = commits.concat(gitLog(repoPath, sinceIso, cfg.gitAuthor || ''));
  }

  // Worktrees of the same repo share commits — dedupe on subject+date.
  const seen = new Set();
  commits = commits.filter((c) => {
    const k = c.subject + '::' + c.date;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  commits.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  return { sinceIso, sinceLabel, commits };
}

module.exports = { getStandup };
