/* RIDE - "Heads-up" banner for dated notices (events, road closures).
   Data lives in data/events.json. An event shows from its `start` date through its `end`
   date (YYYY-MM-DD, local time) and then hides itself. Dismissing hides it for this visit. */
const EventsModule = {
  // Pure: which events should show on `today` (a Date). Bad entries are skipped, never thrown.
  active(list, today = new Date()) {
    const p = n => String(n).padStart(2, '0');
    const day = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    return (Array.isArray(list) ? list : []).filter(e =>
      e && typeof e.id === 'string' && typeof e.title === 'string' &&
      typeof e.start === 'string' && typeof e.end === 'string' && e.start <= day && day <= e.end);
  },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  },

  safeUrl(u) { return /^https:\/\//.test(u || '') ? u : ''; },

  render(events) {
    const host = document.getElementById('screen-map');
    if (!host || !events.length) return;
    const box = document.createElement('div');
    box.className = 'events-banner';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Heads-up');
    // The list scrolls on its own so several notices never cover the whole map,
    // and the close button stays put.
    box.innerHTML = '<div class="events-scroll" tabindex="0">' + events.map(e => {
      const src = this.safeUrl(e.source);
      return `<div class="events-item" data-id="${this.esc(e.id)}">
        <strong>${this.esc(e.title)}</strong>
        ${e.detail ? `<span>${this.esc(e.detail)}</span>` : ''}
        ${src ? `<a href="${this.esc(src)}" target="_blank" rel="noopener">Source</a>` : ''}
      </div>`;
    }).join('') + '</div><button type="button" class="events-close" aria-label="Dismiss heads-up">&times;</button>';
    box.querySelector('.events-close').addEventListener('click', () => box.remove());
    host.appendChild(box);
  },

  async init() {
    try {
      const res = await fetch('data/events.json', {cache: 'no-cache'});
      if (!res.ok) return;
      const data = await res.json();
      this.render(this.active(data && data.events));
    } catch (e) { /* a notice is nice-to-have; never break the map */ }
  }
};

if (typeof module !== 'undefined') module.exports = EventsModule;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => EventsModule.init());
  else EventsModule.init();
}
