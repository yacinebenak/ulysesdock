# WorkDock — side-docked work monitor (Electron, Windows)

One Electron app, docked to the RIGHT edge of the screen. Expanded width 400px, full work-area height.
Collapsed = slim 36px rail with a "<=" button and an unread badge. Expanding/collapsing is done by the
MAIN process resizing/repositioning the window; the renderer just toggles `body.collapsed` and calls the IPC.

User: Yacine BENAKMOUME
- Jira: https://tesipro.atlassian.net — accountId `712020:5ac9f2bd-4a8d-498e-bd8d-745681e10d56`
- Bitbucket workspace `pmsweb`, repos `backend` + `frontend`, my uuid `{e2ced27e-5168-4977-ba78-4c4f10ebf737}` — Bearer token auth
- Node 24 (global `fetch` available). CommonJS modules (`require`/`module.exports`). NO npm deps beyond `electron`.

## Files

- `src/config.js` (DONE — do not touch): `async loadConfig()` → see shape below.
- `src/services/jira.js` (Agent A)
- `src/services/bitbucket.js` (Agent A)
- `src/services/state.js` (Agent A)
- `src/main.js`, `src/preload.js` (DONE — do not touch)
- `src/ui/index.html`, `src/ui/styles.css`, `src/ui/app.js` (Agent B)

## config shape

```js
{
  jira: { baseUrl: 'https://tesipro.atlassian.net', email, token, myAccountId },
  bitbucket: { workspace: 'pmsweb', repos: ['backend', 'frontend'], token, myUuid },
  ticketsDir: 'C:\\Users\\YAC.BENAKMOUME\\IdeaProjects\\tickets', // local grabbed-ticket folders = "I touched this"
  pollIntervalMs: 30000,
  ignoreAuthors: ['UlysesSuite'] // bot authors — never generate notifications from these (case-insensitive)
}
```

Because polling is every 30s, services must be cheap in steady state: bitbucket caches PR details by
`repo#id`+updated_on and skips activity for PRs not updated since last poll; jira pre-filters the watchlist
with a `key in (...) AND updated >= "-Nm"` search before fetching changelogs, and caches the watchlist 10 min.

All service functions receive this `cfg` as first arg. All HTTP via global `fetch`.
Jira auth: `Authorization: Basic base64(email + ':' + token)`. Bitbucket auth: `Authorization: Bearer token`.
Every service function must catch its own network errors and THROW with a clear message; the caller (main.js) handles them.

## services/jira.js — module.exports = { fetchMyTickets, buildWatchlist, fetchActivity }

### fetchMyTickets(cfg) → Promise<Ticket[]>
JQL: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` (max 50).
Use `POST /rest/api/3/search/jql` body `{jql, maxResults, fields:[...]}` with pagination via `nextPageToken`;
if it 404s (older API), fall back to `POST /rest/api/3/search` with `startAt`.
Ticket = `{ key, summary, status, statusCategory, priority, type, url, updated, assigneeName }`
url = `https://tesipro.atlassian.net/browse/<KEY>`.

### buildWatchlist(cfg) → Promise<string[]>  (issue keys, deduped)
Union of:
1. JQL `(assignee = currentUser() OR assignee WAS currentUser() OR reporter = currentUser()) AND updated >= "-14d"` — keys only (max 100).
2. Local folder names under `cfg.ticketsDir` matching `/^[A-Z][A-Z0-9]+-\d+$/` (these are tickets he grabbed/commented on).
Watchlist = tickets whose activity generates notifications. NOTHING outside it may generate a Jira notification.

### fetchActivity(cfg, keys, sinceIso) → Promise<Notification[]>
For each key (concurrency ≤ 5): `GET /rest/api/3/issue/<KEY>?expand=changelog&fields=summary,comment,status`.
Skip keys that 404 (deleted/no permission) silently.
Emit, ONLY for events strictly after `sinceIso` and NOT authored by `cfg.jira.myAccountId`:
- each comment → kind `comment`, text = first ~200 chars of the comment rendered as plain text (walk ADF nodes, join text values; on failure fall back to '[comment]')
- each changelog history with a `status` item → kind `status`, `from`/`to` = fromString/toString
- each changelog history with an `assignee` item → kind `assign`, `to` = assignee displayName
Notification = `{ id, source:'jira', kind, key, title: key + ' — ' + summary, author, date (ISO), text, from, to, url }`
Deterministic ids: `jira:<KEY>:comment:<commentId>` / `jira:<KEY>:hist:<historyId>:status` / `...:assign`.
NOTE: Jira `comment` field returns only the last page of comments when fetched this way — that is fine (recent ones are what matter); if `fields.comment.total > comments.length`, fetch `GET /rest/api/3/issue/<KEY>/comment?orderBy=-created&maxResults=20` instead.

## services/bitbucket.js — module.exports = { fetchMyPRs, fetchPRActivity }

### fetchMyPRs(cfg) → Promise<PR[]>
For each repo: `GET /2.0/repositories/pmsweb/<repo>/pullrequests?q=author.uuid="<uuid>" AND state="OPEN"&pagelen=50` (URL-encode q; follow `next` pages)
PLUS one page of `q=author.uuid="<uuid>" AND (state="MERGED" OR state="DECLINED")&sort=-updated_on&pagelen=20` (no detail fetch for closed PRs).
For each OPEN PR fetch detail `GET .../pullrequests/<id>` (concurrency ≤ 4) to get `participants`, cached by repo#id+updated_on.
PR = `{ id, repo, title, url (links.html.href), sourceBranch, destBranch, created (created_on), updated (updated_on), state, commentCount (comment_count), taskCount (task_count), approvals (# participants approved===true), requestedChanges (# participants state==='changes_requested') }`
Sort by `created` DESC.

### fetchPRActivity(cfg, prs, sinceIso) → Promise<Notification[]>
For each PR (concurrency ≤ 4): `GET /2.0/repositories/pmsweb/<repo>/pullrequests/<id>/activity?pagelen=30` (first page only).
Emit, ONLY for events strictly after sinceIso and NOT by my uuid:
- entry with `comment` → kind `pr-comment`, text = comment.content.raw (first ~200 chars), id `bb:<repo>:<id>:comment:<comment.id>`
- entry with `approval` → kind `pr-approval`, author = approval.user, date = approval.date, id `bb:<repo>:<id>:approval:<user.uuid>:<date>`
- entry with `changes_requested` → kind `pr-changes`, same pattern
Notification = `{ id, source:'bitbucket', kind, key: '<repo>#<id>', title: '<repo> PR #<id> — <PR title>', author, date, text, url }`

## services/state.js — module.exports = { loadState, saveState, mergeNotifications }

State file: `path.join(app-data-dir, 'state.json')` — but state.js must NOT require electron. `loadState(dir)` /
`saveState(dir, state)` take the directory as an argument (main.js passes `app.getPath('userData')`).
State = `{ lastPollIso: string|null, dismissed: string[] (cap 2000, FIFO), notifications: Notification[] }`.
`mergeNotifications(state, incoming)` → dedupes by id against existing + dismissed, prepends new ones,
sorts date DESC, caps at 200, returns `{ state, freshOnes }` where freshOnes = the genuinely-new notifications
(main.js shows Windows toasts for those). Corrupt/missing state file → return clean default, never throw.

## IPC contract (preload exposes `window.workdock`)

- `getSnapshot()` → Promise<Snapshot>
- `onSnapshot(cb)` — cb(Snapshot) on every poll
- `dismiss(id)`, `dismissAll()` — returns updated Snapshot via onSnapshot push
- `refresh()` — force poll now
- `openExternal(url)`
- `setCollapsed(bool)` — main resizes window (collapsed: 36px wide; expanded: 400px), renderer toggles body class
- `quit()`

Snapshot = `{ tickets: Ticket[], prs: PR[], notifications: Notification[], unread: number, lastSync: ISO|null, polling: bool, errors: string[] }`

## UI (Agent B) — src/ui/index.html + styles.css + app.js

Plain HTML/CSS/JS, no frameworks, no external assets/fonts/CDN. `contextIsolation` is on — use ONLY `window.workdock`.

Layout, expanded (400px):
- Top bar: app name "WorkDock", last-sync time (e.g. "sync 08:41"), refresh ⟳ button (spins while polling), collapse button "=>" (docks to rail), quit ✕ (small, discreet).
- Tab strip: `PRs` | `Tickets` | `Notifs` — Notifs tab shows a red badge with unread count when > 0.
- PRs tab: sticky chip filter row — Open (default) · Validated (OPEN & approvals≥1) · Changes (OPEN & requestedChanges>0) · Merged · Declined · All, with counts, selection persisted in localStorage. Cards ordered as delivered (created DESC). Card: title (bold, 2-line clamp, click → openExternal), repo chip (backend=blue, frontend=purple), state chip when MERGED (green) / DECLINED (red), `source → dest` branch line (mono, small), created date ("Aug 10"), footer row: 💬 commentCount · ✅ approvals · ⚠ requestedChanges (only if >0) · task count if >0. Subtle hover.
- Tickets tab: chip filter row (All + one chip per distinct status, counts, persisted). Tickets grouped in sections by status with headers ("In Progress (3)"), groups ordered by statusCategory new → indeterminate → done. Card per ticket: key (mono, click → open), summary (2-line clamp), status chip colored by statusCategory (todo=grey, indeterminate=blue, done=green), priority icon/text, updated date.
- Notifs tab: "Clear all" link top-right. Card: kind icon (💬 comment / 🔀 status / 👤 assign / ✅ approval / ⚠ changes), title line (clickable → open url), body text (3-line clamp), author + relative time ("2h ago"), X button top-right → `dismiss(id)` with a quick fade-out.
- Empty states: friendly one-liners ("No open PRs 🎉", "All caught up ✨", "Nothing assigned").
- Error strip: if snapshot.errors non-empty, thin amber strip at bottom, truncated message, tooltip full.

Collapsed (36px rail): body.collapsed hides everything, shows vertical rail: "<=" button at top (→ `setCollapsed(false)`), below it the unread badge (red circle w/ count, hidden if 0), and vertical "WorkDock" text. The MAIN process persists collapse state.

Style: dark theme. Background #1b1e24, cards #242832, borders #313743, text #e6e9ef, muted #9aa3b2, accent #4c8dff, danger #e5534b, ok #46a758, warn #d29922. Segoe UI. Compact (13px base). Custom slim scrollbar. The whole top bar is a drag region (`-webkit-app-region: drag`) with buttons marked `no-drag`.

Renderer boot: call `getSnapshot()` immediately, subscribe `onSnapshot`, render. Re-render relative times every 60s.
