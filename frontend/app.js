// dP Checklisten – Single-Page-App ohne Build
(() => {
  const STORAGE_KEY  = 'dp-checklists.sessions.v1';
  const THEME_KEY    = 'dp-checklists.theme';
  const clone        = (x) => JSON.parse(JSON.stringify(x));

  // Server-loaded templates, keyed by id. Filled by loadTemplatesFromApi() during boot.
  let CHECKLISTS = {};
  // Track which templates are "system" (seeded) vs. user-created. System templates can
  // only be edited by admin; non-system templates can be deleted by any editor.
  const SYSTEM_IDS = new Set();

  const isBaseType = (type) => SYSTEM_IDS.has(type);

  async function loadTemplatesFromApi() {
    const list = await API.get('/api/templates');
    const map = {};
    SYSTEM_IDS.clear();
    for (const t of list) {
      map[t.id] = {
        id: t.id, title: t.title, subtitle: t.subtitle || '', tag: t.tag || '',
        meta: t.meta || [], sections: t.sections || [],
      };
      if (t.isSystem) SYSTEM_IDS.add(t.id);
    }
    CHECKLISTS = map;
  }

  // Debounced per-template save → PUT /api/templates/:id
  const tplSaveTimers = new Map();
  function persistTemplate(id) {
    const tpl = CHECKLISTS[id];
    if (!tpl) return;
    if (tplSaveTimers.has(id)) clearTimeout(tplSaveTimers.get(id));
    const timer = setTimeout(async () => {
      tplSaveTimers.delete(id);
      try {
        await API.put('/api/templates/' + encodeURIComponent(id), {
          id, title: tpl.title || '', subtitle: tpl.subtitle || null,
          tag: tpl.tag || null, meta: tpl.meta || [], sections: tpl.sections || [],
        });
      } catch (e) {
        console.error('Template-Speichern fehlgeschlagen:', e);
        if (e.status === 403) alert('Diese Vorlage kannst du nicht ändern (nur Admin/Editor).');
      }
    }, 400);
    tplSaveTimers.set(id, timer);
  }

  // Wrapper: kept for compatibility with editor code paths
  function saveTemplates(tpls) { CHECKLISTS = tpls; }

  async function deleteTemplate(type) {
    try {
      await API.del('/api/templates/' + encodeURIComponent(type));
      delete CHECKLISTS[type];
      SYSTEM_IDS.delete(type);
      return true;
    } catch (e) {
      alert('Vorlage konnte nicht gelöscht werden: ' + (e.message || e));
      return false;
    }
  }

  async function createTemplate() {
    const id = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const tpl = {
      id,
      title: 'Neue Checkliste',
      subtitle: '',
      tag: 'Eigene',
      meta: [
        { name: 'kunde', label: 'Kunde', type: 'text', required: true },
        { name: 'datum', label: 'Datum', type: 'date', required: true },
      ],
      sections: [
        { title: 'Abschnitt 1', items: [] },
      ],
    };
    try {
      await API.put('/api/templates/' + encodeURIComponent(id), {
        id, title: tpl.title, subtitle: tpl.subtitle, tag: tpl.tag,
        meta: tpl.meta, sections: tpl.sections,
      });
      CHECKLISTS[id] = tpl;
      return id;
    } catch (e) {
      alert('Neue Vorlage konnte nicht angelegt werden: ' + (e.message || e));
      return null;
    }
  }

  const view        = document.getElementById('view');
  const crumbsEl    = document.getElementById('crumbs');
  const topActions  = document.getElementById('topActions');

  let state = { route: 'start', sessionId: null, saving: false, user: null };
  let saveTimer = null;

  // ----- Theme
  const initTheme = () => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) document.documentElement.dataset.theme = saved;
  };
  const toggleTheme = () => {
    const current = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = current;
    localStorage.setItem(THEME_KEY, current);
    render();
  };

  // ----- Storage (API-backed)
  // Convert backend session shape to the legacy in-memory shape used by render code.
  function normalizeSession(api) {
    const byItem = {};
    for (const a of (api.attachments || [])) {
      (byItem[a.itemId] = byItem[a.itemId] || []).push({
        id: a.id, name: a.fileName, url: a.url, addedAt: a.createdAt,
      });
    }
    return {
      id: api.id,
      type: api.templateId,           // legacy alias
      templateId: api.templateId,
      templateSnapshot: api.templateSnapshot,
      createdBy: api.createdBy,
      createdAt: api.createdAt,
      updatedAt: api.updatedAt,
      closedAt: api.closedAt,
      meta: api.meta || {},
      values: api.values || {},
      skipped: api.skipped || {},     // { [itemId]: 'reason text' }
      attachments: byItem,
    };
  }

  let _sessionsList = null;  // cached list result for the start screen
  async function loadSessions() {
    if (_sessionsList) return _sessionsList;
    const arr = await API.get('/api/sessions');
    _sessionsList = arr.map(normalizeSession);
    return _sessionsList;
  }
  function invalidateSessionsList() { _sessionsList = null; }

  // In-memory map for sessions opened in the current page – avoids refetch when navigating
  const _sessionMap = new Map();
  async function getSession(id) {
    if (_sessionMap.has(id)) return _sessionMap.get(id);
    const api = await API.get('/api/sessions/' + encodeURIComponent(id));
    const s = normalizeSession(api);
    _sessionMap.set(id, s);
    return s;
  }

  async function createSession(type) {
    const api = await API.post('/api/sessions', { templateId: type });
    const s = normalizeSession(api);
    _sessionMap.set(s.id, s);
    invalidateSessionsList();
    return s;
  }

  async function deleteSession(id) {
    await API.del('/api/sessions/' + encodeURIComponent(id));
    _sessionMap.delete(id);
    invalidateSessionsList();
  }

  // Legacy alias kept so existing code paths still compile – we no longer use it for storage.
  function upsertSession(_session) { /* no-op: scheduleSave handles persistence */ }

  // ----- Routing
  window.addEventListener('hashchange', parseRoute);
  function parseRoute() {
    const keep = { user: state.user, appVersion: state.appVersion };
    const hash = location.hash.replace(/^#\/?/, '');
    if (!hash || hash === 'start') {
      state = { route: 'start', ...keep };
    } else if (hash === 'saved') {
      state = { route: 'saved', ...keep };
    } else if (hash.startsWith('new/')) {
      const type = hash.slice(4);
      if (CHECKLISTS[type]) {
        (async () => {
          try {
            const s = await createSession(type);
            location.hash = '#/sess/' + s.id;
          } catch (e) {
            alert('Sitzung konnte nicht angelegt werden: ' + (e.message || e));
            location.hash = '#/';
          }
        })();
        return;
      }
      state = { route: 'start', ...keep };
    } else if (hash.startsWith('sess/')) {
      state = { route: 'sess', sessionId: hash.slice(5), ...keep };
    } else if (hash === 'editor') {
      state = { route: 'editor', ...keep };
    } else if (hash.startsWith('editor/')) {
      const type = hash.slice(7);
      if (CHECKLISTS[type]) state = { route: 'editTpl', type, ...keep };
      else state = { route: 'editor', ...keep };
    } else if (hash === 'users') {
      state = { route: 'users', ...keep };
    } else {
      state = { route: 'start', ...keep };
    }
    render();
  }

  // ----- Render entry
  function render() {
    view.innerHTML = '';
    crumbsEl.innerHTML = '';
    topActions.innerHTML = '';
    // Topbar-Version aktualisieren (kommt aus boot)
    const vt = document.getElementById('versionTag');
    if (vt) vt.textContent = state.appVersion ? 'v' + state.appVersion : '';

    // Login screen takes precedence over routes
    if (!state.user) return renderLogin();

    // Theme toggle + user pill always visible
    topActions.appendChild(iconBtn(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon',
      'Theme umschalten', toggleTheme));
    topActions.prepend(renderUserPill());

    if (state.route === 'start')   return renderStart();
    if (state.route === 'saved')   return renderSaved();
    if (state.route === 'sess')    return renderSession();
    if (state.route === 'editor')  return renderEditorPicker();
    if (state.route === 'editTpl') return renderTemplateEditor(state.type);
    if (state.route === 'users')   return renderUsers();
  }

  function renderUserPill() {
    const pill = el('div', 'user-pill');
    const role = state.user.role || '';
    pill.innerHTML = `
      <div class="user-pill-info">
        <span class="user-pill-name">${escapeHtml(state.user.displayName || state.user.username)}</span>
        <span class="user-pill-role" data-role="${escapeHtml(role)}">${escapeHtml(role)}</span>
      </div>
    `;
    const logout = el('button', 'btn ghost icon', svgIcon('logout'));
    logout.title = 'Abmelden';
    logout.addEventListener('click', async () => {
      try { await API.auth.logout(); } catch {}
      state.user = null;
      render();
    });
    pill.appendChild(logout);
    return pill;
  }

  function renderLogin() {
    crumb('Anmeldung');
    const card = el('div', 'login-card');
    card.innerHTML = `
      <div class="login-head">
        <div class="login-logo">dP</div>
        <h1>Checklisten</h1>
        <p>Melde dich mit deinem Benutzerkonto an.</p>
      </div>
      <form class="login-form" autocomplete="on">
        <div class="field">
          <label for="login-user">Benutzername</label>
          <input type="text" id="login-user" name="username" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="login-pass">Passwort</label>
          <input type="password" id="login-pass" name="password" autocomplete="current-password" required />
        </div>
        <div class="login-error" hidden></div>
        <button type="submit" class="btn primary login-submit">Anmelden</button>
      </form>
      <div class="login-footer">${state.appVersion ? 'Version ' + escapeHtml(state.appVersion) : ''}</div>
    `;
    view.appendChild(card);
    const form = card.querySelector('form');
    const errEl = card.querySelector('.login-error');
    const btn = card.querySelector('.login-submit');
    form.querySelector('[name=username]').focus();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      errEl.hidden = true;
      btn.disabled = true; btn.textContent = 'Anmelden…';
      try {
        const user = await API.auth.login(
          form.querySelector('[name=username]').value.trim(),
          form.querySelector('[name=password]').value,
        );
        state.user = user;
        try { await loadTemplatesFromApi(); } catch (e) { console.error(e); }
        render();
      } catch (e) {
        errEl.textContent = e.status === 401
          ? 'Benutzername oder Passwort falsch.'
          : (e.message || 'Anmeldung fehlgeschlagen.');
        errEl.hidden = false;
        btn.disabled = false; btn.textContent = 'Anmelden';
      }
    });
  }

  // ----- Start screen
  function renderStart() {
    crumb('Start');
    if (state.user?.role === 'Admin') {
      topActions.prepend(actionBtn('Benutzer', () => { location.hash = '#/users'; }, 'users'));
    }
    if (state.user?.role === 'Admin' || state.user?.role === 'Editor') {
      topActions.prepend(actionBtn('Vorlagen bearbeiten', () => { location.hash = '#/editor'; }, 'edit'));
    }

    const hero = el('div', 'hero', `
      <h1>Checklisten · dP-elektronik</h1>
      <p>Wähle eine Vorlage und arbeite sie digital ab. Eingaben werden automatisch auf dem Server gespeichert.</p>
    `);
    view.appendChild(hero);

    // Tiles
    const tiles = el('div', 'tiles');
    Object.keys(CHECKLISTS).forEach(type => {
      const cl = CHECKLISTS[type];
      const itemCount = cl.sections.reduce((s, sec) => s + sec.items.length, 0);
      const tag = cl.tag || (isBaseType(type) ? '' : 'Eigene');
      const tile = el('button', 'tile', `
        ${tag ? `<span class="tag">${escapeHtml(tag)}</span>` : ''}
        <h3>${escapeHtml(cl.title)}</h3>
        <p>${escapeHtml(cl.subtitle || '')}</p>
        <div class="meta">
          <span>${cl.sections.length} Abschnitte</span>
          <span>·</span>
          <span>${itemCount} Punkte</span>
        </div>
      `);
      tile.addEventListener('click', () => { location.hash = '#/new/' + type; });
      tiles.appendChild(tile);
    });
    view.appendChild(tiles);

    // Recent sessions (lazy)
    const card = el('div', 'card');
    card.appendChild(el('div', '', `<h2>Zuletzt bearbeitet</h2><p class="sub">${state.user?.role === 'Admin' ? 'Alle Sitzungen aller Benutzer.' : 'Deine letzten Sitzungen.'}</p>`));
    const listSlot = el('div', '');
    listSlot.appendChild(el('div', 'empty', 'Lade Sitzungen…'));
    card.appendChild(listSlot);
    view.appendChild(card);

    (async () => {
      try {
        const sessions = await loadSessions();
        listSlot.innerHTML = '';
        if (sessions.length === 0) {
          listSlot.appendChild(el('div', 'empty', 'Noch keine Sitzungen. Starte oben eine neue Checkliste.'));
          return;
        }
        const list = el('div', 'sessions');
        sessions.slice(0, 8).forEach(s => list.appendChild(sessionRow(s, { withDelete: true })));
        listSlot.appendChild(list);
        if (sessions.length > 8) {
          const more = el('button', 'btn ghost', `Alle ${sessions.length} Sitzungen anzeigen →`);
          more.style.marginTop = '12px';
          more.addEventListener('click', () => { location.hash = '#/saved'; });
          listSlot.appendChild(more);
        }
      } catch (e) {
        listSlot.innerHTML = `<div class="empty">Sitzungen konnten nicht geladen werden: ${escapeHtml(e.message || String(e))}</div>`;
      }
    })();
  }

  function renderSaved() {
    crumb('<a href="#/">Start</a>', 'Alle Sitzungen');
    topActions.prepend(actionBtn('Zurück', () => { location.hash = '#/'; }));

    const card = el('div', 'card');
    const header = el('div', '', `<h2>Gespeicherte Sitzungen</h2><p class="sub">Lade…</p>`);
    card.appendChild(header);
    const listSlot = el('div', '');
    listSlot.appendChild(el('div', 'empty', 'Lade Sitzungen…'));
    card.appendChild(listSlot);
    view.appendChild(card);

    (async () => {
      try {
        const sessions = await loadSessions();
        header.innerHTML = `<h2>Gespeicherte Sitzungen</h2><p class="sub">${sessions.length} insgesamt.</p>`;
        listSlot.innerHTML = '';
        if (sessions.length === 0) {
          listSlot.appendChild(el('div', 'empty', 'Noch keine Sitzungen.'));
          return;
        }
        const list = el('div', 'sessions');
        sessions.forEach(s => list.appendChild(sessionRow(s, { withDelete: true })));
        listSlot.appendChild(list);
      } catch (e) {
        listSlot.innerHTML = `<div class="empty">Sitzungen konnten nicht geladen werden: ${escapeHtml(e.message || String(e))}</div>`;
      }
    })();
  }

  function sessionRow(s, opts = {}) {
    const cl = templateForSession(s) || { title: '(Vorlage gelöscht)' };
    const progress = calcProgress(s);
    const row = el('div', 'session-row');
    row.innerHTML = `
      <div>
        <div class="who">${escapeHtml(s.meta.kunde || '— ohne Kundenname —')}</div>
        <div class="when">${escapeHtml(cl.title)} · zuletzt ${formatDate(s.updatedAt)}</div>
      </div>
      <div class="progress" title="${progress.done} / ${progress.total} Punkte"><div style="width:${progress.percent}%"></div></div>
      <div style="display:flex;gap:8px;align-items:center;">
        <span class="badge">${progress.percent}%</span>
      </div>
    `;
    row.addEventListener('click', () => { location.hash = '#/sess/' + s.id; });
    if (opts.withDelete) {
      const del = el('button', 'btn ghost danger icon', svgIcon('trash'));
      del.title = 'Sitzung löschen';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (confirm(`Sitzung „${s.meta.kunde || cl.title}" wirklich löschen?`)) {
          try { await deleteSession(s.id); render(); }
          catch (e) { alert('Löschen fehlgeschlagen: ' + (e.message || e)); }
        }
      });
      row.lastElementChild.appendChild(del);
    }
    return row;
  }

  // Resolve template (live → fallback to session snapshot if missing)
  function templateForSession(session) {
    return CHECKLISTS[session.templateId] || session.templateSnapshot || null;
  }

  // ----- Session view
  function renderSession() {
    // Render a placeholder card while the session loads
    view.innerHTML = `<div class="card"><p style="color:var(--text-muted)">Sitzung wird geladen…</p></div>`;
    (async () => {
      let session;
      try { session = await getSession(state.sessionId); }
      catch (e) {
        view.innerHTML = `<div class="card"><p>Sitzung nicht gefunden${e.status === 403 ? ' oder kein Zugriff' : ''}.</p>
          <button class="btn ghost" onclick="location.hash='#/'">← Zurück</button></div>`;
        return;
      }
      _renderSessionWith(session);
    })();
  }

  function _renderSessionWith(session) {
    const cl = templateForSession(session);
    if (!cl) {
      view.innerHTML = `<div class="card"><p>Vorlage nicht verfügbar.</p></div>`;
      return;
    }
    view.innerHTML = '';
    crumbsEl.innerHTML = '';
    topActions.innerHTML = '';
    // Re-add user pill + theme button
    topActions.appendChild(iconBtn(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon',
      'Theme umschalten', toggleTheme));
    topActions.prepend(renderUserPill());

    crumb(`<a href="#/">Start</a>`, `<strong>${escapeHtml(session.meta.kunde || cl.title)}</strong>`);

    const canDelete = state.user?.role === 'Admin' || state.user?.id === session.createdBy;
    topActions.prepend(
      actionBtn('Drucken', () => window.print(), 'print'),
      actionBtn('Export', () => exportSession(session), 'download'),
      ...(canDelete ? [
        (() => {
          const b = actionBtn('Sitzung löschen', async () => {
            const label = session.meta?.kunde || cl.title;
            if (!confirm(`Sitzung „${label}" wirklich löschen?\n\nAlle Eingaben und Anhänge gehen verloren.`)) return;
            try { await deleteSession(session.id); location.hash = '#/'; }
            catch (e) { alert('Löschen fehlgeschlagen: ' + (e.message || e)); }
          }, 'trash');
          b.classList.add('danger');
          return b;
        })(),
      ] : []),
      actionBtn('Zurück', () => { location.hash = '#/'; }, 'arrow-left'),
    );

    // Hero
    const hero = el('div', 'hero');
    hero.innerHTML = `<h1>${escapeHtml(cl.title)}</h1><p>${escapeHtml(cl.subtitle)}</p>`;
    view.appendChild(hero);

    // Meta card
    const metaCard = el('div', 'card');
    metaCard.appendChild(el('div', '', `<h2>Eckdaten</h2><p class="sub">Basis-Informationen für diese Sitzung.</p>`));
    const metaGrid = el('div', 'field-grid');
    cl.meta.forEach(m => metaGrid.appendChild(metaField(session, m)));
    metaCard.appendChild(metaGrid);
    view.appendChild(metaCard);

    // Sections
    cl.sections.forEach((sec, i) => {
      const card = el('div', 'card');
      const counts = sectionCounts(session, sec);
      const headRow = el('div', 'section-h');
      headRow.innerHTML = `<span class="num">${i + 1}</span><h2>${escapeHtml(sec.title)}</h2><span class="count">${counts.done}/${counts.total}</span>`;
      card.appendChild(headRow);

      const body = el('div', 'checklist');
      sec.items.forEach(item => body.appendChild(renderItem(session, item)));
      card.appendChild(body);
      view.appendChild(card);
    });

    // Status bar
    const progress = calcProgress(session);
    const bar = el('div', 'statusbar');
    bar.innerHTML = `
      <span class="progress-text">${progress.done} / ${progress.total} erledigt</span>
      <div class="progress-track"><div class="progress-bar" style="width:${progress.percent}%"></div></div>
      <span class="progress-text"><strong>${progress.percent}%</strong></span>
      <span class="saved ${state.saving ? 'is-saving' : ''}" id="savedIndicator">
        <span class="dot"></span>${state.saving ? 'speichere…' : 'gespeichert'}
      </span>
    `;
    view.appendChild(bar);
  }

  // ----- Editor: picker
  function renderEditorPicker() {
    crumb('<a href="#/">Start</a>', 'Vorlagen bearbeiten');
    topActions.prepend(
      actionBtn('Importieren', importTemplates, 'upload'),
      actionBtn('data.js exportieren', exportAllTemplates, 'download'),
      actionBtn('Neue Checkliste', async () => {
        const id = await createTemplate();
        if (id) location.hash = '#/editor/' + id;
      }, 'plus'),
      actionBtn('Zurück', () => { location.hash = '#/'; }, 'arrow-left'),
    );

    const hero = el('div', 'hero', `
      <h1>Vorlagen verwalten</h1>
      <p>Bestehende Vorlagen bearbeiten oder eigene neu anlegen. Änderungen wirken sofort und werden in diesem Browser gespeichert. Für alle Techniker: per „data.js exportieren" die Datei herunterladen und im Verzeichnis ersetzen.</p>
    `);
    view.appendChild(hero);

    const tiles = el('div', 'tiles');
    Object.keys(CHECKLISTS).forEach(type => {
      const cl = CHECKLISTS[type];
      const userMade = !isBaseType(type);
      const badge = userMade ? 'Eigene' : 'Standard';
      const badgeStyle = userMade ? 'background:#0c2a28;color:var(--brand-200);' : '';
      const tile = el('button', 'tile');
      tile.innerHTML = `
        <span class="tag" style="${badgeStyle}">${badge}</span>
        <h3>${escapeHtml(cl.title)}</h3>
        <p>${escapeHtml(cl.subtitle || '')}</p>
        <div class="meta">
          <span>${cl.sections.length} Abschnitte</span>
          <span>·</span>
          <span>${cl.sections.reduce((s, sec) => s + sec.items.length, 0)} Punkte</span>
        </div>
      `;
      tile.addEventListener('click', () => { location.hash = '#/editor/' + type; });
      tiles.appendChild(tile);
    });
    view.appendChild(tiles);

    const card = el('div', 'card');
    card.appendChild(el('div', '', `<h2>Hinweise</h2>`));
    card.appendChild(el('div', '', `
      <ul style="margin:0;padding-left:18px;color:var(--text-muted);font-size:14px;line-height:1.7">
        <li>Vorlagen liegen auf dem Server. Änderungen sind sofort für alle sichtbar, die Zugriff haben.</li>
        <li>Bestehende Sitzungen behalten ihre Werte – sie nutzen einen Schnappschuss der Vorlage zum Zeitpunkt der Sitzungs-Erstellung.</li>
        <li>Eigene Vorlagen können hier gelöscht werden. Standard-Vorlagen (vom System ausgeliefert) lassen sich bearbeiten, aber nicht löschen.</li>
      </ul>
    `));
    view.appendChild(card);
  }

  // ----- Editor: template editor
  function renderTemplateEditor(type) {
    const cl = CHECKLISTS[type];
    crumb('<a href="#/">Start</a>', '<a href="#/editor">Vorlagen</a>', `<strong>${escapeHtml(cl.title)}</strong>`);
    const userMade = !isBaseType(type);
    if (userMade) {
      topActions.prepend(
        actionBtn('Vorlage löschen', async () => {
          if (confirm(`Eigene Vorlage „${cl.title}" wirklich endgültig löschen?\n\nDas entfernt sie aus der Auswahl, bereits damit ausgefüllte Sitzungen bleiben aber bestehen.`)) {
            if (await deleteTemplate(type)) location.hash = '#/editor';
          }
        }, 'trash'),
        actionBtn('Zurück', () => { location.hash = '#/editor'; }, 'arrow-left'),
      );
    } else {
      topActions.prepend(
        actionBtn('Zurück', () => { location.hash = '#/editor'; }, 'arrow-left'),
      );
    }

    const persist = () => {
      CHECKLISTS[type] = cl;
      persistTemplate(type);
      flashSaved();
    };

    // ---- header card (title / subtitle / tag)
    const headCard = el('div', 'card');
    headCard.appendChild(el('div', '', `<h2>Kopf der Vorlage</h2><p class="sub">Wird auf der Startseite angezeigt.</p>`));
    const headGrid = el('div', 'field-grid');
    headGrid.appendChild(simpleInput('Titel', cl.title || '', v => { cl.title = v; persist(); updateEditorCrumb(cl); }));
    headGrid.appendChild(simpleInput('Untertitel', cl.subtitle || '', v => { cl.subtitle = v; persist(); }));
    headGrid.appendChild(simpleInput('Kategorie / Tag', cl.tag || '', v => { cl.tag = v || undefined; persist(); }));
    headCard.appendChild(headGrid);
    view.appendChild(headCard);

    // ---- meta fields
    const metaCard = el('div', 'card');
    metaCard.appendChild(el('div', '', `<h2>Eckdaten-Felder</h2><p class="sub">Die Pflichtdaten, die der Techniker pro Sitzung erfasst.</p>`));
    const metaList = el('div', 'edit-list');
    cl.meta.forEach((m, idx) => metaList.appendChild(metaFieldEditor(cl, m, idx, persist, () => render())));
    metaCard.appendChild(metaList);
    const addMeta = el('button', 'btn ghost', svgIcon('plus') + '<span>Eckdaten-Feld hinzufügen</span>');
    addMeta.style.marginTop = '12px';
    addMeta.addEventListener('click', () => {
      cl.meta.push({ name: 'feld_' + Date.now().toString(36), label: 'Neues Feld', type: 'text' });
      persist(); render();
    });
    metaCard.appendChild(addMeta);
    view.appendChild(metaCard);

    // ---- sections
    cl.sections.forEach((sec, sIdx) => {
      view.appendChild(sectionEditor(cl, sec, sIdx, persist, () => render()));
    });
    const addSec = el('button', 'btn primary', svgIcon('plus') + '<span>Abschnitt hinzufügen</span>');
    addSec.style.marginTop = '8px';
    addSec.addEventListener('click', () => {
      cl.sections.push({ title: 'Neuer Abschnitt', items: [] });
      persist(); render();
    });
    view.appendChild(addSec);
  }

  // ----- User management (Admin only)
  function renderUsers() {
    if (state.user?.role !== 'Admin') {
      view.innerHTML = `<div class="card"><p>Keine Berechtigung. Nur Administratoren dürfen Benutzer verwalten.</p></div>`;
      return;
    }
    crumb('<a href="#/">Start</a>', 'Benutzer');
    topActions.prepend(actionBtn('Zurück', () => { location.hash = '#/'; }, 'arrow-left'));

    const hero = el('div', 'hero');
    hero.innerHTML = `<h1>Benutzer-Verwaltung</h1><p>Konten anlegen, Rollen anpassen, deaktivieren oder löschen.</p>`;
    view.appendChild(hero);

    // ---- Update / Version card
    const updateCard = el('div', 'card update-card');
    updateCard.appendChild(el('div', '', `<h2>System-Update</h2><p class="sub">Aktuelle Version, Update-Anforderung an den Host.</p>`));
    const updateBody = el('div', 'update-body');
    updateBody.innerHTML = `<div class="empty">Lade Version-Info…</div>`;
    updateCard.appendChild(updateBody);
    view.appendChild(updateCard);
    renderUpdateInfo(updateBody);

    // Create-user card
    const createCard = el('div', 'card');
    createCard.appendChild(el('div', '', `<h2>Neuen Benutzer anlegen</h2><p class="sub">Initialpasswort dem Benutzer mitteilen – er sollte es danach selbst ändern.</p>`));
    const form = el('form', 'field-grid');
    form.innerHTML = `
      <div class="field"><label>Benutzername</label><input name="username" type="text" required /></div>
      <div class="field"><label>Anzeigename</label><input name="displayName" type="text" /></div>
      <div class="field"><label>Initialpasswort (≥6 Zeichen)</label><input name="password" type="text" required minlength="6" /></div>
      <div class="field"><label>Rolle</label>
        <select name="role">
          <option value="Techniker" selected>Techniker</option>
          <option value="Editor">Editor</option>
          <option value="Admin">Admin</option>
        </select>
      </div>
    `;
    const submit = el('button', 'btn primary', 'Anlegen');
    submit.type = 'submit';
    submit.style.gridColumn = '1 / -1';
    submit.style.justifySelf = 'start';
    form.appendChild(submit);
    createCard.appendChild(form);
    view.appendChild(createCard);

    // List card
    const listCard = el('div', 'card');
    listCard.appendChild(el('div', '', `<h2>Konten</h2><p class="sub">Lade…</p>`));
    const listSlot = el('div', 'user-list');
    listCard.appendChild(listSlot);
    view.appendChild(listCard);

    const reload = async () => {
      try {
        const users = await API.get('/api/users');
        listSlot.innerHTML = '';
        users.forEach(u => listSlot.appendChild(userRow(u, reload)));
      } catch (e) {
        listSlot.innerHTML = `<div class="empty">Fehler: ${escapeHtml(e.message || String(e))}</div>`;
      }
    };

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      submit.disabled = true; submit.textContent = 'Lege an…';
      try {
        await API.post('/api/users', data);
        form.reset();
        await reload();
      } catch (e) {
        alert('Anlegen fehlgeschlagen: ' + (e.body?.error || e.message || e));
      } finally {
        submit.disabled = false; submit.textContent = 'Anlegen';
      }
    });

    reload();
  }

  async function renderUpdateInfo(slot) {
    let info;
    try { info = await API.get('/api/admin/update-info'); }
    catch (e) {
      slot.innerHTML = `<div class="empty">Update-Info nicht abrufbar: ${escapeHtml(e.message || String(e))}</div>`;
      return;
    }
    const current = info.current || 'unbekannt';
    const available = info.available || null;
    const updateAvailable = !!info.updateAvailable;
    const requestedAt = info.requestedAt || null;

    const versionsHtml = `
      <div class="version-row">
        <div><span class="version-label">Aktuell</span><span class="version-value">${escapeHtml(current)}</span></div>
        <div><span class="version-label">Verfügbar</span><span class="version-value">${escapeHtml(available || '—')}</span></div>
      </div>`;

    const noUrl = !info.versionUrl;
    const noFlag = !info.flagFile;

    let actionHtml = '';
    if (noUrl && noFlag) {
      actionHtml = `<div class="empty" style="text-align:left">
        <strong>Update-Funktion nicht konfiguriert.</strong><br/>
        Setze die Umgebungsvariablen <code>UPDATE_VERSION_URL</code> (URL zu einer VERSION-Datei) und <code>Update__FlagFile</code> (Pfad im Container), damit der Button hier ein Update auslösen kann. Details siehe README.
      </div>`;
    } else if (requestedAt) {
      actionHtml = `<div class="update-banner">
        <strong>Update bereits angefordert</strong> am ${formatDate(requestedAt)}.
        Der Host-Watcher führt es beim nächsten Lauf aus.
      </div>
      <button class="btn ghost" id="reCheckBtn">Status erneut prüfen</button>`;
    } else if (updateAvailable) {
      actionHtml = `<div class="update-banner">
        <strong>Neue Version verfügbar:</strong> ${escapeHtml(available)} (aktuell ${escapeHtml(current)}).
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn primary" id="triggerBtn">Update jetzt anfordern</button>
        <button class="btn ghost" id="reCheckBtn">Erneut prüfen</button>
      </div>`;
    } else if (available) {
      actionHtml = `<div class="empty" style="text-align:left">Auf aktuellem Stand. Verfügbare Version (${escapeHtml(available)}) entspricht der laufenden.</div>
        <button class="btn ghost" id="reCheckBtn">Erneut prüfen</button>`;
    } else if (info.error) {
      actionHtml = `<div class="empty" style="text-align:left">Konnte verfügbare Version nicht abrufen: ${escapeHtml(info.error)}</div>
        <button class="btn ghost" id="reCheckBtn">Erneut prüfen</button>`;
    } else {
      actionHtml = `<div class="empty" style="text-align:left">Update-URL konfiguriert, aber keine Version geliefert.</div>
        <button class="btn ghost" id="reCheckBtn">Erneut prüfen</button>`;
    }

    slot.innerHTML = versionsHtml + actionHtml;
    slot.querySelector('#reCheckBtn')?.addEventListener('click', () => renderUpdateInfo(slot));
    slot.querySelector('#triggerBtn')?.addEventListener('click', async (ev) => {
      if (!confirm(`Update auf Version ${available} anfordern?\n\nDer Host-Watcher führt es beim nächsten Lauf aus. Bestehende Sitzungen werden vorher gesichert.`)) return;
      ev.target.disabled = true;
      ev.target.textContent = 'Sende…';
      try {
        await API.post('/api/admin/trigger-update', {});
        renderUpdateInfo(slot);
      } catch (e) {
        alert('Konnte Update nicht anfordern: ' + (e.body?.detail || e.message || e));
        renderUpdateInfo(slot);
      }
    });
  }

  function userRow(u, reload) {
    const row = el('div', 'user-row');
    const isSelf = state.user.id === u.id;
    row.innerHTML = `
      <div class="user-row-main">
        <div class="user-row-name">
          ${escapeHtml(u.displayName || u.username)}
          ${u.disabled ? '<span class="badge-disabled">deaktiviert</span>' : ''}
          ${isSelf ? '<span class="badge-self">du</span>' : ''}
        </div>
        <div class="user-row-sub">@${escapeHtml(u.username)} · angelegt ${formatDate(u.createdAt)}</div>
      </div>
      <div class="user-row-controls">
        <select class="user-role" ${isSelf ? 'disabled title="Eigene Rolle kann nicht geändert werden"' : ''}>
          ${['Techniker','Editor','Admin'].map(r => `<option ${u.role===r?'selected':''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="user-row-actions"></div>
    `;
    const acts = row.querySelector('.user-row-actions');

    // Role change
    row.querySelector('.user-role').addEventListener('change', async (ev) => {
      const newRole = ev.target.value;
      try {
        await API.patch('/api/users/' + u.id, { role: newRole });
        await reload();
      } catch (e) { alert('Rolle ändern fehlgeschlagen: ' + (e.body?.error || e.message)); ev.target.value = u.role; }
    });

    // Password reset
    const pwBtn = el('button', 'btn ghost icon', svgIcon('key'));
    pwBtn.title = 'Passwort zurücksetzen';
    pwBtn.addEventListener('click', async () => {
      const pw = prompt(`Neues Passwort für ${u.username} (≥6 Zeichen):`);
      if (!pw) return;
      if (pw.length < 6) { alert('Mindestens 6 Zeichen.'); return; }
      try { await API.patch('/api/users/' + u.id, { newPassword: pw }); alert(`Passwort für ${u.username} gesetzt.`); }
      catch (e) { alert('Fehler: ' + (e.body?.error || e.message)); }
    });
    acts.appendChild(pwBtn);

    // Disable/enable toggle
    if (!isSelf) {
      const toggleBtn = el('button', 'btn ghost icon', svgIcon('power'));
      toggleBtn.title = u.disabled ? 'Wieder aktivieren' : 'Deaktivieren';
      if (u.disabled) toggleBtn.style.color = 'var(--accent-600)';
      toggleBtn.addEventListener('click', async () => {
        try { await API.patch('/api/users/' + u.id, { disabled: !u.disabled }); await reload(); }
        catch (e) { alert('Fehler: ' + (e.body?.error || e.message)); }
      });
      acts.appendChild(toggleBtn);
    }

    // Delete
    if (!isSelf) {
      const delBtn = el('button', 'btn ghost icon danger', svgIcon('trash'));
      delBtn.title = 'Benutzer löschen';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Benutzer „${u.username}" wirklich löschen? Seine Sitzungen bleiben erhalten, sind aber dann nur noch über die Admin-Ansicht zugänglich.`)) return;
        try { await API.del('/api/users/' + u.id); await reload(); }
        catch (e) { alert('Fehler: ' + (e.body?.error || e.message)); }
      });
      acts.appendChild(delBtn);
    }
    return row;
  }

  function updateEditorCrumb(cl) {
    crumb('<a href="#/">Start</a>', '<a href="#/editor">Vorlagen</a>', `<strong>${escapeHtml(cl.title)}</strong>`);
  }

  function metaFieldEditor(cl, m, idx, persist, rerender) {
    const row = el('div', 'edit-row');
    row.innerHTML = `
      <div class="edit-row-head">
        <span class="edit-handle">${idx + 1}</span>
        <strong contenteditable="true" spellcheck="false" data-bind="label">${escapeHtml(m.label || '')}</strong>
        <span class="edit-row-spacer"></span>
      </div>
      <div class="edit-row-body">
        <div class="field"><label>Interner Name (ID)</label><input type="text" data-bind="name" value="${escapeHtml(m.name || '')}" /></div>
        <div class="field"><label>Typ</label>
          <select data-bind="type">
            ${['text','textarea','date','datetime-local'].map(t => `<option value="${t}" ${m.type===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Platzhalter</label><input type="text" data-bind="placeholder" value="${escapeHtml(m.placeholder || '')}" /></div>
        <label class="check-flag"><input type="checkbox" data-bind="required" ${m.required?'checked':''}/> Pflichtfeld</label>
      </div>
    `;
    // wire bindings
    row.querySelector('[data-bind="label"]').addEventListener('input', e => { m.label = e.target.textContent; persist(); });
    row.querySelector('[data-bind="name"]').addEventListener('input', e => { m.name = e.target.value; persist(); });
    row.querySelector('[data-bind="type"]').addEventListener('change', e => { m.type = e.target.value; persist(); });
    row.querySelector('[data-bind="placeholder"]').addEventListener('input', e => { m.placeholder = e.target.value || undefined; persist(); });
    row.querySelector('[data-bind="required"]').addEventListener('change', e => { m.required = e.target.checked || undefined; persist(); });
    // actions
    const acts = el('div', 'edit-actions');
    acts.appendChild(rowAction('up',   () => { if (idx > 0) { [cl.meta[idx-1], cl.meta[idx]] = [cl.meta[idx], cl.meta[idx-1]]; persist(); rerender(); } }));
    acts.appendChild(rowAction('down', () => { if (idx < cl.meta.length - 1) { [cl.meta[idx+1], cl.meta[idx]] = [cl.meta[idx], cl.meta[idx+1]]; persist(); rerender(); } }));
    acts.appendChild(rowAction('trash',() => { if (confirm(`Feld „${m.label}" löschen?`)) { cl.meta.splice(idx,1); persist(); rerender(); } }, true));
    row.querySelector('.edit-row-spacer').replaceWith(acts);
    return row;
  }

  function sectionEditor(cl, sec, sIdx, persist, rerender) {
    const card = el('div', 'card');
    const head = el('div', 'section-h');
    head.innerHTML = `<span class="num">${sIdx + 1}</span>`;
    const titleInput = el('input', '');
    titleInput.type = 'text';
    titleInput.value = sec.title;
    titleInput.className = 'section-title-input';
    titleInput.addEventListener('input', () => { sec.title = titleInput.value; persist(); });
    head.appendChild(titleInput);
    const spacer = el('span', ''); spacer.style.flex = '1'; head.appendChild(spacer);
    head.appendChild(rowAction('up',    () => { if (sIdx > 0) { [cl.sections[sIdx-1], cl.sections[sIdx]] = [cl.sections[sIdx], cl.sections[sIdx-1]]; persist(); rerender(); } }));
    head.appendChild(rowAction('down',  () => { if (sIdx < cl.sections.length - 1) { [cl.sections[sIdx+1], cl.sections[sIdx]] = [cl.sections[sIdx], cl.sections[sIdx+1]]; persist(); rerender(); } }));
    head.appendChild(rowAction('trash', () => { if (confirm(`Abschnitt „${sec.title}" inkl. ${sec.items.length} Punkten löschen?`)) { cl.sections.splice(sIdx,1); persist(); rerender(); } }, true));
    card.appendChild(head);

    const list = el('div', 'edit-list');
    sec.items.forEach((it, iIdx) => list.appendChild(itemEditor(sec, it, iIdx, persist, rerender)));
    card.appendChild(list);

    const addBar = el('div', 'add-bar');
    const addType = el('select', '');
    // value = "<type>|<attach?>" – attach is empty | optional | required
    const groups = [
      { label: 'Häkchen',     options: [
        { v: 'check',           label: 'Ohne Bild' },
        { v: 'check|optional',  label: '+ Bild als Nachweis (optional)' },
        { v: 'check|required',  label: '+ Bild als Nachweis (Pflicht)' },
      ]},
      { label: 'Hinweis-Text',options: [
        { v: 'info',            label: 'Ohne Bild' },
        { v: 'info|optional',   label: '+ Bild als Nachweis (optional)' },
        { v: 'info|required',   label: '+ Bild als Nachweis (Pflicht)' },
      ]},
      { label: 'Eingabe',     options: [
        { v: 'text',            label: 'Freitext' },
        { v: 'text|optional',   label: 'Freitext + Bild (optional)' },
        { v: 'text|required',   label: 'Freitext + Bild (Pflicht)' },
        { v: 'textarea',        label: 'Mehrzeilig' },
        { v: 'textarea|optional', label: 'Mehrzeilig + Bild (optional)' },
        { v: 'textarea|required', label: 'Mehrzeilig + Bild (Pflicht)' },
        { v: 'date',            label: 'Datum' },
        { v: 'datetime-local',  label: 'Datum + Uhrzeit' },
      ]},
      { label: 'Auswahl',     options: [
        { v: 'select',          label: 'Einfachauswahl' },
        { v: 'multiselect',     label: 'Mehrfachauswahl' },
      ]},
    ];
    groups.forEach(g => {
      const og = document.createElement('optgroup');
      og.label = g.label;
      g.options.forEach(({ v, label }) => {
        const o = document.createElement('option'); o.value = v; o.textContent = label; og.appendChild(o);
      });
      addType.appendChild(og);
    });
    addBar.appendChild(addType);
    const addBtn = el('button', 'btn ghost', svgIcon('plus') + '<span>Punkt hinzufügen</span>');
    addBtn.addEventListener('click', () => {
      const [t, attach] = addType.value.split('|');
      const id = 'new_' + Date.now().toString(36);
      const base = { id, type: t };
      if (t === 'check')                Object.assign(base, { text: 'Neuer Punkt' });
      else if (t === 'info')            Object.assign(base, { label: 'Hinweis', text: '' });
      else if (t === 'select' || t === 'multiselect') Object.assign(base, { label: 'Auswahl', options: [] });
      else                              Object.assign(base, { label: 'Neues Feld' });
      if (attach) base.attach = attach;
      sec.items.push(base);
      persist(); rerender();
    });
    addBar.appendChild(addBtn);
    card.appendChild(addBar);

    return card;
  }

  function itemEditor(sec, it, iIdx, persist, rerender) {
    const row = el('div', 'edit-row');
    const titleText = it.type === 'check' ? (it.text || '') : (it.label || '');
    row.innerHTML = `
      <div class="edit-row-head">
        <span class="edit-handle">${iIdx + 1}</span>
        <span class="type-pill">${it.type}</span>
        <strong contenteditable="true" spellcheck="false" data-bind="title">${escapeHtml(titleText)}</strong>
        <span class="edit-row-spacer"></span>
      </div>
    `;
    row.querySelector('[data-bind="title"]').addEventListener('input', e => {
      const v = e.target.textContent;
      if (it.type === 'check') it.text = v; else it.label = v;
      persist();
    });
    // body depends on type
    const body = el('div', 'edit-row-body');
    const attachSelect = () => selectField('Bild-Upload', it.attach || '', [
      { value: '',         label: 'Kein Upload' },
      { value: 'optional', label: 'Optional anhängbar' },
      { value: 'required', label: 'Erforderlich (mind. 1 Bild)' },
    ], v => { it.attach = v || undefined; persist(); });
    if (it.type === 'check') {
      body.appendChild(textareaField('Hinweis (optional)', it.note || '', v => { it.note = v || undefined; persist(); }));
      body.appendChild(attachSelect());
    } else if (it.type === 'info') {
      body.appendChild(textareaField('Info-Text', it.text || '', v => { it.text = v; persist(); }));
      body.appendChild(attachSelect());
    } else if (it.type === 'select' || it.type === 'multiselect') {
      body.appendChild(textareaField('Optionen (eine pro Zeile)', (it.options || []).join('\n'),
        v => { it.options = v.split('\n').map(s => s.trim()).filter(Boolean); persist(); }));
    } else if (it.type === 'text' || it.type === 'textarea') {
      body.appendChild(simpleInput('Platzhalter', it.placeholder || '', v => { it.placeholder = v || undefined; persist(); }));
      body.appendChild(attachSelect());
    }
    // ID field on all
    const idGrid = el('div', 'field-grid');
    idGrid.appendChild(simpleInput('Interne ID', it.id || '', v => { it.id = v; persist(); }));
    body.appendChild(idGrid);
    row.appendChild(body);

    const acts = el('div', 'edit-actions');
    acts.appendChild(rowAction('up',    () => { if (iIdx > 0) { [sec.items[iIdx-1], sec.items[iIdx]] = [sec.items[iIdx], sec.items[iIdx-1]]; persist(); rerender(); } }));
    acts.appendChild(rowAction('down',  () => { if (iIdx < sec.items.length - 1) { [sec.items[iIdx+1], sec.items[iIdx]] = [sec.items[iIdx], sec.items[iIdx+1]]; persist(); rerender(); } }));
    acts.appendChild(rowAction('trash', () => { if (confirm('Diesen Punkt löschen?')) { sec.items.splice(iIdx,1); persist(); rerender(); } }, true));
    row.querySelector('.edit-row-spacer').replaceWith(acts);
    return row;
  }

  function simpleInput(label, value, onChange) {
    const wrap = el('div', 'field');
    wrap.innerHTML = `<label>${escapeHtml(label)}</label>`;
    const i = el('input', ''); i.type = 'text'; i.value = value;
    i.addEventListener('input', () => onChange(i.value));
    wrap.appendChild(i); return wrap;
  }
  function selectField(label, value, options, onChange) {
    const wrap = el('div', 'field');
    wrap.innerHTML = `<label>${escapeHtml(label)}</label>`;
    const s = el('select', '');
    s.innerHTML = options.map(o => `<option value="${escapeHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    s.addEventListener('change', () => onChange(s.value));
    wrap.appendChild(s); return wrap;
  }
  function textareaField(label, value, onChange) {
    const wrap = el('div', 'field');
    wrap.innerHTML = `<label>${escapeHtml(label)}</label>`;
    const t = el('textarea', ''); t.value = value;
    t.addEventListener('input', () => onChange(t.value));
    wrap.appendChild(t); return wrap;
  }
  function rowAction(icon, onClick, danger) {
    const b = el('button', 'btn ghost icon' + (danger ? ' danger' : ''), svgIcon(icon));
    b.addEventListener('click', onClick);
    return b;
  }

  let flashTimer = null;
  function flashSaved() {
    const t = document.querySelector('.topbar .logo');
    if (!t) return;
    t.style.color = 'var(--brand-500)';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { t.style.color = ''; }, 400);
  }

  // ---- Export / Import data.js
  function exportAllTemplates() {
    const body = `// dP Checklisten – Vorlagen\n// Exportiert: ${new Date().toLocaleString('de-DE')}\n\nwindow.CHECKLISTS = ${JSON.stringify(CHECKLISTS, null, 2)};\n`;
    const blob = new Blob([body], { type: 'text/javascript;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'data.js';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function importTemplates() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.js,.json,application/json,text/javascript';
    inp.addEventListener('change', () => {
      const file = inp.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        let parsed = null;
        const text = String(reader.result || '');
        try {
          // Either JSON or a data.js with window.CHECKLISTS = {...}
          if (text.trim().startsWith('{')) parsed = JSON.parse(text);
          else {
            const m = text.match(/window\.CHECKLISTS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
            if (m) parsed = JSON.parse(m[1]);
          }
        } catch (err) {
          alert('Datei konnte nicht gelesen werden: ' + err.message);
          return;
        }
        if (!parsed) { alert('Konnte keine Vorlagen-Daten in der Datei finden.'); return; }
        if (!confirm(`${Object.keys(parsed).length} Vorlage(n) aus der Datei übernehmen? Vorhandene Vorlagen mit gleicher ID werden überschrieben.`)) return;
        try {
          for (const key of Object.keys(parsed)) {
            const t = parsed[key];
            await API.put('/api/templates/' + encodeURIComponent(key), {
              id: key, title: t.title || key, subtitle: t.subtitle || null, tag: t.tag || null,
              meta: t.meta || [], sections: t.sections || [],
            });
          }
          await loadTemplatesFromApi();
          render();
        } catch (e) {
          alert('Import fehlgeschlagen: ' + (e.message || e));
        }
      };
      reader.readAsText(file);
    });
    inp.click();
  }

  // ----- Meta field
  function metaField(session, m) {
    const id = 'meta_' + m.name;
    const wrap = el('div', 'field');
    wrap.innerHTML = `<label for="${id}">${escapeHtml(m.label)}${m.required ? ' *' : ''}</label>`;
    const input = el(m.type === 'textarea' ? 'textarea' : 'input', '');
    if (m.type !== 'textarea') input.type = m.type;
    input.id = id;
    input.value = session.meta[m.name] || '';
    if (m.placeholder) input.placeholder = m.placeholder;
    input.addEventListener('input', () => {
      session.meta[m.name] = input.value;
      scheduleSave(session);
      if (m.name === 'kunde') updateCrumbs(session);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function updateCrumbs(session) {
    const cl = templateForSession(session) || { title: '', sections: [] };
    crumb(`<a href="#/">Start</a>`, `<strong>${escapeHtml(session.meta.kunde || cl.title)}</strong>`);
  }

  // ----- Item rendering
  function renderItem(session, item) {
    if (item.type === 'check')       return renderCheck(session, item);
    if (item.type === 'info')        return renderInfo(session, item);
    if (item.type === 'text')        return renderTextField(session, item);
    if (item.type === 'textarea')    return renderTextarea(session, item);
    if (item.type === 'date')        return renderDate(session, item, 'date');
    if (item.type === 'datetime-local') return renderDate(session, item, 'datetime-local');
    if (item.type === 'select')      return renderSelect(session, item);
    if (item.type === 'multiselect') return renderMultiselect(session, item);
    return el('div', '', '');
  }

  function renderCheck(session, item) {
    const skipped = isItemSkipped(session, item);
    const checked = !!session.values[item.id];
    const imgs = (session.attachments && session.attachments[item.id]) || [];
    const needsImg = item.attach === 'required' && imgs.length === 0;
    const isDone = !skipped && checked && !needsImg;
    const cls = 'check-item'
      + (isDone ? ' done' : '')
      + (skipped ? ' skipped' : '')
      + (needsImg && checked && !skipped ? ' attention' : '');
    const row = el('div', cls);
    const skipReason = skipped ? session.skipped[item.id] : '';
    row.innerHTML = `
      <div class="check-box">${svgIcon('check')}</div>
      <div class="check-body">
        <div class="check-text">${escapeHtml(item.text)}</div>
        ${item.note ? `<div class="check-note">${escapeHtml(item.note)}</div>` : ''}
        ${skipped ? `<div class="skip-note">↷ Übersprungen: ${escapeHtml(skipReason)}</div>` : ''}
        ${item.attach && !skipped ? `<div class="attach-zone" data-item="${escapeHtml(item.id)}"></div>` : ''}
      </div>
      <button type="button" class="skip-btn no-print" title="${skipped ? 'Übersprungen rückgängig machen' : 'Mit Begründung überspringen'}">
        ${svgIcon('skip')}
      </button>
    `;
    // Click on row toggles done (not on attach zone, not on skip button)
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.attach-zone')) return;
      if (ev.target.closest('.skip-btn')) return;
      if (skipped) return; // ignore body clicks while skipped
      session.values[item.id] = !session.values[item.id];
      scheduleSave(session);
      const replacement = renderCheck(session, item);
      row.replaceWith(replacement);
      refreshProgress(session);
    });
    // Skip button
    row.querySelector('.skip-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleSkip(session, item, () => {
        const replacement = renderCheck(session, item);
        row.replaceWith(replacement);
        refreshProgress(session);
      });
    });
    if (item.attach && !skipped) {
      const zone = row.querySelector('.attach-zone');
      zone.appendChild(renderAttach(session, item, () => {
        const newRow = renderCheck(session, item);
        row.replaceWith(newRow);
        refreshProgress(session);
      }));
    }
    return row;
  }

  function renderAttach(session, item, onChange) {
    const wrap = el('div', 'attach');
    const imgs = (session.attachments && session.attachments[item.id]) || [];
    const headLabel = item.attach === 'required'
      ? `<span class="attach-label required">Bild als Nachweis erforderlich</span>`
      : `<span class="attach-label">Bild als Nachweis (optional)</span>`;
    const counter = imgs.length ? `<span class="attach-count">${imgs.length} Bild${imgs.length === 1 ? '' : 'er'}</span>` : '';
    wrap.innerHTML = `<div class="attach-head">${headLabel}${counter}</div><div class="attach-grid"></div>`;
    const grid = wrap.querySelector('.attach-grid');
    imgs.forEach((img, i) => grid.appendChild(thumb(session, item, img, i, onChange)));

    // After-add helper: compress + upload as multipart, then attach into local model
    const handleFile = async (file) => {
      try {
        const blob = await compressImage(file);
        const fd = new FormData();
        fd.append('file', blob, file.name || 'bild.jpg');
        fd.append('itemId', item.id);
        const att = await API.upload('/api/sessions/' + encodeURIComponent(session.id) + '/attachments', fd);
        if (!session.attachments) session.attachments = {};
        if (!session.attachments[item.id]) session.attachments[item.id] = [];
        session.attachments[item.id].push({ id: att.id, name: att.fileName, url: att.url, addedAt: att.createdAt });
      } catch (e) {
        alert(`„${file.name || 'Bild'}" konnte nicht hochgeladen werden: ${e.message}`);
      }
    };
    const finalize = () => {
      invalidateSessionsList();
      if (onChange) onChange();
    };

    // 3 add-actions inside the dropzone
    const add = el('div', 'attach-add');
    add.innerHTML = `
      <button type="button" class="attach-act" data-act="file">${svgIcon('image')}<span>Datei wählen</span></button>
      <button type="button" class="attach-act" data-act="paste">${svgIcon('clipboard')}<span>Aus Zwischenablage</span></button>
      <button type="button" class="attach-act" data-act="capture">${svgIcon('camera')}<span>Bildschirm aufnehmen</span></button>
      <div class="attach-hint">Du kannst auch Dateien hierher ziehen oder mit Strg+V einfügen.</div>
    `;
    grid.appendChild(add);

    // hidden file input
    const fileInput = el('input', '');
    fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      for (const f of files) await handleFile(f);
      finalize();
    });
    add.appendChild(fileInput);

    add.querySelector('[data-act="file"]').addEventListener('click', () => fileInput.click());

    add.querySelector('[data-act="paste"]').addEventListener('click', async () => {
      try {
        const file = await pasteImageFromClipboard();
        await handleFile(file);
        finalize();
      } catch (e) {
        alert(e.message);
      }
    });

    add.querySelector('[data-act="capture"]').addEventListener('click', async () => {
      try {
        const file = await captureScreenshot();
        await handleFile(file);
        finalize();
      } catch (e) {
        if (e.name !== 'NotAllowedError') alert(e.message || 'Aufnahme abgebrochen.');
      }
    });

    // Drag & drop on the whole zone
    add.addEventListener('dragover', (e) => { e.preventDefault(); add.classList.add('drag'); });
    add.addEventListener('dragleave', () => add.classList.remove('drag'));
    add.addEventListener('drop', async (e) => {
      e.preventDefault(); add.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
      for (const f of files) await handleFile(f);
      finalize();
    });

    // Paste directly on the zone (focus + Strg+V)
    add.tabIndex = 0;
    add.addEventListener('paste', async (e) => {
      const items = Array.from(e.clipboardData?.items || []).filter(i => i.type.startsWith('image/'));
      if (!items.length) return;
      e.preventDefault();
      for (const it of items) {
        const blob = it.getAsFile();
        if (blob) await handleFile(blob);
      }
      finalize();
    });

    return wrap;
  }

  async function pasteImageFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      throw new Error('Zwischenablage-API in diesem Browser nicht verfügbar. Tipp: in den Bereich klicken und Strg+V drücken.');
    }
    let items;
    try { items = await navigator.clipboard.read(); }
    catch (e) { throw new Error('Zugriff auf Zwischenablage verweigert. Tipp: in den Bereich klicken und Strg+V drücken.'); }
    for (const item of items) {
      for (const t of item.types) {
        if (t.startsWith('image/')) {
          const blob = await item.getType(t);
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          return new File([blob], `zwischenablage-${ts}.png`, { type: blob.type });
        }
      }
    }
    throw new Error('Keine Bilddaten in der Zwischenablage. Zuerst mit Win+Umschalt+S oder Druck-Taste einen Screenshot machen.');
  }

  async function captureScreenshot() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Bildschirmaufnahme wird vom Browser nicht unterstützt (HTTPS oder localhost nötig).');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise(r => setTimeout(r, 150)); // first frame
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;
    canvas.getContext('2d').drawImage(video, 0, 0);
    stream.getTracks().forEach(t => t.stop());
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return new File([blob], `bildschirm-${ts}.png`, { type: 'image/png' });
  }

  function thumb(session, item, img, idx, onChange) {
    const src = img.url || img.dataUrl; // API uses url; dataUrl was the legacy local format
    const t = el('div', 'thumb');
    t.innerHTML = `
      <img src="${src}" alt="${escapeHtml(img.name)}" />
      <div class="thumb-actions no-print">
        <button class="btn ghost icon" title="Öffnen" data-act="open">${svgIcon('expand')}</button>
        <button class="btn ghost icon danger" title="Entfernen" data-act="del">${svgIcon('trash')}</button>
      </div>
      <div class="thumb-name">${escapeHtml(img.name)}</div>
    `;
    t.querySelector('[data-act="open"]').addEventListener('click', () => {
      window.open(src, '_blank');
    });
    t.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Bild „${img.name}" entfernen?`)) return;
      try {
        if (img.id) await API.del('/api/sessions/' + encodeURIComponent(session.id) + '/attachments/' + img.id);
      } catch (e) {
        alert('Bild konnte nicht entfernt werden: ' + (e.message || e));
        return;
      }
      session.attachments[item.id].splice(idx, 1);
      if (session.attachments[item.id].length === 0) delete session.attachments[item.id];
      invalidateSessionsList();
      if (onChange) onChange();
    });
    return t;
  }

  // Resize down to max 1600px on the long side, JPEG q=0.82, return a Blob (multipart-ready).
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Datei nicht lesbar'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
        img.onload = () => {
          try {
            const MAX = 1600;
            let { width, height } = img;
            const scale = Math.min(1, MAX / Math.max(width, height));
            width = Math.round(width * scale);
            height = Math.round(height * scale);
            const cv = document.createElement('canvas');
            cv.width = width; cv.height = height;
            cv.getContext('2d').drawImage(img, 0, 0, width, height);
            cv.toBlob(b => b ? resolve(b) : reject(new Error('Canvas konnte kein Bild erzeugen')),
                      'image/jpeg', 0.82);
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Helper that wraps a non-check field with a skip-able header (label + skip-button)
  // and shows the skip-note instead of the input when skipped.
  function fieldShell(session, item, kind, buildInput) {
    const skipped = isItemSkipped(session, item);
    const wrap = el('div', 'field' + (skipped ? ' is-skipped' : ''));
    const head = el('div', 'field-head');
    head.innerHTML = `<label>${escapeHtml(item.label)}</label>`;
    head.appendChild(skipButton(session, item, () => {
      const fresh = kind === 'text'        ? renderTextField(session, item)
                  : kind === 'textarea'    ? renderTextarea(session, item)
                  : kind === 'date'        ? renderDate(session, item, 'date')
                  : kind === 'datetimelocal' ? renderDate(session, item, 'datetime-local')
                  : kind === 'select'      ? renderSelect(session, item)
                  : kind === 'multiselect' ? renderMultiselect(session, item)
                  : wrap;
      wrap.replaceWith(fresh);
      refreshProgress(session);
    }));
    wrap.appendChild(head);
    if (skipped) {
      wrap.appendChild(skipNote(session, item));
    } else {
      buildInput(wrap);
      if (item.attach) {
        const zone = el('div', 'attach-zone');
        zone.appendChild(renderAttach(session, item, () => {
          const fresh = kind === 'text'        ? renderTextField(session, item)
                      : kind === 'textarea'    ? renderTextarea(session, item)
                      : kind === 'select'      ? renderSelect(session, item)
                      : kind === 'multiselect' ? renderMultiselect(session, item)
                      : wrap;
          wrap.replaceWith(fresh);
          refreshProgress(session);
        }));
        wrap.appendChild(zone);
      }
    }
    return wrap;
  }

  function renderInfo(session, item) {
    const skipped = isItemSkipped(session, item);
    const imgs = (session.attachments && session.attachments[item.id]) || [];
    const needsImg = !skipped && item.attach === 'required' && imgs.length === 0;
    const wrap = el('div', 'info-block' + (needsImg ? ' attention' : '') + (skipped ? ' is-skipped' : ''));
    wrap.innerHTML = `
      <div class="info-head">
        <div class="info-label">${escapeHtml(item.label)}</div>
        <span class="info-skip-slot"></span>
      </div>
      <div class="info-text">${escapeHtml(item.text)}</div>
      ${item.attach && !skipped ? `<div class="attach-zone" data-item="${escapeHtml(item.id)}"></div>` : ''}
    `;
    const rerender = () => {
      const fresh = renderInfo(session, item);
      wrap.replaceWith(fresh);
      refreshProgress(session);
    };
    // Skip button only appears on info items that actually contribute to progress (attach=required)
    if (item.attach === 'required') {
      wrap.querySelector('.info-skip-slot').replaceWith(skipButton(session, item, rerender));
    } else {
      wrap.querySelector('.info-skip-slot').remove();
    }
    if (skipped) wrap.appendChild(skipNote(session, item));
    if (item.attach && !skipped) {
      wrap.querySelector('.attach-zone').appendChild(renderAttach(session, item, rerender));
    }
    return wrap;
  }

  function renderTextField(session, item) {
    return fieldShell(session, item, 'text', (wrap) => {
      const input = el('input', ''); input.type = 'text'; input.id = 'i_' + item.id;
      input.value = session.values[item.id] || '';
      input.addEventListener('input', () => { session.values[item.id] = input.value; scheduleSave(session); refreshProgress(session); });
      wrap.appendChild(input);
    });
  }

  function renderTextarea(session, item) {
    return fieldShell(session, item, 'textarea', (wrap) => {
      const ta = el('textarea', ''); ta.id = 'i_' + item.id;
      ta.value = session.values[item.id] || '';
      ta.addEventListener('input', () => { session.values[item.id] = ta.value; scheduleSave(session); refreshProgress(session); });
      wrap.appendChild(ta);
    });
  }

  function renderDate(session, item, kind) {
    const shellKind = kind === 'datetime-local' ? 'datetimelocal' : 'date';
    return fieldShell(session, item, shellKind, (wrap) => {
      const input = el('input', ''); input.type = kind; input.id = 'i_' + item.id;
      input.value = session.values[item.id] || '';
      input.addEventListener('input', () => { session.values[item.id] = input.value; scheduleSave(session); refreshProgress(session); });
      wrap.appendChild(input);
    });
  }

  function renderSelect(session, item) {
    return fieldShell(session, item, 'select', (wrap) => {
      const sel = el('select', ''); sel.id = 'i_' + item.id;
      sel.innerHTML = `<option value="">— bitte wählen —</option>` +
        item.options.map(o => `<option ${session.values[item.id] === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
      sel.addEventListener('change', () => { session.values[item.id] = sel.value; scheduleSave(session); refreshProgress(session); });
      wrap.appendChild(sel);
    });
  }

  function renderMultiselect(session, item) {
    return fieldShell(session, item, 'multiselect', (wrap) => {
      const multi = el('div', 'multi');
      const current = Array.isArray(session.values[item.id]) ? session.values[item.id] : [];
      item.options.forEach(opt => {
        const isChecked = current.includes(opt);
        const lbl = el('label', isChecked ? 'checked' : '');
        lbl.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''}/><span>${escapeHtml(opt)}</span>`;
        lbl.querySelector('input').addEventListener('change', (e) => {
          const cur = new Set(Array.isArray(session.values[item.id]) ? session.values[item.id] : []);
          if (e.target.checked) cur.add(opt); else cur.delete(opt);
          session.values[item.id] = Array.from(cur);
          lbl.classList.toggle('checked', e.target.checked);
          scheduleSave(session); refreshProgress(session);
        });
        multi.appendChild(lbl);
      });
      wrap.appendChild(multi);
    });
  }

  // ----- Progress
  function isItemSkipped(session, item) {
    const r = session.skipped && session.skipped[item.id];
    return !!(r && String(r).trim() !== '');
  }

  function skipButton(session, item, onRender) {
    const skipped = isItemSkipped(session, item);
    const btn = el('button', 'skip-btn-inline no-print', svgIcon('skip') + (skipped ? '<span>Übersprungen</span>' : '<span>Überspringen</span>'));
    btn.type = 'button';
    btn.title = skipped ? 'Übersprungen rückgängig machen' : 'Mit Begründung überspringen';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      toggleSkip(session, item, onRender);
    });
    return btn;
  }
  function skipNote(session, item) {
    const r = session.skipped?.[item.id];
    if (!r) return null;
    return el('div', 'skip-note', `↷ Übersprungen: ${escapeHtml(r)}`);
  }

  function toggleSkip(session, item, onChange) {
    if (!session.skipped) session.skipped = {};
    if (isItemSkipped(session, item)) {
      delete session.skipped[item.id];
      scheduleSave(session);
      if (onChange) onChange();
      return;
    }
    const reason = prompt('Begründung, warum dieser Punkt übersprungen wird:', '');
    if (reason === null) return;
    const text = String(reason).trim();
    if (!text) { alert('Eine Begründung ist erforderlich.'); return; }
    session.skipped[item.id] = text;
    scheduleSave(session);
    if (onChange) onChange();
  }
  function isItemDone(session, item) {
    // Skipped items always count as resolved
    if (isItemSkipped(session, item)) {
      if (item.type === 'info' && item.attach !== 'required') return null; // info without attach still doesn't count
      return true;
    }
    const hasImg = !!(session.attachments && session.attachments[item.id] && session.attachments[item.id].length);
    if (item.type === 'info') {
      if (item.attach === 'required') return hasImg;
      return null;
    }
    const v = session.values[item.id];
    if (item.type === 'check') {
      if (!v) return false;
      if (item.attach === 'required') return hasImg;
      return true;
    }
    if (item.type === 'multiselect') {
      const filled = Array.isArray(v) && v.length > 0;
      if (item.attach === 'required') return filled && hasImg;
      return filled;
    }
    const filled = v !== undefined && v !== null && String(v).trim() !== '';
    if (item.attach === 'required') return filled && hasImg;
    return filled;
  }
  function calcProgress(session) {
    const cl = templateForSession(session) || { title: '', sections: [] };
    let total = 0, done = 0;
    cl.sections.forEach(sec => sec.items.forEach(item => {
      const d = isItemDone(session, item);
      if (d === null) return;
      total++; if (d) done++;
    }));
    return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
  }
  function sectionCounts(session, sec) {
    let total = 0, done = 0;
    sec.items.forEach(item => {
      const d = isItemDone(session, item);
      if (d === null) return;
      total++; if (d) done++;
    });
    return { total, done };
  }
  function refreshProgress(session) {
    // Update progress bar + counts without re-rendering whole tree
    const progress = calcProgress(session);
    const bar = view.querySelector('.statusbar');
    if (bar) {
      bar.querySelector('.progress-bar').style.width = progress.percent + '%';
      const texts = bar.querySelectorAll('.progress-text');
      texts[0].textContent = `${progress.done} / ${progress.total} erledigt`;
      texts[1].innerHTML = `<strong>${progress.percent}%</strong>`;
    }
    // Section counts
    const cl = templateForSession(session) || { title: '', sections: [] };
    view.querySelectorAll('.section-h').forEach((h, i) => {
      const c = sectionCounts(session, cl.sections[i]);
      const cnt = h.querySelector('.count');
      if (cnt) cnt.textContent = `${c.done}/${c.total}`;
    });
  }

  // ----- Save (debounced PATCH to /api/sessions/:id)
  function scheduleSave(session, flush) {
    if (saveTimer) clearTimeout(saveTimer);
    state.saving = true; setSavedIndicator(true);
    const doSave = async () => {
      try {
        await API.patch('/api/sessions/' + encodeURIComponent(session.id), {
          meta: session.meta, values: session.values, skipped: session.skipped || {},
        });
        invalidateSessionsList();
      } catch (e) {
        console.error('Sitzung speichern fehlgeschlagen:', e);
      }
      state.saving = false; setSavedIndicator(false);
    };
    if (flush) doSave();
    else saveTimer = setTimeout(doSave, 350);
  }
  function setSavedIndicator(saving) {
    const el = document.getElementById('savedIndicator');
    if (!el) return;
    el.classList.toggle('is-saving', saving);
    el.innerHTML = `<span class="dot"></span>${saving ? 'speichere…' : 'gespeichert'}`;
  }

  // ----- Export
  function exportSession(session) {
    const cl = templateForSession(session) || { title: '', sections: [] };
    const safeName = (session.meta.kunde || cl.title).replace(/[^a-z0-9\-\. _äöüÄÖÜß]/gi, '_');
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cl.id}_${safeName}_${session.updatedAt.slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ----- Helpers
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  }
  function crumb(...parts) {
    crumbsEl.innerHTML = parts.join(' <span style="opacity:.4;margin:0 4px">›</span> ');
  }
  function actionBtn(label, onClick, icon) {
    const b = el('button', 'btn ghost', (icon ? svgIcon(icon) : '') + `<span>${escapeHtml(label)}</span>`);
    b.addEventListener('click', onClick);
    return b;
  }
  function iconBtn(icon, title, onClick) {
    const b = el('button', 'btn ghost icon', svgIcon(icon));
    b.title = title; b.addEventListener('click', onClick);
    return b;
  }

  // SVG icons (lucide-ish)
  function svgIcon(name) {
    const paths = {
      check:      '<polyline points="20 6 9 17 4 12"></polyline>',
      moon:       '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',
      sun:        '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
      print:      '<polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect>',
      download:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
      'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>',
      trash:      '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
      edit:       '<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
      plus:       '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
      up:         '<polyline points="18 15 12 9 6 15"></polyline>',
      down:       '<polyline points="6 9 12 15 18 9"></polyline>',
      upload:     '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line>',
      undo:       '<path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-15-6.7L3 13"></path>',
      camera:     '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle>',
      expand:     '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>',
      image:      '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>',
      clipboard:  '<path d="M9 2h6a2 2 0 0 1 2 2v2H7V4a2 2 0 0 1 2-2z"></path><rect x="5" y="6" width="14" height="16" rx="2" ry="2"></rect>',
      logout:     '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>',
      users:      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
      key:        '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>',
      power:      '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line>',
      skip:       '<polyline points="5 4 15 12 5 20 5 4"></polyline><line x1="19" y1="5" x2="19" y2="19"></line>',
    };
    return `<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
  }

  // ----- Boot
  initTheme();
  (async function boot() {
    // Version sofort holen (klein, kein Login nötig) – für Topbar/Login-Anzeige
    try { state.appVersion = (await API.get('/api/version'))?.version || null; }
    catch { state.appVersion = null; }
    try {
      state.user = await API.auth.me();
      if (state.user) {
        try { await loadTemplatesFromApi(); }
        catch (e) { console.error('Vorlagen konnten nicht geladen werden:', e); }
      }
    } catch (e) {
      state.user = null;
    }
    parseRoute();
  })();

  // Re-load templates after a successful login (called from renderLogin's submit handler)
  window.__refreshAfterLogin = async () => {
    try { await loadTemplatesFromApi(); } catch (e) { console.error(e); }
  };
})();
