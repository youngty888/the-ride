/* Shop calendar. Shop appointments (everyone on staff sees them) and the
   signed-in person's personal appointments (only they see them; the
   database enforces it). Appointments are cancelled, never deleted. Saves go
   through shop_save_appointment (shop-011). Text uses textContent only. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const genId = () => (root.crypto?.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)));
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const timeText = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const bikeLabel = b => b ? [b.year, b.make, b.model].filter(Boolean).join(' ') || 'Bike' : '';
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  const App = {
    appts: [], customers: [], bikes: [], jobs: [], me: null, month: null, day: null, cur: null, busy: false,

    async init() {
      this.bind();
      this.show('caLoading');
      try { const s = await ShApi.verify(); this.me = s.user; }
      catch (e) { return this.signedOut(e.status && e.status !== 401 && e.status !== 403 ? `Could not reach the shop server: ${e.message}` : null); }
      let ok = false;
      try { ok = (await ShApi.rpc('shop_has_staff_access', {})) === true; } catch (e) { return this.signedOut(`Could not check shop access: ${e.message}`); }
      if (!ok) return this.signedOut(null, 'This account is not on the shop staff list.');
      $('caNav').hidden = false;
      const now = new Date(); this.month = new Date(now.getFullYear(), now.getMonth(), 1); this.day = ymd(now);
      if (!(await this.refresh())) return;
      const q = new URLSearchParams(root.location.search);
      if (q.get('new')) return this.openForm(null);
      if (q.get('appt')) { const a = this.appts.find(x => x.id === q.get('appt')); if (a) return this.openForm(a); }
      this.openMonth();
    },
    signedOut(err, text) { if (err) this.message(err, true); if (text) $('caSignedOutText').textContent = text; this.show('caSignedOut'); },
    show(id) { for (const v of document.querySelectorAll('.ca-view')) v.hidden = v.id !== id; root.scrollTo?.(0, 0); },
    message(text, bad = false) { const m = $('caMsg'); m.textContent = text || ''; m.hidden = !text; m.classList.toggle('sh-msg-error', !!bad); },

    bind() {
      $('caPrev').addEventListener('click', () => { this.month.setMonth(this.month.getMonth() - 1); this.renderMonth(); });
      $('caNext').addEventListener('click', () => { this.month.setMonth(this.month.getMonth() + 1); this.renderMonth(); });
      $('caToday').addEventListener('click', () => { const n = new Date(); this.month = new Date(n.getFullYear(), n.getMonth(), 1); this.day = ymd(n); this.renderMonth(); });
      $('caNewBtn').addEventListener('click', () => this.openForm(null));
      $('caAddDay').addEventListener('click', () => this.openForm(null, this.day));
      $('caForm').addEventListener('submit', e => { e.preventDefault(); this.save(false); });
      $('caCancelAppt').addEventListener('click', () => this.save(true));
      $('caBack').addEventListener('click', () => { root.history.replaceState(null, '', 'calendar.html'); this.message(''); this.openMonth(); });
      $('caAllDay').addEventListener('change', () => { $('caStart').disabled = $('caEnd').disabled = $('caAllDay').checked; });
      // Moving the start keeps the same length (or an hour), so the end never lands before the start.
      $('caStart').addEventListener('focus', () => { this.startWas = $('caStart').value; });
      $('caStart').addEventListener('change', () => {
        const mins = t => { const [h, m] = String(t || '').split(':').map(Number); return h * 60 + m; };
        const st = $('caStart').value, en = $('caEnd').value; if (!st) return;
        const len = this.startWas && en && mins(en) > mins(this.startWas) ? mins(en) - mins(this.startWas) : 60;
        if (!en || mins(en) <= mins(st) || this.startWas) {
          const e = Math.min(mins(st) + len, 23 * 60 + 59);
          $('caEnd').value = `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
        }
        this.startWas = st;
      });
      $('caCustomer').addEventListener('change', () => this.fillLinks($('caCustomer').value, '', ''));
    },

    async refresh() {
      try {
        const [appts, customers, bikes, jobs] = await Promise.all([
          ShApi.select('shop_appointments', 'select=*&order=starts_at.asc'),
          ShApi.select('shop_customers', 'select=id,name,phone&order=name.asc'),
          ShApi.select('shop_bikes', 'select=id,customer_id,make,model,year'),
          ShApi.select('shop_jobs', 'select=id,estimate_number,customer_id,work_description,status&order=job_date.desc'),
        ]);
        Object.assign(this, { appts, customers, bikes, jobs });
        return true;
      } catch (e) {
        if (e.status === 401) { this.signedOut('Your sign-in expired. Sign in again on the shop page.'); return false; }
        this.message(/shop_appointments/.test(e.message || '') || e.status === 404 ? 'The shop calendar is not set up on the server yet (ask Tyler to run the shop-011 SQL file).' : `Could not load the calendar: ${e.message}`, true);
        this.show('caMonth'); return false;
      }
    },

    onDay(key) { return this.appts.filter(a => ymd(new Date(a.starts_at)) === key).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at))); },
    openMonth() { this.renderMonth(); this.show('caMonth'); },

    renderMonth() {
      const m = this.month; const grid = $('caGrid');
      $('caTitle').textContent = m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => el('div', { class: 'ca-dow', role: 'columnheader', text: d }));
      const start = new Date(m.getFullYear(), m.getMonth(), 1 - m.getDay());
      const todayKey = ymd(new Date());
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); const key = ymd(d);
        if (i >= 35 && d.getMonth() !== m.getMonth()) break;
        const list = this.onDay(key).filter(a => !a.cancelled);
        cells.push(el('button', { type: 'button', role: 'gridcell', class: ['ca-cell', d.getMonth() !== m.getMonth() && 'ca-out', key === todayKey && 'ca-today', key === this.day && 'ca-sel'].filter(Boolean).join(' '),
          'aria-label': `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${list.length} appointment${list.length === 1 ? '' : 's'}`,
          onclick: () => { this.day = key; this.renderMonth(); } },
          el('span', { class: 'ca-num', text: String(d.getDate()) }),
          ...list.slice(0, 3).map(a => el('span', { class: 'ca-chip' + (a.visibility === 'personal' ? ' ca-p' : ''), text: (a.all_day ? '' : timeText(new Date(a.starts_at)).replace(':00', '').replace(' ', '').toLowerCase() + ' ') + a.title })),
          list.length > 3 ? el('span', { class: 'ca-more', text: `+${list.length - 3} more` }) : null));
      }
      grid.replaceChildren(...cells);
      this.renderDay();
    },

    renderDay() {
      const [y, mo, d] = this.day.split('-').map(Number);
      $('caDayTitle').textContent = new Date(y, mo - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const list = this.onDay(this.day);
      $('caDayList').replaceChildren(...(list.length ? list.map(a => {
        const s = new Date(a.starts_at); const c = this.customers.find(x => x.id === a.customer_id);
        return el('li', {}, el('button', { type: 'button', class: 'ca-item' + (a.visibility === 'personal' ? ' ca-p' : '') + (a.cancelled ? ' ca-x' : ''), onclick: () => this.openForm(a) },
          el('span', { class: 'ca-when', text: a.all_day ? 'All day' : timeText(s) + (a.ends_at ? `–${timeText(new Date(a.ends_at))}` : '') }),
          el('span', {}, a.title, el('small', { text: [a.visibility === 'personal' ? 'Personal' : 'Shop', c?.name, a.cancelled ? 'Cancelled' : ''].filter(Boolean).join(' · ') }))));
      }) : [el('li', { class: 'sh-muted', text: 'Nothing on this day.' })]));
    },

    fillLinks(cid, bid, jid) {
      const opt = (v, t) => el('option', { value: v, text: t });
      $('caBike').replaceChildren(opt('', 'No bike'), ...this.bikes.filter(b => b.customer_id === cid).map(b => opt(b.id, bikeLabel(b))));
      $('caBike').value = bid && this.bikes.some(b => b.id === bid && b.customer_id === cid) ? bid : '';
      const jobs = this.jobs.filter(j => !cid || j.customer_id === cid);
      $('caJob').replaceChildren(opt('', 'No job'), ...jobs.map(j => opt(j.id, `IV#${j.estimate_number ?? '—'}${j.work_description ? ' · ' + j.work_description.slice(0, 40) : ''}`)));
      $('caJob').value = jid && jobs.some(j => j.id === jid) ? jid : '';
    },

    openForm(a, dayKey) {
      const mine = !a || a.owner_user_id === this.me?.id;
      this.cur = a ? { ...a } : { id: genId(), isNew: true };
      $('caFormTitle').textContent = a ? 'Appointment' : 'New appointment';
      $('caTitleIn').value = a?.title || '';
      const s = a ? new Date(a.starts_at) : null; const e = a?.ends_at ? new Date(a.ends_at) : null;
      $('caDate').value = s ? ymd(s) : (dayKey || this.day || ymd(new Date()));
      $('caAllDay').checked = !!a?.all_day;
      $('caStart').value = s ? hm(s) : '09:00'; $('caEnd').value = e ? hm(e) : (s ? '' : '10:00');
      $('caStart').disabled = $('caEnd').disabled = !!a?.all_day;
      document.querySelector(`input[name=caVis][value=${a?.visibility === 'personal' ? 'personal' : 'public'}]`).checked = true;
      document.querySelectorAll('input[name=caVis]').forEach(r => { r.disabled = !mine; });
      const opt = (v, t) => el('option', { value: v, text: t });
      $('caCustomer').replaceChildren(opt('', 'No customer'), ...this.customers.map(c => opt(c.id, c.name + (c.phone ? ` · ${c.phone}` : ''))));
      $('caCustomer').value = a?.customer_id || '';
      this.fillLinks($('caCustomer').value, a?.bike_id, a?.job_id);
      $('caNotes').value = a?.notes || '';
      $('caCancelAppt').hidden = !a || a.cancelled;
      $('caStamp').textContent = a ? `${a.visibility === 'personal' ? 'Personal' : 'Shop'} appointment${a.cancelled ? ' · cancelled' : ''}${mine ? '' : ' · made by someone else on staff'}` : '';
      this.message(''); this.show('caEdit');
      if (!a) $('caTitleIn').focus();
    },

    async save(cancel) {
      if (this.busy) return;
      const title = $('caTitleIn').value.trim(); const date = $('caDate').value; const allDay = $('caAllDay').checked;
      if (!title) { this.message('Enter what the appointment is for.', true); $('caTitleIn').focus(); return; }
      if (!date) { this.message('Pick the date.', true); $('caDate').focus(); return; }
      const st = allDay ? '00:00' : ($('caStart').value || '09:00');
      const start = new Date(`${date}T${st}`);
      let end = null;
      if (!allDay && $('caEnd').value) { end = new Date(`${date}T${$('caEnd').value}`); if (end < start) { this.message('The end time is before the start time.', true); return; } }
      if (cancel && !root.confirm('Cancel this appointment? It stays on the calendar crossed out.')) return;
      const btn = cancel ? $('caCancelAppt') : $('caSave'); const label = btn.textContent;
      this.busy = true; btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const saved = await ShApi.rpc('shop_save_appointment', { p_id: this.cur.id, p_appt: {
          title, starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null, all_day: allDay,
          visibility: document.querySelector('input[name=caVis]:checked').value,
          customer_id: $('caCustomer').value || null, bike_id: $('caBike').value || null, job_id: $('caJob').value || null,
          notes: $('caNotes').value.trim(), cancelled: !!cancel || !!this.cur.cancelled,
          expected_updated_at: this.cur.isNew ? null : this.cur.updated_at } });
        await this.refresh();
        this.day = ymd(new Date(saved.starts_at)); const sd = new Date(saved.starts_at); this.month = new Date(sd.getFullYear(), sd.getMonth(), 1);
        root.history.replaceState(null, '', 'calendar.html');
        this.openMonth(); this.message(cancel ? 'Appointment cancelled.' : 'Appointment saved.');
      } catch (e) {
        if (e.status === 401) this.message('Your sign-in expired. Sign in again on the shop page, then save again.', true);
        else if (/changed by someone else/.test(e.message)) this.message('Someone else changed this appointment after you opened it. Go back and open it again.', true);
        else this.message(`Not saved: ${e.message}`, true);
      } finally { this.busy = false; btn.disabled = false; btn.textContent = label; }
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.init()); else App.init();
})(window);
