'use strict';

(function () {
  // Never throw if the preload bridge is missing — degrade to inert no-ops.
  const noop = function () {};
  const wd = Object.assign({
    getSnapshot: function () { return Promise.resolve(null); },
    onSnapshot: noop,
    dismiss: noop,
    dismissAll: noop,
    refresh: noop,
    openExternal: noop,
    setCollapsed: noop,
    quit: noop,
    ticketDetail: function () { return Promise.reject(new Error('bridge missing')); },
    postComment: function () { return Promise.reject(new Error('bridge missing')); },
    getStandup: function () { return Promise.resolve({ sinceIso: null, sinceLabel: 'hier', commits: [] }); },
    copyText: noop,
    setupSave: function () { return Promise.resolve({ ok: false }); },
  }, window.workdock || {});

  // ---------- helpers ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function $(id) { return document.getElementById(id); }

  function parseTs(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  }

  function shortDate(ts) {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function relTime(iso) {
    const t = parseTs(iso);
    if (t === null) return '';
    const diff = Date.now() - t;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return shortDate(t);
  }

  function clockTime(iso) {
    const t = parseTs(iso);
    if (t === null) return '—';
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function relTimeEl(iso) {
    const node = el('span', 'reltime', relTime(iso));
    node.dataset.ts = iso || '';
    return node;
  }

  function makeLink(node, url, tooltip) {
    if (!url) return;
    node.classList.add('link');
    node.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation(); // don't trigger card-level handlers
      wd.openExternal(url);
    });
    if (tooltip) node.title = tooltip;
  }

  function errMsg(e) {
    return String((e && e.message) || e || 'Something went wrong');
  }

  // ---------- element refs ----------

  const body = document.body;
  const syncLabel = $('sync-label');
  const refreshBtn = $('refresh-btn');
  const collapseBtn = $('collapse-btn');
  const expandBtn = $('expand-btn');
  const quitBtn = $('quit-btn');
  const clearAllBtn = $('clear-all');
  const notifTools = $('notif-tools');
  const errorStrip = $('error-strip');
  const errorText = $('error-text');
  const tabBadge = $('tab-badge');
  const railBadge = $('rail-badge');

  const tabs = { today: $('tab-today'), prs: $('tab-prs'), tickets: $('tab-tickets'), notifs: $('tab-notifs') };
  const panels = { today: $('panel-today'), prs: $('panel-prs'), tickets: $('panel-tickets'), notifs: $('panel-notifs') };
  // Static per-panel children: the filter bar never scrolls; the list scrolls
  // in its own box strictly below it. Scroll position lives on .panel-scroll.
  const scrolls = { today: $('today-scroll'), prs: $('prs-scroll'), tickets: $('tickets-scroll'), notifs: $('notif-list') };
  const filterEls = { prs: $('prs-filters'), tickets: $('tickets-filters') };

  // ---------- state ----------

  let snap = { tickets: [], prs: [], notifications: [], unread: 0, lastSync: null, polling: false, errors: [] };
  const fingerprints = { today: null, prs: null, tickets: null, notifs: null };
  const dismissing = new Set();
  let activeTab = 'today';

  // Ticket quick-view drawer state (null = closed).
  let drawer = null;

  // Standup cache: refreshed on snapshot pushes at most once per 5 minutes.
  const STANDUP_TTL = 5 * 60 * 1000;
  const standup = { data: null, fetchedAt: 0, loading: false, error: null };

  // ---------- per-tab filters (persisted) ----------

  const store = {
    get: function (key, fallback) {
      try { return window.localStorage.getItem(key) || fallback; } catch (err) { return fallback; }
    },
    set: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (err) { /* storage unavailable */ }
    },
  };

  function prState(pr) {
    return String((pr && pr.state) || 'OPEN').toUpperCase();
  }

  const REVIEW_STATES = {
    awaiting_me: { label: 'À répondre', cls: 'rs-awaiting-me' },
    approved: { label: 'Approuvée', cls: 'rs-approved' },
    awaiting_reviewers: { label: 'Chez les reviewers', cls: 'rs-awaiting-reviewers' },
    unreviewed: { label: 'Pas encore relue', cls: 'rs-unreviewed' },
  };

  function isAwaitingMe(pr) {
    return prState(pr) === 'OPEN' && (pr && pr.reviewState) === 'awaiting_me';
  }

  const PR_FILTERS = [
    { id: 'open', label: 'Open', test: function (pr) { return prState(pr) === 'OPEN'; } },
    { id: 'awaiting', label: 'À répondre', test: isAwaitingMe },
    { id: 'validated', label: 'Validated', test: function (pr) { return prState(pr) === 'OPEN' && Number((pr && pr.approvals) || 0) >= 1; } },
    { id: 'changes', label: 'Changes', test: function (pr) { return prState(pr) === 'OPEN' && Number((pr && pr.requestedChanges) || 0) > 0; } },
    { id: 'merged', label: 'Merged', test: function (pr) { return prState(pr) === 'MERGED'; } },
    { id: 'declined', label: 'Declined', test: function (pr) { return prState(pr) === 'DECLINED'; } },
    { id: 'all', label: 'All', test: function () { return true; } },
  ];

  const filters = {
    prs: store.get('workdock.filter.prs', 'open'),
    tickets: store.get('workdock.filter.tickets', 'all'),
    ticketsProject: store.get('workdock.filter.ticketsProject', 'all'),
  };
  if (!PR_FILTERS.some(function (f) { return f.id === filters.prs; })) filters.prs = 'open';

  // Which tab a filter belongs to (ticketsProject drives the tickets panel).
  const FILTER_TAB = { prs: 'prs', tickets: 'tickets', ticketsProject: 'tickets' };

  function safeFilter(list, test) {
    return list.filter(function (item) {
      try { return !!test(item); } catch (err) { return false; }
    });
  }

  function chipRow(defs, activeId, onSelect) {
    const row = el('div', 'chip-row');
    for (const def of defs) {
      const chip = el('button', 'fchip' + (def.id === activeId ? ' active' : ''));
      chip.appendChild(el('span', null, def.label));
      chip.appendChild(el('span', 'fchip-count', def.count));
      chip.addEventListener('click', function () { onSelect(def.id); });
      row.appendChild(chip);
    }
    return row;
  }

  function setFilter(name, id) {
    filters[name] = id;
    store.set('workdock.filter.' + name, id);
    const tab = FILTER_TAB[name] || name;
    fingerprints[tab] = tabFingerprint(tab);
    RENDER[tab]();
  }

  // ---------- PR cards ----------

  function repoChipClass(repo) {
    return repo === 'backend' ? 'repo-backend' : (repo === 'frontend' ? 'repo-frontend' : 'repo-other');
  }

  function reviewBadge(pr) {
    if (prState(pr) !== 'OPEN') return null; // only open PRs carry a review state
    const rs = REVIEW_STATES[pr && pr.reviewState];
    if (!rs) return null;
    const badge = el('span', 'chip review-chip ' + rs.cls);
    badge.appendChild(el('span', 'dot'));
    badge.appendChild(el('span', null, rs.label));
    return badge;
  }

  function commenterLine(pr) {
    const lhc = pr && pr.lastHumanComment;
    if (!lhc || lhc.isMine) return null;
    const line = el('div', 'pr-comment-line muted');
    line.appendChild(el('span', null, '💬 ' + (lhc.author || '?') + ' · '));
    line.appendChild(relTimeEl(lhc.date));
    return line;
  }

  function prCard(pr) {
    const card = el('div', 'card pr-card');

    const title = el('div', 'card-title clamp2', (pr && pr.title) || '(untitled PR)');
    makeLink(title, pr && pr.url, (pr && pr.title) || '');
    card.appendChild(title);

    const meta = el('div', 'row tight');
    const repo = (pr && pr.repo) || '';
    meta.appendChild(el('span', 'chip ' + repoChipClass(repo), repo || 'repo'));
    const state = prState(pr);
    if (state === 'MERGED') meta.appendChild(el('span', 'chip state-merged', 'Merged'));
    else if (state === 'DECLINED') meta.appendChild(el('span', 'chip state-declined', 'Declined'));
    const badge = reviewBadge(pr);
    if (badge) meta.appendChild(badge);
    const created = parseTs(pr && pr.created);
    meta.appendChild(el('span', 'muted small', created !== null ? shortDate(created) : ''));
    card.appendChild(meta);

    const src = (pr && pr.sourceBranch) || '?';
    const dst = (pr && pr.destBranch) || '?';
    const branches = el('div', 'branches mono', src + ' → ' + dst);
    branches.title = src + ' → ' + dst;
    card.appendChild(branches);

    const commenter = commenterLine(pr);
    if (commenter) card.appendChild(commenter);

    const foot = el('div', 'row foot');
    foot.appendChild(el('span', 'stat', '💬 ' + ((pr && pr.commentCount) || 0)));
    foot.appendChild(el('span', 'stat ok', '✅ ' + ((pr && pr.approvals) || 0)));
    if (pr && pr.requestedChanges > 0) foot.appendChild(el('span', 'stat warn', '⚠ ' + pr.requestedChanges));
    if (pr && pr.taskCount > 0) foot.appendChild(el('span', 'stat', '☑ ' + pr.taskCount + ' tasks'));
    card.appendChild(foot);

    return card;
  }

  // ---------- ticket cards ----------

  function categoryRank(ticket) {
    const cat = String((ticket && ticket.statusCategory) || '').toLowerCase();
    if (cat.indexOf('done') !== -1) return 2;
    if (cat.indexOf('progress') !== -1 || cat.indexOf('indeterminate') !== -1) return 1;
    return 0; // new / todo / unknown
  }

  function categoryClass(ticket) {
    const rank = categoryRank(ticket);
    return rank === 2 ? 'cat-done' : (rank === 1 ? 'cat-indeterminate' : 'cat-todo');
  }

  function projectOf(ticket) {
    const key = String((ticket && ticket.key) || '');
    return key.split('-')[0] || '—';
  }

  const PRIORITY = {
    highest: ['⇈', 'pri-highest'],
    high: ['↑', 'pri-high'],
    medium: ['•', 'pri-medium'],
    low: ['↓', 'pri-low'],
    lowest: ['⇊', 'pri-lowest'],
  };

  function priorityEl(priority) {
    const entry = PRIORITY[String(priority || '').toLowerCase()];
    if (!entry) return el('span', 'pri pri-none', priority ? String(priority) : '');
    return el('span', 'pri ' + entry[1], entry[0] + ' ' + priority);
  }

  function ticketCard(ticket) {
    // Status is NOT repeated on the card — the section header carries it.
    const card = el('div', 'card ticket-card ' + categoryClass(ticket));
    if (ticket && ticket.key) {
      card.classList.add('openable');
      card.addEventListener('click', function () { openDrawer(ticket.key); });
    }

    const head = el('div', 'row card-head');
    const key = el('span', 'ticket-key mono', (ticket && ticket.key) || '—');
    makeLink(key, ticket && ticket.url, 'Open in Jira');
    head.appendChild(key);
    head.appendChild(el('span', 'spacer'));
    head.appendChild((function () {
      const t = relTimeEl(ticket && ticket.updated);
      t.classList.add('muted', 'small');
      return t;
    })());
    card.appendChild(head);

    card.appendChild(el('div', 'ticket-summary clamp2', (ticket && ticket.summary) || ''));

    const priority = ticket && ticket.priority;
    const type = ticket && ticket.type;
    if (priority || type) {
      const meta = el('div', 'row tight foot');
      if (priority) meta.appendChild(priorityEl(priority));
      if (priority && type) meta.appendChild(el('span', 'meta-sep', '·'));
      if (type) meta.appendChild(el('span', 'muted small', type));
      card.appendChild(meta);
    }

    return card;
  }

  // ---------- notification cards ----------

  const KIND_ICON = {
    'comment': '💬',
    'pr-comment': '💬',
    'status': '🔀',
    'assign': '👤',
    'pr-approval': '✅',
    'pr-changes': '⚠️',
  };

  function notifBody(n) {
    if (!n) return '';
    if (n.kind === 'status') {
      if (n.from || n.to) return (n.from || '?') + ' → ' + (n.to || '?');
      return n.text || '';
    }
    if (n.kind === 'assign') return n.to ? ('Assigned to ' + n.to) : (n.text || '');
    return n.text || '';
  }

  function notifIcon(n) {
    if (n && n.regression) return '↩️';
    return KIND_ICON[n && n.kind] || '🔔';
  }

  function notifCard(n) {
    const card = el('div', 'card notif-card' + (n && n.regression ? ' regression' : ''));

    const head = el('div', 'row notif-head');
    head.appendChild(el('span', 'kind-icon', notifIcon(n)));
    if (n && n.regression) head.appendChild(el('span', 'tag-retour', 'RETOUR'));
    const title = el('div', 'card-title clamp2 notif-title', (n && (n.title || n.key)) || '(notification)');
    makeLink(title, n && n.url, (n && n.title) || '');
    head.appendChild(title);
    const dismissBtn = el('button', 'icon-btn dismiss-btn', '✕');
    dismissBtn.title = 'Dismiss';
    dismissBtn.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      dismissNotif(card, n && n.id);
    });
    head.appendChild(dismissBtn);
    card.appendChild(head);

    const bodyText = notifBody(n);
    if (bodyText) card.appendChild(el('div', 'notif-body clamp3', bodyText));

    const foot = el('div', 'row foot notif-foot');
    foot.appendChild(el('span', 'muted small', (n && n.author) || ''));
    foot.appendChild(el('span', 'spacer'));
    if (n && n.kind === 'comment' && n.key) {
      const reply = el('button', 'link-btn reply-btn', 'Reply');
      reply.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        openDrawer(n.key, true);
      });
      foot.appendChild(reply);
    }
    foot.appendChild((function () {
      const t = relTimeEl(n && n.date);
      t.classList.add('muted', 'small');
      return t;
    })());
    card.appendChild(foot);

    return card;
  }

  function dismissNotif(card, id) {
    if (!id || dismissing.has(id)) return;
    dismissing.add(id);
    card.style.height = card.scrollHeight + 'px';
    void card.offsetHeight; // flush so the height transition starts from the real value
    card.classList.add('dismissing');
    card.style.height = '0px';
    setTimeout(function () {
      dismissing.delete(id);
      wd.dismiss(id);
    }, 160);
  }

  // ---------- ticket quick-view drawer ----------

  const overlay = el('div', 'drawer-overlay hidden');
  const drawerBackdrop = el('div', 'drawer-backdrop');
  const drawerEl = el('div', 'drawer');
  overlay.appendChild(drawerBackdrop);
  overlay.appendChild(drawerEl);
  drawerBackdrop.addEventListener('click', function () { closeDrawer(); });
  document.body.appendChild(overlay);

  function openDrawer(key, focusReply) {
    if (!key) return;
    drawer = {
      key: String(key),
      detail: null,
      loading: true,
      error: null,
      posting: false,
      postError: null,
      pendingText: '',
      focusReply: !!focusReply,
    };
    overlay.classList.remove('hidden');
    void drawerEl.offsetHeight; // flush so the slide-in transition runs
    overlay.classList.add('open');
    renderDrawer();
    fetchDetail();
  }

  function closeDrawer() {
    drawer = null;
    overlay.classList.remove('open');
    overlay.classList.add('hidden');
    drawerEl.textContent = '';
  }

  function fetchDetail() {
    const key = drawer && drawer.key;
    if (!key) return;
    Promise.resolve(wd.ticketDetail(key)).then(function (d) {
      if (!drawer || drawer.key !== key) return; // drawer closed / reopened meanwhile
      drawer.detail = (d && typeof d === 'object') ? d : {};
      drawer.loading = false;
      drawer.error = null;
      renderDrawer();
    }).catch(function (e) {
      if (!drawer || drawer.key !== key) return;
      drawer.loading = false;
      drawer.error = errMsg(e);
      renderDrawer();
    });
  }

  function sendReply() {
    if (!drawer || drawer.posting) return;
    const text = String(drawer.pendingText || '').trim();
    if (!text) return;
    const key = drawer.key;
    drawer.posting = true;
    drawer.postError = null;
    renderDrawer();
    Promise.resolve(wd.postComment(key, text)).then(function () {
      if (!drawer || drawer.key !== key) return;
      drawer.posting = false;
      drawer.pendingText = ''; // success: clear the box...
      renderDrawer();
      fetchDetail(); // ...and re-fetch so the new comment shows up
    }).catch(function (e) {
      if (!drawer || drawer.key !== key) return;
      drawer.posting = false;
      drawer.postError = errMsg(e); // failure: inline error, text kept
      renderDrawer();
    });
  }

  function statusChipClass(detail) {
    const rank = categoryRank(detail);
    return 'chip ' + (rank === 2 ? 'status-done' : (rank === 1 ? 'status-indeterminate' : 'status-todo'));
  }

  function renderDrawer() {
    if (!drawer) return;
    drawerEl.textContent = '';

    const header = el('div', 'drawer-header');
    const keyEl = el('span', 'drawer-key mono', drawer.key);
    makeLink(keyEl, drawer.detail && drawer.detail.url, 'Open in Jira');
    header.appendChild(keyEl);
    if (drawer.detail) header.appendChild(el('span', statusChipClass(drawer.detail), drawer.detail.status || '—'));
    header.appendChild(el('span', 'spacer'));
    const closeBtn = el('button', 'icon-btn drawer-close', '✕');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', function () { closeDrawer(); });
    header.appendChild(closeBtn);
    drawerEl.appendChild(header);

    const bodyEl = el('div', 'drawer-body');
    if (drawer.loading) {
      bodyEl.appendChild(el('div', 'muted small drawer-loading', 'Loading…'));
    } else if (drawer.error) {
      bodyEl.appendChild(el('div', 'error-line', drawer.error));
      const retry = el('button', 'link-btn retry-btn', 'Retry');
      retry.addEventListener('click', function () {
        drawer.loading = true;
        drawer.error = null;
        renderDrawer();
        fetchDetail();
      });
      bodyEl.appendChild(retry);
    } else {
      const d = drawer.detail || {};
      const parts = [];
      if (d.type) parts.push(String(d.type));
      if (d.priority) parts.push(String(d.priority));
      if (d.reporter || d.assignee) parts.push((d.reporter || '?') + ' → ' + (d.assignee || '?'));
      const rel = relTime(d.updated);
      if (rel) parts.push(rel);
      if (parts.length) bodyEl.appendChild(el('div', 'drawer-meta', parts.join(' · ')));

      bodyEl.appendChild(el('div', 'drawer-heading', 'Description'));
      bodyEl.appendChild(el('div', 'pre-line drawer-desc' + (d.description ? '' : ' muted'), d.description || '(no description)'));

      const comments = Array.isArray(d.comments) ? d.comments : [];
      bodyEl.appendChild(el('div', 'drawer-heading', 'Comments (' + comments.length + ')'));
      if (!comments.length) bodyEl.appendChild(el('div', 'muted small', '(no comments yet)'));
      for (const c of comments) { // oldest → newest, newest lands at the bottom
        const box = el('div', 'drawer-comment');
        const chead = el('div', 'drawer-comment-head');
        chead.appendChild(el('span', 'drawer-comment-author', (c && c.author) || '?'));
        chead.appendChild(el('span', 'spacer'));
        const t = relTimeEl(c && c.date);
        t.classList.add('muted', 'small');
        chead.appendChild(t);
        box.appendChild(chead);
        box.appendChild(el('div', 'pre-line small', (c && c.text) || ''));
        bodyEl.appendChild(box);
      }
    }
    drawerEl.appendChild(bodyEl);

    const footer = el('div', 'drawer-footer');
    const ta = el('textarea', 'reply-box');
    ta.rows = 2;
    ta.placeholder = 'Reply…';
    ta.value = drawer.pendingText || '';
    ta.disabled = !!drawer.posting;
    ta.addEventListener('input', function () {
      drawer.pendingText = ta.value;
      ta.style.height = 'auto'; // grow from 2 up to ~5 rows
      ta.style.height = Math.min(ta.scrollHeight || 0, 100) + 'px';
    });
    footer.appendChild(ta);
    const actions = el('div', 'row tight');
    if (drawer.postError) actions.appendChild(el('span', 'error-line', drawer.postError));
    actions.appendChild(el('span', 'spacer'));
    const send = el('button', 'btn send-btn', 'Send');
    send.disabled = !!drawer.posting;
    send.addEventListener('click', sendReply);
    actions.appendChild(send);
    footer.appendChild(actions);
    drawerEl.appendChild(footer);

    if (drawer.focusReply) {
      try { ta.focus(); } catch (err) {}
      if (!drawer.loading) drawer.focusReply = false; // keep re-focusing until loaded
    }
    bodyEl.scrollTop = bodyEl.scrollHeight; // newest comment visible
  }

  // ---------- first-run setup wizard ----------

  const setupEl = $('setup');
  let wizard = null; // built once, kept alive so typed values survive re-renders

  function setupInput(parent, labelText, type, value, helpText, helpLink) {
    parent.appendChild(el('label', 'setup-label', labelText));
    const input = el('input', 'setup-input');
    input.type = type;
    input.value = value || '';
    parent.appendChild(input);
    if (helpText) {
      const help = el('div', 'setup-help');
      help.appendChild(el('span', null, helpText + ' '));
      if (helpLink) {
        const link = el('span', 'link', 'ouvrir');
        link.addEventListener('click', function () { wd.openExternal(helpLink); });
        help.appendChild(link);
      }
      parent.appendChild(help);
    }
    return input;
  }

  function ensureWizard() {
    if (wizard) return wizard;
    setupEl.textContent = '';
    setupEl.appendChild(el('div', 'setup-title', 'UlysesDock'));
    setupEl.appendChild(el('div', 'setup-subtitle', 'Configuration initiale'));
    const errLine = el('div', 'setup-error hidden');
    setupEl.appendChild(errLine);

    const email = setupInput(setupEl, 'Email Jira', 'text', '');
    const token = setupInput(
      setupEl, 'Token API Jira', 'password', '',
      "Crée ton token sur id.atlassian.com → Sécurité → Jetons d'API",
      'https://id.atlassian.com/manage-profile/security/api-tokens'
    );

    const advanced = el('details', 'setup-advanced');
    advanced.appendChild(el('summary', null, 'Avancé'));
    const baseUrl = setupInput(advanced, 'URL Jira', 'text', 'https://tesipro.atlassian.net');
    const workspace = setupInput(advanced, 'Workspace Bitbucket', 'text', 'pmsweb');
    const repos = setupInput(advanced, 'Repos', 'text', 'backend, frontend');
    const bbToken = setupInput(
      advanced, 'Token Bitbucket (optionnel)', 'password', '',
      'Laisse vide : détecté automatiquement via Git'
    );
    setupEl.appendChild(advanced);

    const status = el('div', 'setup-status');
    setupEl.appendChild(status);
    const submit = el('button', 'btn setup-submit', 'Valider et démarrer');
    submit.addEventListener('click', submitSetup);
    setupEl.appendChild(submit);

    wizard = {
      errLine: errLine, email: email, token: token, baseUrl: baseUrl,
      workspace: workspace, repos: repos, bbToken: bbToken, status: status, submit: submit,
    };
    return wizard;
  }

  function serviceLine(name, result) {
    if (!result) return null;
    return result.ok
      ? el('div', 'status-ok', '✓ ' + name + ' : connecté en tant que ' + (result.displayName || '?'))
      : el('div', 'status-fail', '✗ ' + name + ' : ' + (result.error || 'échec'));
  }

  function submitSetup() {
    const w = ensureWizard();
    if (w.submit.disabled) return;
    w.submit.disabled = true;
    w.status.textContent = '';
    const payload = {
      jiraEmail: String(w.email.value || '').trim(),
      jiraToken: String(w.token.value || '').trim(),
      jiraBaseUrl: String(w.baseUrl.value || '').trim(),
      workspace: String(w.workspace.value || '').trim(),
      repos: String(w.repos.value || '').split(',').map(function (r) { return r.trim(); }).filter(Boolean),
      bbToken: String(w.bbToken.value || '').trim(),
    };
    Promise.resolve(wd.setupSave(payload)).then(function (res) {
      w.submit.disabled = false;
      w.status.textContent = '';
      const r = (res && typeof res === 'object') ? res : {};
      const jira = serviceLine('Jira', r.jira);
      const bitbucket = serviceLine('Bitbucket', r.bitbucket);
      if (jira) w.status.appendChild(jira);
      if (bitbucket) w.status.appendChild(bitbucket);
      // On ok:true, main pushes a needsSetup:false snapshot; applySnapshot
      // tears the wizard down when it arrives. Form values are kept.
    }).catch(function (e) {
      w.submit.disabled = false;
      w.status.textContent = '';
      w.status.appendChild(el('div', 'status-fail', '✗ ' + errMsg(e)));
    });
  }

  function updateSetupMode(s) {
    const needsSetup = !!(s && s.needsSetup);
    body.classList.toggle('setup-mode', needsSetup);
    if (!needsSetup) return false;
    const w = ensureWizard();
    const setupError = s.setupError ? String(s.setupError) : '';
    w.errLine.textContent = setupError;
    w.errLine.classList.toggle('hidden', !setupError);
    return true;
  }

  // ---------- Today tab ----------

  function enCoursTickets() {
    const tickets = Array.isArray(snap.tickets) ? snap.tickets : [];
    return tickets.filter(function (t) {
      return /en cours|in progress/i.test(String((t && t.status) || ''));
    });
  }

  function awaitingPRs() {
    const prs = Array.isArray(snap.prs) ? snap.prs : [];
    return prs.filter(isAwaitingMe).slice().sort(function (a, b) {
      const ta = parseTs(a && a.lastHumanComment && a.lastHumanComment.date) || 0;
      const tb = parseTs(b && b.lastHumanComment && b.lastHumanComment.date) || 0;
      return tb - ta;
    });
  }

  function recentNotifs() {
    return (Array.isArray(snap.notifications) ? snap.notifications : []).slice(0, 5);
  }

  function commitGroups(data) {
    const commits = (data && Array.isArray(data.commits)) ? data.commits : [];
    const map = new Map();
    const order = [];
    for (const c of commits) {
      const keys = (c && Array.isArray(c.tickets) && c.tickets.length) ? c.tickets : [null];
      for (const k of keys) {
        const id = k || '';
        if (!map.has(id)) {
          map.set(id, { key: k || null, commits: [] });
          order.push(id);
        }
        map.get(id).commits.push(c);
      }
    }
    const groups = order.filter(function (id) { return id !== ''; }).map(function (id) { return map.get(id); });
    if (map.has('')) groups.push(map.get('')); // "divers" last
    return groups;
  }

  function standupText() {
    const data = standup.data || {};
    const lines = [(data.sinceLabel || 'Hier') + ':'];
    for (const g of commitGroups(data)) {
      for (const c of g.commits) {
        lines.push('- ' + (g.key ? g.key + ': ' : '') + ((c && c.subject) || '') + ' (' + ((c && c.repo) || '?') + ')');
      }
    }
    lines.push("Aujourd'hui:");
    for (const t of enCoursTickets()) {
      lines.push('- ' + ((t && t.key) || '—') + ': ' + ((t && t.summary) || ''));
    }
    return lines.join('\n');
  }

  function fetchStandup() {
    if (standup.loading) return;
    standup.loading = true;
    standup.error = null;
    refreshToday();
    Promise.resolve(wd.getStandup()).then(function (d) {
      standup.loading = false;
      standup.data = (d && typeof d === 'object') ? d : { commits: [] };
      standup.fetchedAt = Date.now();
      refreshToday();
    }).catch(function (e) {
      standup.loading = false;
      standup.error = errMsg(e);
      refreshToday();
    });
  }

  function refreshToday() {
    fingerprints.today = tabFingerprint('today');
    renderToday();
  }

  function todayKeyLink(key) {
    const node = el('span', 'ticket-key mono link', key || '—');
    if (key) node.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      openDrawer(key);
    });
    return node;
  }

  function renderToday() {
    const panel = scrolls.today;
    const st = panel.scrollTop || 0;
    panel.textContent = '';

    // -- PRs à traiter --
    const phead = el('div', 'section-head');
    phead.appendChild(el('span', 'section-title', 'PRs à traiter'));
    panel.appendChild(phead);
    const awaiting = awaitingPRs();
    if (!awaiting.length) {
      panel.appendChild(el('div', 'muted small', "Aucune PR n'attend ta réponse ✨"));
    }
    for (const pr of awaiting) {
      const row = el('div', 'pr-review-row');
      row.appendChild(el('span', 'dot dot-danger'));
      const title = el('span', 'pr-review-title', (pr && pr.title) || '(untitled PR)');
      makeLink(title, pr && pr.url, (pr && pr.title) || '');
      row.appendChild(title);
      const repo = (pr && pr.repo) || '';
      row.appendChild(el('span', 'chip ' + repoChipClass(repo), repo || 'repo'));
      const lhc = pr && pr.lastHumanComment;
      if (lhc) {
        const meta = el('span', 'pr-review-meta');
        meta.appendChild(el('span', null, '💬 ' + (lhc.author || '?') + ' · '));
        meta.appendChild(relTimeEl(lhc.date));
        row.appendChild(meta);
      }
      panel.appendChild(row);
    }

    // -- Mon récap --
    const head = el('div', 'section-head');
    head.appendChild(el('span', 'section-title', 'Mon récap'));
    head.appendChild(el('span', 'spacer'));
    const copyBtn = el('button', 'link-btn copy-btn', 'Copier');
    copyBtn.addEventListener('click', function () {
      wd.copyText(standupText());
      copyBtn.textContent = 'Copié ✓';
      setTimeout(function () { copyBtn.textContent = 'Copier'; }, 1500);
    });
    head.appendChild(copyBtn);
    panel.appendChild(head);
    panel.appendChild(el('div', 'section-sub', "Tes commits d'hier et tes tickets en cours — le bouton Copier te fait le message pour le daily."));

    const data = standup.data;
    panel.appendChild(el('div', 'group-header', ((data && data.sinceLabel) || 'Hier') + ' — mes commits'));
    if (standup.loading && !data) {
      panel.appendChild(el('div', 'muted small', 'Loading…'));
    } else if (standup.error && !data) {
      panel.appendChild(el('div', 'error-line', standup.error));
      const retry = el('button', 'link-btn', 'Retry');
      retry.addEventListener('click', fetchStandup);
      panel.appendChild(retry);
    } else {
      const groups = commitGroups(data);
      if (!groups.length) panel.appendChild(el('div', 'muted small', 'Aucun commit'));
      for (const g of groups) {
        const wrap = el('div', 'standup-ticket');
        wrap.appendChild(g.key ? todayKeyLink(g.key) : el('span', 'ticket-key mono muted', 'divers'));
        for (const c of g.commits) {
          const line = el('div', 'commit-line', ((c && c.repo) || '?') + ' · ' + ((c && c.subject) || ''));
          line.title = ((c && c.repo) || '?') + ' · ' + ((c && c.subject) || '');
          wrap.appendChild(line);
        }
        panel.appendChild(wrap);
      }
    }

    panel.appendChild(el('div', 'group-header', "Aujourd'hui — en cours"));
    const current = enCoursTickets();
    if (!current.length) panel.appendChild(el('div', 'muted small', 'Rien en cours'));
    for (const t of current) {
      const line = el('div', 'today-ticket-line');
      line.appendChild(todayKeyLink(t && t.key));
      line.appendChild(el('span', 'today-summary', (t && t.summary) || ''));
      panel.appendChild(line);
    }

    // -- Dernière activité --
    const ahead = el('div', 'section-head');
    ahead.appendChild(el('span', 'section-title', 'Dernière activité'));
    panel.appendChild(ahead);
    const notifs = recentNotifs();
    if (!notifs.length) panel.appendChild(el('div', 'muted small', 'Rien de neuf'));
    for (const n of notifs) {
      const row = el('div', 'activity-row');
      row.appendChild(el('span', 'kind-icon', notifIcon(n)));
      const title = el('span', 'activity-title', (n && (n.title || n.key)) || '');
      makeLink(title, n && n.url);
      row.appendChild(title);
      const t = relTimeEl(n && n.date);
      t.classList.add('muted', 'small');
      row.appendChild(t);
      panel.appendChild(row);
    }
    panel.scrollTop = st;
  }

  // ---------- panel renderers ----------

  function renderPRs() {
    const bar = filterEls.prs;
    const scroll = scrolls.prs;
    const st = scroll.scrollTop || 0;
    bar.textContent = '';
    scroll.textContent = '';

    const prs = Array.isArray(snap.prs) ? snap.prs : [];
    if (!prs.length) {
      bar.classList.add('hidden');
      scroll.appendChild(el('div', 'empty', 'No open PRs 🎉'));
      return;
    }

    bar.classList.remove('hidden');
    const defs = PR_FILTERS.map(function (f) {
      return { id: f.id, label: f.label, count: safeFilter(prs, f.test).length };
    });
    bar.appendChild(chipRow(defs, filters.prs, function (id) { setFilter('prs', id); }));

    const active = PR_FILTERS.find(function (f) { return f.id === filters.prs; }) || PR_FILTERS[0];
    const visible = safeFilter(prs, active.test); // keeps delivered order (created DESC)
    if (!visible.length) {
      scroll.appendChild(el('div', 'empty', 'Nothing matches this filter'));
    } else {
      for (const pr of visible) scroll.appendChild(prCard(pr));
    }
    scroll.scrollTop = st;
  }

  function renderTickets() {
    const bar = filterEls.tickets;
    const scroll = scrolls.tickets;
    const st = scroll.scrollTop || 0;
    bar.textContent = '';
    scroll.textContent = '';

    const tickets = Array.isArray(snap.tickets) ? snap.tickets : [];
    if (!tickets.length) {
      bar.classList.add('hidden');
      scroll.appendChild(el('div', 'empty', 'Nothing assigned'));
      return;
    }
    bar.classList.remove('hidden');

    // Project segmented control, derived from key prefixes.
    const projectCounts = new Map();
    for (const t of tickets) {
      const p = projectOf(t);
      projectCounts.set(p, (projectCounts.get(p) || 0) + 1);
    }
    const projects = Array.from(projectCounts.keys()).sort(function (a, b) { return a.localeCompare(b); });
    const activeProject = (filters.ticketsProject !== 'all' && projectCounts.has(filters.ticketsProject))
      ? filters.ticketsProject
      : 'all'; // stored project may no longer exist

    const segmented = el('div', 'segmented');
    const segDefs = [{ id: 'all', label: 'All', count: tickets.length }].concat(
      projects.map(function (p) { return { id: p, label: p, count: projectCounts.get(p) }; })
    );
    for (const def of segDefs) {
      const seg = el('button', 'seg' + (def.id === activeProject ? ' active' : ''));
      seg.appendChild(el('span', null, def.label));
      seg.appendChild(el('span', 'seg-count', def.count));
      seg.addEventListener('click', function () { setFilter('ticketsProject', def.id); });
      segmented.appendChild(seg);
    }

    // Everything below the segmented control is scoped to the active project.
    const scoped = activeProject === 'all'
      ? tickets
      : tickets.filter(function (t) { return projectOf(t) === activeProject; });

    // Group by status name; groups ordered by category then alphabetically,
    // tickets inside a group keep their delivered order (updated DESC).
    const groups = new Map();
    for (const t of scoped) {
      const name = String((t && t.status) || 'Unknown');
      let group = groups.get(name);
      if (!group) {
        group = { name: name, rank: categoryRank(t), items: [] };
        groups.set(name, group);
      }
      group.items.push(t);
    }
    const ordered = Array.from(groups.values()).sort(function (a, b) {
      return (a.rank - b.rank) || a.name.localeCompare(b.name);
    });

    const defs = [{ id: 'all', label: 'All', count: scoped.length }].concat(
      ordered.map(function (g) { return { id: 'status:' + g.name, label: g.name, count: g.items.length }; })
    );
    bar.appendChild(segmented);
    bar.appendChild(chipRow(defs, filters.tickets, function (id) { setFilter('tickets', id); }));

    // The status selection persists across project switches; a combo with no
    // matches shows the empty state (click All to reset).
    const shown = filters.tickets === 'all'
      ? ordered
      : ordered.filter(function (g) { return 'status:' + g.name === filters.tickets; });
    if (!shown.length) {
      scroll.appendChild(el('div', 'empty', 'Nothing matches this filter'));
    } else {
      for (const group of shown) {
        scroll.appendChild(el('div', 'group-header', group.name + ' (' + group.items.length + ')'));
        for (const t of group.items) scroll.appendChild(ticketCard(t));
      }
    }
    scroll.scrollTop = st;
  }

  function renderNotifs() {
    const scroll = scrolls.notifs;
    const st = scroll.scrollTop || 0;
    scroll.textContent = '';
    const list = Array.isArray(snap.notifications) ? snap.notifications : [];
    notifTools.classList.toggle('hidden', list.length === 0);
    if (!list.length) {
      scroll.appendChild(el('div', 'empty', 'All caught up ✨'));
      return;
    }
    for (const n of list) scroll.appendChild(notifCard(n));
    scroll.scrollTop = st;
  }

  const RENDER = { today: renderToday, prs: renderPRs, tickets: renderTickets, notifs: renderNotifs };

  // ---------- snapshot handling ----------

  function fingerprint(value) {
    try { return JSON.stringify(value); } catch (err) { return String(Date.now()); }
  }

  function tabFingerprint(name) {
    if (name === 'today') {
      return fingerprint({
        standup: standup.data,
        loading: standup.loading,
        error: standup.error,
        awaiting: awaitingPRs(),
        current: enCoursTickets(),
        recent: recentNotifs(),
      });
    }
    const data = name === 'prs' ? snap.prs : (name === 'tickets' ? snap.tickets : snap.notifications);
    const filter = name === 'tickets'
      ? (filters.ticketsProject || '') + '/' + (filters.tickets || '')
      : (filters[name] || '');
    return filter + '|' + fingerprint(data || []);
  }

  function updateBadge(node, count) {
    node.textContent = count > 99 ? '99+' : String(count);
    node.classList.toggle('show', count > 0);
  }

  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return;
    snap = s;

    syncLabel.textContent = s.lastSync ? ('sync ' + clockTime(s.lastSync)) : 'sync —';
    refreshBtn.classList.toggle('spinning', !!s.polling);

    const unread = Number(s.unread) || 0;
    updateBadge(tabBadge, unread);
    updateBadge(railBadge, unread);

    const errors = (Array.isArray(s.errors) ? s.errors : []).filter(Boolean).map(String);
    errorStrip.classList.toggle('hidden', errors.length === 0);
    if (errors.length) {
      errorText.textContent = errors.length > 1
        ? errors[0] + ' (+' + (errors.length - 1) + ' more)'
        : errors[0];
      errorStrip.title = errors.join('\n');
    } else {
      errorStrip.title = '';
    }

    // Setup mode replaces the whole tab UI; skip panel work while active.
    // The transition back (needsSetup -> false) falls through to a normal
    // render pass, so the regular UI reappears with fresh data.
    if (updateSetupMode(s)) return;

    // Re-render a tab only when its data (or its filter) actually changed —
    // keeps scroll position on identical snapshots.
    for (const name of ['today', 'prs', 'tickets', 'notifs']) {
      const fresh = tabFingerprint(name);
      if (fresh !== fingerprints[name]) {
        fingerprints[name] = fresh;
        RENDER[name]();
      }
    }

    // Standup: first fetch when Today is in view; then refresh with snapshot
    // pushes at most once per STANDUP_TTL.
    if (activeTab === 'today' && !standup.fetchedAt && !standup.loading) {
      fetchStandup();
    } else if (standup.fetchedAt && !standup.loading && (Date.now() - standup.fetchedAt) >= STANDUP_TTL) {
      fetchStandup();
    }
  }

  // ---------- tabs ----------

  function setTab(name) {
    activeTab = name;
    for (const key of Object.keys(tabs)) {
      tabs[key].classList.toggle('active', key === name);
      panels[key].classList.toggle('active', key === name);
    }
    if (name === 'today' && !standup.fetchedAt && !standup.loading) fetchStandup();
  }

  for (const name of Object.keys(tabs)) {
    tabs[name].addEventListener('click', function () { setTab(name); });
  }

  // ---------- collapse / expand ----------

  function setCollapsed(collapsed) {
    body.classList.toggle('collapsed', collapsed);
    wd.setCollapsed(collapsed);
  }

  collapseBtn.addEventListener('click', function () { setCollapsed(true); });
  expandBtn.addEventListener('click', function () { setCollapsed(false); });
  document.addEventListener('keydown', function (e) {
    if (!e || e.key !== 'Escape') return;
    if (drawer) { closeDrawer(); return; } // drawer closes first...
    if (!body.classList.contains('collapsed')) setCollapsed(true); // ...then the panel
  });

  // ---------- top bar actions ----------

  refreshBtn.addEventListener('click', function () { wd.refresh(); });
  quitBtn.addEventListener('click', function () { wd.quit(); });
  clearAllBtn.addEventListener('click', function () { wd.dismissAll(); });

  // ---------- boot ----------

  // Main persists the collapse state and sizes the window before load:
  // a narrow window means we booted collapsed.
  if (window.innerWidth < 100) body.classList.add('collapsed');

  wd.onSnapshot(applySnapshot);
  Promise.resolve(wd.getSnapshot()).then(applySnapshot).catch(noop);

  setInterval(function () {
    const nodes = document.querySelectorAll('.reltime');
    for (const node of nodes) node.textContent = relTime(node.dataset.ts);
  }, 60000);
})();
