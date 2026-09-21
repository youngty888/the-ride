/* ============================================
   Stop Preferences screen.
   Favorite brands (ranked first), blocked brands (never shown), where Add Stop
   starts, how far off a route to look, and the "usual" stops the app has learned
   from the stops the rider actually picked (see PoiModule.recordPick).
   Everything here is stored on this device (Storage.KEYS.POI_PREFS); it does not
   sync to the account yet.
   ============================================ */
const PrefsModule = {
  timer: null,
  MAX_LIST: 40,

  open() {
    App.showOverlay('overlay-stop-prefs');
    this.render();
  },

  // Lowercase, trimmed, single-spaced brand text. Empty/too short is rejected.
  normalize(text) {
    const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
    return s.length >= 2 ? s : '';
  },

  // Add a brand to 'favorites' or 'blocked'. It can only be in one of them.
  addTo(prefs, list, text) {
    const key = this.normalize(text);
    if (!key) return false;
    const other = list === 'favorites' ? 'blocked' : 'favorites';
    prefs[other] = prefs[other].filter(x => x !== key);
    if (!prefs[list].includes(key) && prefs[list].length < this.MAX_LIST) prefs[list].push(key);
    return true;
  },

  // Learned entries, most-picked first.
  learnedList(prefs) {
    return Object.entries(prefs.learned || {})
      .map(([key, e]) => ({ key, name: e.name || key, cat: e.cat, n: e.n }))
      .sort((a, b) => (b.n - a.n) || a.key.localeCompare(b.key));
  },

  // The one thing worth suggesting: a usual stop that is not a favorite yet.
  suggestion(prefs) {
    if (!prefs.learn) return null;
    return this.learnedList(prefs).find(u => u.n >= PoiModule.USUAL_AT && !prefs.favorites.includes(u.key)
      && !prefs.blocked.includes(u.key)) || null;
  },

  html(prefs) {
    const esc = s => App.escapeHtml(s);
    const tag = (list, k) => `<span class="pref-tag">${esc(k)}<button type="button" class="pref-tag-x" data-remove="${list}" data-key="${esc(k)}" aria-label="Remove ${esc(k)}">×</button></span>`;
    const tags = (list) => prefs[list].length
      ? `<div class="pref-tags">${prefs[list].map(k => tag(list, k)).join('')}</div>`
      : '<p class="plan-section-note">None yet.</p>';
    const addForm = (list, hint) => `<form class="pref-add" data-add="${list}">
        <input type="text" maxlength="40" placeholder="${esc(hint)}" aria-label="Add a brand"><button type="submit" class="btn-secondary">Add</button></form>`;
    const sug = this.suggestion(prefs);
    const learned = this.learnedList(prefs).slice(0, 8);
    const catLabel = id => PoiModule.CATS.some(c => c.id === id) ? PoiModule.cat(id).label : '';

    return `
      ${sug ? `<div class="setting-block pref-suggestion">
        <strong>You usually stop at ${esc(sug.name)}.</strong>
        <div class="setting-desc">You have picked it ${sug.n} times. Make it a favorite to keep it at the top of your lists.</div>
        <button type="button" class="btn-primary" data-favorite="${esc(sug.key)}">Make ${esc(sug.name)} a favorite</button>
      </div>` : ''}

      <h3 class="plan-section-title">Add Stop starts on</h3>
      <div class="filter-chips" id="prefStartGroup">
        ${PoiModule.GROUPS.map(g => `<button type="button" class="chip${g.id === prefs.startGroup ? ' active' : ''}" data-group="${g.id}">${g.icon} ${esc(g.label)}</button>`).join('')}
      </div>

      <h3 class="plan-section-title">Favorite brands</h3>
      <p class="plan-section-note">Shown first in every list. Matches part of a name, so "circle k" also catches "Circle K #1234".</p>
      ${tags('favorites')}
      ${addForm('favorites', 'e.g. Circle K')}

      <h3 class="plan-section-title">Never show</h3>
      <p class="plan-section-note">Hidden from Add Stop and search results.</p>
      ${tags('blocked')}
      ${addForm('blocked', 'e.g. a brand you avoid')}

      <h3 class="plan-section-title">Along a route</h3>
      <div class="setting-block">
        <div class="setting-label">Look up to ${prefs.maxDetourMi} mi off your route</div>
        <div class="setting-desc">Stops farther off the line than this are left out when you search Along my route.</div>
        <input type="range" min="1" max="15" step="1" id="prefDetour" value="${prefs.maxDetourMi}" class="range-input">
      </div>

      <h3 class="plan-section-title">Learn my usual stops</h3>
      <label class="setting-row">
        <span class="setting-text">
          <span class="setting-label">Learn from my stops</span>
          <span class="setting-desc">When you add a stop to a route or set one as your destination, RIDE counts the brand. After ${PoiModule.USUAL_AT} times it is marked "Your usual" and listed just below your favorites. Counts stay on this device.</span>
        </span>
        <span class="switch"><input type="checkbox" id="prefLearn" ${prefs.learn ? 'checked' : ''}><span class="switch-slider"></span></span>
      </label>
      ${learned.length ? `<div class="pref-learned">${learned.map(u => `
        <div class="pref-learned-row">
          <span class="pref-learned-name">${esc(u.name)}<span class="pref-learned-meta">${esc(catLabel(u.cat))}${catLabel(u.cat) ? ' · ' : ''}${u.n}×</span></span>
          ${prefs.favorites.includes(u.key) ? '<span class="pref-learned-meta">Favorite</span>' : `<button type="button" class="btn-secondary" data-favorite="${esc(u.key)}">Favorite</button>`}
          <button type="button" class="btn-secondary" data-forget="${esc(u.key)}">Forget</button>
        </div>`).join('')}</div>
        <button type="button" class="btn-secondary" id="prefClearLearned">Forget everything it learned</button>`
        : '<p class="plan-section-note">Nothing learned yet. Add a few stops to routes and your usual ones will show up here.</p>'}

      <p class="plan-section-note">These preferences are saved on this device. They do not follow you to another phone yet.</p>
    `;
  },

  render() {
    const el = document.getElementById('stopPrefsBody');
    if (!el) return;
    el.innerHTML = this.html(Storage.getPoiPrefs());

    el.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () =>
      this.update(p => { p[b.dataset.remove] = p[b.dataset.remove].filter(x => x !== b.dataset.key); })));
    el.querySelectorAll('.pref-add').forEach(form => form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const value = input.value;
      if (!this.normalize(value)) { App.toast('Type at least 2 letters.'); return; }
      this.update(p => this.addTo(p, form.dataset.add, value));
    }));
    el.querySelectorAll('[data-favorite]').forEach(b => b.addEventListener('click', () =>
      this.update(p => this.addTo(p, 'favorites', b.dataset.favorite))));
    el.querySelectorAll('[data-forget]').forEach(b => b.addEventListener('click', () =>
      this.update(p => { delete p.learned[b.dataset.forget]; })));
    el.querySelectorAll('#prefStartGroup .chip').forEach(chip => chip.addEventListener('click', () => {
      this.update(p => { p.startGroup = chip.dataset.group; });
      const addStop = document.getElementById('overlay-addstop');
      if (!(addStop && addStop.classList.contains('active'))) App.applyStartGroup();
    }));
    const detour = el.querySelector('#prefDetour');
    if (detour) detour.addEventListener('change', () => this.update(p => { p.maxDetourMi = +detour.value; }));
    const learn = el.querySelector('#prefLearn');
    if (learn) learn.addEventListener('change', () => this.update(p => { p.learn = learn.checked; }));
    const clear = el.querySelector('#prefClearLearned');
    if (clear) clear.addEventListener('click', () => {
      if (confirm('Forget every usual stop RIDE has learned? Your favorites and blocked brands stay.')) this.update(p => { p.learned = {}; });
    });
  },

  update(change) {
    const p = Storage.getPoiPrefs();
    change(p);
    Storage.savePoiPrefs(p);
    this.render();
    this.refreshAddStop();
  },

  // Re-run an open Add Stop list so new favorites/blocks show up straight away.
  refreshAddStop() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const addStop = document.getElementById('overlay-addstop');
      if (addStop && addStop.classList.contains('active')) App.loadStops();
    }, 400);
  },
};
