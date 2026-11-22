/* Shop module app logic.
   Screens: sign in -> jobs list -> estimate editor -> customer copy (print/PDF).
   One estimate form captures customer + bike + itemized parts/labor and saves
   them together with ONE database call (shop_save_estimate), so staff never
   re-enter customer or bike details anywhere else. The database recalculates
   every total from the line items; the on-screen math (sh-calc.js) uses the
   same rules so the preview matches what is saved.
   All customer-entered text is written with textContent, never innerHTML. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const BUCKET = 'shop-bike-photos';
  const STATUS_LABEL = { estimate: 'Estimate', in_progress: 'In progress', complete: 'Complete' };
  const PAY_LABEL = { unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid' };
  const NEXT = { estimate: ['in_progress', 'Start job'], in_progress: ['complete', 'Mark complete'] };
  const TAX_LABEL = { parts: 'on parts', parts_labor: 'on parts and labor', none: '' };

  const genId = () => (root.crypto?.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)));
  const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
  const money = v => ShCalc.money(ShCalc.centsOf(v ?? 0));
  const numText = v => { if (v === null || v === undefined || v === '') return ''; const n = Number(v); return Number.isInteger(n) ? String(n) : String(n); };
  // Work order numbers show as IV#1001. The database still stores the plain number.
  const wo = n => (n === null || n === undefined || n === '') ? 'IV#—' : `IV#${n}`;
  const bikeLabel = b => b ? [b.year, b.make, b.model].filter(Boolean).join(' ') : '';

  // Tiny safe DOM builder: text children become text nodes.
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  const App = {
    user: null, jobs: [], customers: [], bikes: [], settings: null, savedJobs: [],
    filter: '', search: '', form: null, busy: false, photoCache: new Map(),

    // ---------- startup / sign-in ----------
    async init() {
      this.bind();
      await this.start();
    },

    bind() {
      $('shSignInForm').addEventListener('submit', e => { e.preventDefault(); this.signIn(); });
      $('shSignOutBtn').addEventListener('click', () => this.signOut());
      $('shNoAccessSignOut').addEventListener('click', () => this.signOut());
      $('shNewJobBtn').addEventListener('click', () => { this.closeMenu(); this.openEditor(null); });
      $('shNewMenuBtn').addEventListener('click', () => this.toggleMenu());
      $('shNewSignoff').addEventListener('click', () => { this.closeMenu(); this.pickJobForSignoff(); });
      $('shNewList').addEventListener('click', e => { if (e.target.closest('a')) this.closeMenu(); });
      document.addEventListener('click', e => { if (!e.target.closest('#shNewMenu')) this.closeMenu(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('shNewList').hidden) { this.closeMenu(); $('shNewMenuBtn').focus(); } });
      $('shSettingsBtn').addEventListener('click', () => this.openSettings());
      document.querySelectorAll('[data-go-settings]').forEach(b => b.addEventListener('click', () => this.openSettings()));
      $('shSearch').addEventListener('input', e => { this.search = e.target.value; this.renderJobs(); });
      $('shFilter').addEventListener('click', e => {
        const b = e.target.closest('[data-filter]'); if (!b) return;
        this.filter = b.dataset.filter;
        $('shFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        this.renderJobs();
      });
      $('shEstimateForm').addEventListener('submit', e => { e.preventDefault(); this.save(); });
      $('shEstimateForm').addEventListener('input', () => { if (this.form) { this.form.dirty = true; this.recalc(); } });
      $('shCancelBtn').addEventListener('click', () => { if (this.confirmLeave()) this.show('shList'); });
      $('shCustomerPick').addEventListener('change', () => this.pickCustomer($('shCustomerPick').value));
      $('shBikePick').addEventListener('change', () => this.pickBike($('shBikePick').value));
      $('shAddJob').addEventListener('click', () => { this.addJob(); this.form.dirty = true; });
      const hl = $('shHoursList'); for (let h = 0.5; h <= 16; h += 0.5) hl.append(el('option', { value: String(h) }));
      $('shPhotoFiles').addEventListener('change', () => this.renderPhotos());
      $('shPrintBtn').addEventListener('click', () => root.print());
      $('shPrintBack').addEventListener('click', () => this.show('shList'));
      $('shPrintEdit').addEventListener('click', () => this.openEditor(this.printJobId));
      $('shSettingsForm').addEventListener('submit', e => { e.preventDefault(); this.saveSettings(); });
      $('shSetCancel').addEventListener('click', () => this.show('shList'));
      $('shSoBack').addEventListener('click', () => this.show('shList'));
      root.addEventListener('beforeunload', e => { if (this.form?.dirty && !$('shEditor').hidden) { e.preventDefault(); e.returnValue = ''; } });
    },

    async start() {
      this.show('shLoading');
      let s;
      try { s = await ShApi.verify(); }
      catch (e) {
        if (e.status && e.status !== 401 && e.status !== 403) { this.message(`Could not reach the shop server: ${e.message}`, true); }
        this.show('shSignIn'); return;
      }
      this.user = s.user;
      let ok = false;
      try { ok = await ShApi.rpc('shop_has_staff_access', {}); }
      catch (e) { this.message(`Could not check shop access: ${e.message}`, true); this.show('shSignIn'); return; }
      if (ok !== true) { $('shNoAccessEmail').textContent = this.user?.email || 'this account'; this.show('shNoAccess'); return; }
      $('shNav').hidden = false;
      ShApi.rpc('shop_log_login', {}).catch(() => { /* shop-008 not installed yet */ });
      if (await this.refresh()) { this.openFromUrl(); document.dispatchEvent(new CustomEvent('shop:ready', { detail: { user: this.user } })); }
    },

    // Links from the document library and the New menu: ?job=<id> opens the
    // customer copy, ?new=estimate opens a blank estimate, ?signoff=1 picks a job.
    openFromUrl() {
      const q = new URLSearchParams(root.location.search);
      const job = q.get('job');
      if (job && this.jobs.some(j => j.id === job)) return this.openPrint(job);
      if (q.get('new') === 'estimate') return this.openEditor(null);
      if (q.get('signoff')) return this.pickJobForSignoff();
      this.show('shList');
    },

    toggleMenu() {
      const list = $('shNewList'); const open = list.hidden;
      list.hidden = !open; $('shNewMenuBtn').setAttribute('aria-expanded', String(open));
      if (open) list.querySelector('[role=menuitem]')?.focus();
    },
    closeMenu() { $('shNewList').hidden = true; $('shNewMenuBtn').setAttribute('aria-expanded', 'false'); },

    // Tech sign-off belongs to a job, so show the jobs in work and say what to press.
    pickJobForSignoff() {
      if (!this.confirmLeave()) return;
      this.filter = 'in_progress'; this.search = ''; $('shSearch').value = '';
      $('shFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.filter === 'in_progress'));
      this.renderJobs(); this.show('shList');
      this.message('Pick the job, then press Tech sign-off on it.');
    },

    async signIn() {
      if (this.busy) return;
      const btn = $('shSignInForm').querySelector('button[type=submit]');
      this.busy = true; btn.disabled = true; btn.textContent = 'Signing in…'; this.message('');
      try {
        await ShApi.signIn($('shSignInEmail').value.trim(), $('shSignInPassword').value);
        $('shSignInPassword').value = '';
        this.busy = false;
        await this.start();
      } catch (e) {
        this.message(e.status === 400 ? 'Email or password is not right.' : `Sign in failed: ${e.message}`, true);
      } finally { this.busy = false; btn.disabled = false; btn.textContent = 'Sign in'; }
    },

    async signOut() {
      if (!this.confirmLeave()) return;
      await ShApi.signOut();
      this.jobs = []; this.customers = []; this.bikes = []; this.form = null;
      $('shNav').hidden = true; $('shJobsList').replaceChildren(); document.dispatchEvent(new CustomEvent('shop:signedout'));
      this.show('shSignIn');
    },

    handleAuthError(e) {
      if (e?.status === 401) { this.message('Your sign-in expired. Sign in again.', true); $('shNav').hidden = true; this.show('shSignIn'); return true; }
      return false;
    },

    // ---------- data ----------
    async refresh() {
      try {
        const [jobs, customers, bikes, settings] = await Promise.all([
          ShApi.select('shop_jobs', 'select=*&order=job_date.desc,estimate_number.desc'),
          ShApi.select('shop_customers', 'select=id,name,phone,email,address&order=name.asc'),
          ShApi.select('shop_bikes', 'select=id,customer_id,vin,make,model,year,mileage,photo_urls'),
          ShApi.select('shop_settings', 'select=*'),
        ]);
        this.jobs = jobs; this.customers = customers; this.bikes = bikes; this.settings = settings[0] || {};
        await this.loadSavedJobs();
        this.renderJobs();
        return true;
      } catch (e) {
        if (!this.handleAuthError(e)) this.message(`Could not load shop records: ${e.message}`, true);
        return false;
      }
    },

    // Saved jobs (name + usual hours). Optional: if the shop-007 SQL has not been
    // run yet, the list is simply empty and everything else works.
    async loadSavedJobs() {
      try { this.savedJobs = await ShApi.select('shop_saved_jobs', 'select=name,name_key,hours,use_count&order=use_count.desc,name.asc'); }
      catch (e) { if (e?.status === 401) throw e; this.savedJobs = []; }
      $('shJobNames')?.replaceChildren(...this.savedJobs.map(j => el('option', { value: j.name })));
    },

    savedJob(name) { const k = String(name || '').trim().toLowerCase(); return k ? this.savedJobs.find(j => j.name_key === k) : null; },

    customer(id) { return this.customers.find(c => c.id === id); },
    bike(id) { return this.bikes.find(b => b.id === id); },

    // ---------- views ----------
    show(id) {
      for (const v of document.querySelectorAll('.sh-view')) v.hidden = v.id !== id;
      if (id !== 'shEditor') this.form = null;
      root.scrollTo?.(0, 0);
    },

    message(text, isError = false) {
      const m = $('shMsg');
      m.textContent = text || ''; m.hidden = !text; m.classList.toggle('sh-msg-error', !!isError);
      if (text && !isError) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 4000);
    },

    confirmLeave() {
      return !(this.form?.dirty && !$('shEditor').hidden) || root.confirm('Leave without saving this estimate?');
    },

    renderJobs() {
      $('shTaxWarning').hidden = this.settings?.default_tax_rate !== null && this.settings?.default_tax_rate !== undefined;
      const q = this.search.trim().toLowerCase();
      const rows = this.jobs.filter(j => {
        if (this.filter && j.status !== this.filter) return false;
        if (!q) return true;
        const c = this.customer(j.customer_id) || {}; const b = this.bike(j.bike_id) || {};
        return [c.name, c.phone, c.email, b.vin, bikeLabel(b), j.estimate_number, wo(j.estimate_number), j.invoice_number, j.work_description]
          .some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(q));
      });
      const box = $('shJobsList');
      if (!rows.length) {
        box.replaceChildren(el('p', { class: 'sh-muted sh-empty', text: this.jobs.length ? 'No jobs match.' : 'No estimates yet. Tap “+ New estimate” to write the first one.' }));
        return;
      }
      box.replaceChildren(...rows.map(j => {
        const c = this.customer(j.customer_id) || {}; const b = this.bike(j.bike_id);
        const next = NEXT[j.status];
        return el('div', { class: `sh-job sh-status-${j.status}` },
          el('div', { class: 'sh-job-main' },
            el('div', { class: 'sh-job-top' },
              el('strong', { text: c.name || '(no name)' }),
              el('span', { class: 'sh-job-total', text: money(j.total_amount) })),
            el('div', { class: 'sh-job-sub' },
              el('span', { text: wo(j.estimate_number) }),
              el('span', { text: fmtDate(j.job_date) }),
              el('span', { class: 'sh-pill', text: STATUS_LABEL[j.status] || j.status }),
              j.status === 'estimate' ? null : el('span', { class: `sh-pill sh-pay-${j.payment_status || 'unpaid'}`, text: PAY_LABEL[j.payment_status] || 'Unpaid' }),
              b ? el('span', { text: bikeLabel(b) || b.vin || '' }) : null),
            j.work_description ? el('div', { class: 'sh-job-desc', text: j.work_description }) : null),
          el('div', { class: 'sh-job-actions' },
            el('button', { type: 'button', class: 'sh-btn', text: 'View / Print', onclick: () => this.openPrint(j.id) }),
            el('button', { type: 'button', class: 'sh-btn', text: 'Edit', onclick: () => this.openEditor(j.id) }),
            j.status === 'estimate' ? null : el('button', { type: 'button', class: 'sh-btn', text: 'Tech sign-off', onclick: () => this.openSignoff(j.id) }),
            j.status === 'estimate' ? null : el('select', { class: 'sh-btn sh-pay-select', 'aria-label': `Payment status for ${wo(j.estimate_number)}`, onchange: ev => this.setPayment(j.id, ev.currentTarget) },
              ...Object.entries(PAY_LABEL).map(([v, t]) => el('option', { value: v, text: t, selected: (j.payment_status || 'unpaid') === v }))),
            next ? el('button', { type: 'button', class: 'sh-btn sh-btn-step', text: next[1], onclick: ev => this.setStatus(j.id, next[0], ev.currentTarget) }) : null));
      }));
    },

    async setStatus(jobId, status, btn) {
      if (this.busy) return;
      const j = this.jobs.find(x => x.id === jobId);
      if (status === 'complete' && !root.confirm(`Mark ${wo(j?.estimate_number)} complete?`)) return;
      this.busy = true; if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        await ShApi.rpc('shop_set_job_status', { p_job_id: jobId, p_status: status });
        this.message(`${wo(j?.estimate_number)} is now ${STATUS_LABEL[status].toLowerCase()}.`);
      } catch (e) {
        if (!this.handleAuthError(e)) this.message(`Status not changed: ${e.message}`, true);
      } finally { this.busy = false; await this.refresh(); }
    },

    async setPayment(jobId, sel) {
      if (this.busy) { await this.refresh(); return; }
      const j = this.jobs.find(x => x.id === jobId);
      this.busy = true; sel.disabled = true;
      try {
        await ShApi.rpc('shop_set_payment_status', { p_job_id: jobId, p_payment_status: sel.value });
        this.message(`${wo(j?.estimate_number)} marked ${PAY_LABEL[sel.value].toLowerCase()}.`);
      } catch (e) {
        if (!this.handleAuthError(e)) this.message(`Payment not changed: ${e.message}${/Could not find the function/i.test(e.message) ? ' (ask Tyler to run the shop-006 SQL file)' : ''}`, true);
      } finally { this.busy = false; await this.refresh(); }
    },

    // ---------- tech sign-off (shop-008) ----------
    async openSignoff(jobId) {
      if (this.busy) return;
      this.message('');
      const j = this.jobs.find(x => x.id === jobId);
      if (!j) return;
      let items, signs, staff, pm = false;
      try {
        [items, signs, staff] = await Promise.all([
          ShApi.select('shop_job_line_items', `select=kind,description,quantity&job_id=eq.${encodeURIComponent(jobId)}&kind=eq.labor&order=sort_order.asc`),
          ShApi.select('shop_labor_signoffs', `select=*&job_id=eq.${encodeURIComponent(jobId)}`),
          ShApi.select('shop_staff', 'select=user_id,display_name,active'),
        ]);
        pm = (await ShApi.rpc('shop_is_payroll_manager', {})) === true;
      } catch (e) {
        if (this.handleAuthError(e)) return;
        this.message(/shop_labor_signoffs|shop_is_payroll_manager|Could not find/i.test(e.message) ? 'Tech sign-off is not set up on the server yet (ask Tyler to run the shop-008 SQL file).' : `Could not open sign-off: ${e.message}`, true);
        return;
      }
      const c = this.customer(j.customer_id) || {};
      $('shSoTitle').textContent = `Tech sign-off · ${wo(j.estimate_number)}`;
      $('shSoSub').textContent = [c.name, bikeLabel(this.bike(j.bike_id))].filter(Boolean).join(' · ');
      const name = Object.fromEntries(staff.map(s => [s.user_id, s.display_name]));
      const me = this.user?.id;
      const steps = new Map();
      for (const it of items) {
        const key = String(it.description || '').trim().toLowerCase(); if (!key) continue;
        if (!steps.has(key)) steps.set(key, { name: String(it.description).trim(), bid: 0, signs: [] });
        steps.get(key).bid += Number(it.quantity) || 0;
      }
      for (const sg of signs) {
        if (!steps.has(sg.step_key)) steps.set(sg.step_key, { name: sg.step_name, bid: 0, signs: [], gone: true });
        steps.get(sg.step_key).signs.push(sg);
      }
      const box = $('shSoSteps'); box.replaceChildren();
      if (!steps.size) box.append(el('p', { class: 'sh-card', text: 'This estimate has no labor lines to sign.' }));
      for (const st of steps.values()) {
        const used = st.signs.reduce((t, x) => t + Number(x.hours), 0);
        const mine = st.signs.find(x => x.tech_id === me);
        const disputed = st.signs.some(x => x.disputed);
        const settled = st.signs.length && st.signs.every(x => x.resolved_at);
        const hoursIn = el('input', { type: 'number', min: '0', step: '0.25', inputmode: 'decimal', value: mine ? numText(mine.hours) : '', 'aria-label': `My hours on ${st.name}` });
        const card = el('div', { class: 'sh-card sh-so-step' },
          el('div', { class: 'sh-job-top' }, el('strong', { text: st.name }),
            el('span', { text: `${numText(+used.toFixed(2))} of ${numText(+st.bid.toFixed(2))} bid hrs signed` })),
          st.gone ? el('div', { class: 'sh-warn', text: 'This step is no longer on the estimate. The payroll manager should settle it.' }) : null,
          used > st.bid ? el('div', { class: 'sh-warn', text: 'Signed hours are over the bid (the estimate changed). The payroll manager should settle it.' }) : null,
          disputed ? el('div', { class: 'sh-warn', text: `Disputed${st.signs.find(x => x.dispute_note)?.dispute_note ? ': ' + st.signs.find(x => x.dispute_note).dispute_note : ''}. Waiting on the payroll manager.` }) : null,
          settled ? el('div', { class: 'sh-muted', text: 'Settled by the payroll manager.' }) : null,
          el('ul', { class: 'sh-so-list' }, ...st.signs.map(x => el('li', { text: `${name[x.tech_id] || 'Staff'}: ${numText(+Number(x.hours).toFixed(2))} hrs` }))),
          el('div', { class: 'sh-so-row' },
            el('label', {}, 'My hours', hoursIn),
            el('button', { type: 'button', class: 'sh-btn sh-btn-primary', text: mine ? 'Update' : 'Sign off', onclick: ev => this.signStep(jobId, st.name, hoursIn.value, ev.currentTarget) }),
            mine ? el('button', { type: 'button', class: 'sh-btn sh-btn-quiet', text: 'Take back', onclick: ev => this.signStep(jobId, st.name, '0', ev.currentTarget) }) : null,
            st.signs.length ? el('button', { type: 'button', class: 'sh-btn sh-btn-quiet', text: 'Flag dispute', onclick: () => this.disputeStep(jobId, st.name) }) : null));
        if (pm && (st.signs.length || st.bid)) card.append(this.settleForm(jobId, st, staff));
        box.append(card);
      }
      this.show('shSignoff');
    },

    settleForm(jobId, st, staff) {
      const rows = staff.filter(s => s.active || st.signs.some(x => x.tech_id === s.user_id)).map(s => {
        const cur = st.signs.find(x => x.tech_id === s.user_id);
        return { id: s.user_id, input: el('input', { type: 'number', min: '0', step: '0.25', inputmode: 'decimal', value: cur ? numText(cur.hours) : '', 'aria-label': `Final hours for ${s.display_name}` }), label: s.display_name };
      });
      return el('details', { class: 'sh-so-settle' }, el('summary', { text: 'Payroll manager: set final hours' }),
        el('div', { class: 'sh-grid2' }, ...rows.map(r => el('label', {}, r.label, r.input))),
        el('button', { type: 'button', class: 'sh-btn', text: 'Save final hours', onclick: async ev => {
          const splits = rows.filter(r => Number(r.input.value) > 0).map(r => ({ tech_id: r.id, hours: r.input.value }));
          await this.runSignoff(jobId, ev.currentTarget, () => ShApi.rpc('shop_settle_step', { p_job_id: jobId, p_step: st.name, p_splits: splits }), `Final hours saved for ${st.name}.`);
        } }));
    },

    async runSignoff(jobId, btn, call, okText) {
      if (this.busy) return;
      this.busy = true; if (btn) { btn.disabled = true; }
      try { await call(); this.message(okText); }
      catch (e) { if (!this.handleAuthError(e)) this.message(e.message, true); }
      finally { this.busy = false; if (btn) btn.disabled = false; }
      if (!$('shSignoff').hidden) await this.openSignoff(jobId);
    },
    signStep(jobId, step, hours, btn) {
      return this.runSignoff(jobId, btn, () => ShApi.rpc('shop_sign_step', { p_job_id: jobId, p_step: step, p_hours: String(hours || '0') }),
        Number(hours) > 0 ? `Signed ${hours} hrs on ${step}.` : `Took back your sign-off on ${step}.`);
    },
    disputeStep(jobId, step) {
      const note = root.prompt(`What's wrong with the split on "${step}"? The payroll manager will settle it.`);
      if (note === null) return;
      return this.runSignoff(jobId, null, () => ShApi.rpc('shop_dispute_step', { p_job_id: jobId, p_step: step, p_note: note }), `Flagged ${step} for the payroll manager.`);
    },

    // ---------- editor ----------
    async openEditor(jobId) {
      if (this.busy) return;
      this.message('');
      let job = null, items = [];
      if (jobId) {
        // Always reopen from the database so we edit what is really saved.
        try {
          await this.refresh();
          job = this.jobs.find(j => j.id === jobId);
          if (!job) throw new Error('That job no longer exists.');
          items = await ShApi.select('shop_job_line_items', `select=*&job_id=eq.${encodeURIComponent(jobId)}&order=sort_order.asc`);
        } catch (e) { if (!this.handleAuthError(e)) this.message(`Could not open the estimate: ${e.message}`, true); return; }
      }
      const s = this.settings || {};
      this.form = {
        jobId: job?.id || genId(), isNew: !job, expectedUpdatedAt: job?.updated_at || null,
        status: job?.status || 'estimate', estimateNumber: job?.estimate_number ?? null,
        customerId: job?.customer_id || genId(), customerIsNew: !job,
        bikeId: job?.bike_id || genId(), bikeIsNew: !job?.bike_id, noBike: !!job && !job.bike_id,
        photos: [], uploaded: [], dirty: false,
      };
      $('shEstimateForm').reset();
      $('shJobLines').replaceChildren();
      $('shFormErrors').hidden = true;
      $('shFormTitle').textContent = job ? 'Edit estimate' : 'New estimate';
      const nextNo = Math.max(1000, ...this.jobs.map(j => Number(j.estimate_number) || 0)) + 1;
      $('shFormNumber').textContent = job ? wo(job.estimate_number) : `${wo(nextNo)} (confirmed when saved)`;
      $('shStatusText').value = STATUS_LABEL[this.form.status];
      $('shJobDate').value = job?.job_date?.slice(0, 10) || localToday();
      $('shCustomerNotes').value = job?.customer_notes || '';
      $('shNotes').value = job?.notes || '';
      $('shInvoiceNumber').value = job?.invoice_number || '';
      const rate = job ? job.tax_rate : s.default_tax_rate;
      $('shTaxRate').value = rate === null || rate === undefined ? '' : numText(rate);
      $('shTaxApplies').value = (job ? job.tax_applies_to : s.default_tax_applies_to) || 'parts';

      this.renderCustomerOptions();
      $('shCustomerPick').value = job ? job.customer_id : '';
      this.fillCustomer(job ? this.customer(job.customer_id) : null);
      this.renderBikeOptions();
      if (job?.bike_id) { $('shBikePick').value = job.bike_id; this.fillBike(this.bike(job.bike_id)); }
      else if (job) { $('shBikePick').value = '__none'; this.fillBike(null); }
      else { $('shBikePick').value = ''; this.fillBike(null); }

      for (const row of ShCalc.groupJobs(items)) this.addJob(row);
      if (!items.length) this.addJob();
      this.recalc();
      this.show('shEditor');
      $('shSaveBtn').disabled = false; $('shSaveBtn').textContent = 'Save estimate';
    },

    renderCustomerOptions() {
      $('shCustomerPick').replaceChildren(el('option', { value: '', text: 'New customer…' }),
        ...this.customers.map(c => el('option', { value: c.id, text: [c.name, c.phone].filter(Boolean).join(' · ') })));
    },

    renderBikeOptions() {
      const f = this.form;
      const bikes = f.customerIsNew ? [] : this.bikes.filter(b => b.customer_id === f.customerId);
      $('shBikePick').replaceChildren(el('option', { value: '', text: 'New bike…' }),
        ...bikes.map(b => el('option', { value: b.id, text: `${bikeLabel(b) || 'Bike'}${b.vin ? ' · ' + b.vin : ''}` })),
        el('option', { value: '__none', text: 'No bike on this job' }));
    },

    fillCustomer(c) {
      $('shName').value = c?.name || ''; $('shPhone').value = c?.phone || '';
      $('shEmail').value = c?.email || ''; $('shAddress').value = c?.address || '';
    },

    pickCustomer(id) {
      const f = this.form; f.dirty = true;
      if (id) { f.customerId = id; f.customerIsNew = false; this.fillCustomer(this.customer(id)); }
      else { f.customerId = genId(); f.customerIsNew = true; this.fillCustomer(null); }
      this.renderBikeOptions();
      const own = this.bikes.filter(b => b.customer_id === f.customerId);
      if (own.length === 1) { $('shBikePick').value = own[0].id; this.pickBike(own[0].id); }
      else { $('shBikePick').value = ''; this.pickBike(''); }
    },

    fillBike(b) {
      $('shYear').value = numText(b?.year); $('shMake').value = b?.make || ''; $('shModel').value = b?.model || '';
      $('shVin').value = b?.vin || ''; $('shMileage').value = numText(b?.mileage);
      $('shPhotoFiles').value = '';
      this.form.photos = Array.isArray(b?.photo_urls) ? [...b.photo_urls] : [];
      this.form.uploaded = [];
      $('shBikeFields').hidden = this.form.noBike;
      this.renderPhotos();
    },

    pickBike(id) {
      const f = this.form; f.dirty = true;
      f.noBike = id === '__none';
      if (id && id !== '__none') { f.bikeId = id; f.bikeIsNew = false; this.fillBike(this.bike(id)); }
      else { f.bikeId = genId(); f.bikeIsNew = true; this.fillBike(null); }
    },

    // Photos are stored as storage paths ("<bike id>/<file>"). Older records may
    // hold full public URLs; both are loaded through the staff sign-in.
    photoPath(ref) {
      const m = /\/storage\/v1\/object\/(?:public|authenticated|sign)\/shop-bike-photos\/([^?]+)/.exec(ref);
      return m ? m[1].split('/').map(decodeURIComponent).join('/') : ref;
    },

    async photoSrc(ref) {
      const path = this.photoPath(ref);
      if (!this.photoCache.has(path)) {
        this.photoCache.set(path, ShApi.download(BUCKET, path).then(b => URL.createObjectURL(b)).catch(e => { this.photoCache.delete(path); throw e; }));
      }
      return this.photoCache.get(path);
    },

    renderPhotos() {
      const f = this.form; const box = $('shPhotoPreview');
      const saved = f.photos.map((ref, i) => {
        const img = el('img', { alt: `Bike photo ${i + 1}` });
        this.photoSrc(ref).then(src => { img.src = src; }).catch(() => { img.alt = 'Photo unavailable'; img.classList.add('sh-photo-bad'); });
        return el('figure', {}, img, el('button', { type: 'button', class: 'sh-photo-x', title: 'Remove photo', 'aria-label': `Remove photo ${i + 1}`,
          onclick: () => { f.photos.splice(i, 1); f.dirty = true; this.renderPhotos(); } }, '×'));
      });
      const pending = [...$('shPhotoFiles').files].map(file => {
        const img = el('img', { alt: `New photo ${file.name}` }); img.src = URL.createObjectURL(file);
        return el('figure', { class: 'sh-photo-new' }, img, el('figcaption', { text: 'new' }));
      });
      box.replaceChildren(...saved, ...pending);
    },

    // One row per job: name, parts price, our cost (internal), hours (pick or
    // type), labor (hours x the shop rate, filled in), amount.
    addJob(it = {}) {
      const field = (cls, label, props) => el('label', { class: `sh-lf sh-f-${cls}` }, el('span', { text: label }), el('input', { class: `sh-l-${cls}`, 'aria-label': label, autocomplete: 'off', ...props }));
      const row = el('div', { class: 'sh-line sh-lines-job', dataset: { rate: it.rate || '' } },
        field('desc', 'Job', { placeholder: 'e.g. Brake pads', list: 'shJobNames', value: it.name || '' }),
        field('parts', 'Parts', { inputmode: 'decimal', placeholder: '0.00', value: it.parts || '' }),
        field('cost', 'Our cost (internal)', { inputmode: 'decimal', placeholder: '0.00', value: it.cost || '' }),
        field('hours', 'Hours', { inputmode: 'decimal', placeholder: '0', list: 'shHoursList', value: it.hours || '' }),
        el('output', { class: 'sh-l-labor', 'aria-label': 'Labor amount', text: '$0.00' }),
        el('output', { class: 'sh-l-total', 'aria-label': 'Job amount', text: '$0.00' }),
        el('button', { type: 'button', class: 'sh-l-x', 'aria-label': 'Remove job', title: 'Remove job', onclick: () => { row.remove(); this.form.dirty = true; this.recalc(); } }, '×'));
      // Picking a saved job refills its usual hours (only if hours is still empty).
      row.querySelector('.sh-l-desc').addEventListener('change', () => {
        const sj = this.savedJob(row.querySelector('.sh-l-desc').value); const h = row.querySelector('.sh-l-hours');
        if (sj && sj.hours && !h.value.trim()) { h.value = String(Number(sj.hours)); this.form.dirty = true; this.recalc(); }
      });
      $('shJobLines').append(row);
      this.recalc();
      return row;
    },

    // Job rows as typed. Completely empty rows are ignored (not saved).
    readJobs() {
      return [...document.querySelectorAll('#shJobLines .sh-line')].map(r => {
        const v = c => r.querySelector(c)?.value?.trim() ?? '';
        const job = { name: v('.sh-l-desc'), parts: v('.sh-l-parts'), cost: v('.sh-l-cost'), hours: v('.sh-l-hours'), rate: r.dataset.rate || '' };
        return { row: r, job, empty: !job.name && !job.parts && !job.cost && !job.hours };
      });
    },

    recalc() {
      if (!this.form) return null;
      const rows = this.readJobs();
      const used = rows.filter(r => !r.empty);
      const items = ShCalc.jobsToItems(used.map(r => r.job));
      const r = ShCalc.calculate(items, { rate: $('shTaxRate').value, appliesTo: $('shTaxApplies').value });
      // per-row display: add up the (part, labor) items that belong to each job row
      let idx = 0;
      const hoursTotal = used.reduce((n, u) => n + (Number(u.job.hours) || 0), 0);
      for (const u of rows) {
        const out = u.row.querySelector('.sh-l-total'), lab = u.row.querySelector('.sh-l-labor');
        if (u.empty) { out.textContent = ''; lab.textContent = ''; continue; }
        const mine = ShCalc.jobsToItems([u.job]);
        let jobTotal = 0n, labTotal = 0n;
        for (const it of mine) { const t = r.lines[idx++].totalCents; jobTotal += t; if (it.kind === 'labor') labTotal += t; }
        lab.textContent = u.job.hours ? ShCalc.money(labTotal) : '';
        out.textContent = ShCalc.money(jobTotal);
      }
      $('shTotParts').textContent = ShCalc.money(r.partsCents);
      $('shTotLaborLabel').textContent = hoursTotal ? `Labor (${hoursTotal} hr${hoursTotal === 1 ? '' : 's'})` : 'Labor';
      $('shTotLabor').textContent = ShCalc.money(r.laborCents);
      $('shTotTaxLabel').textContent = r.appliesTo === 'none' ? 'Tax (none)' : r.taxRateSet ? `Tax ${$('shTaxRate').value.trim()}% ${TAX_LABEL[r.appliesTo]}` : 'Tax (rate not set)';
      $('shTotTax').textContent = ShCalc.money(r.taxCents);
      $('shTotTotal').textContent = ShCalc.money(r.totalCents);
      $('shTotInternal').textContent = `Internal: our parts cost ${ShCalc.money(r.partsCostCents)} · parts profit ${ShCalc.money(r.partsCents - r.partsCostCents)}`;
      return { calc: r, items, jobs: used.map(u => u.job) };
    },

    validate(calc) {
      const errs = calc.errors.filter(e => !/description is required/.test(e));
      this.readJobs().forEach((u, i) => { if (!u.empty && !u.job.name) errs.push(`Job ${i + 1}: enter what the job is (like Brakes).`); });
      if (!$('shName').value.trim()) errs.unshift('Customer name is required.');
      if (!$('shJobDate').value) errs.push('Date is required.');
      if (!this.form.noBike) {
        if ($('shYear').value.trim() && !/^\d{4}$/.test($('shYear').value.trim())) errs.push('Year must be 4 digits, like 2015.');
        if ($('shMileage').value.trim() && !/^\d{1,9}$/.test($('shMileage').value.trim().replace(/,/g, ''))) errs.push('Mileage must be a whole number.');
      }
      return errs;
    },

    bikeEntered() {
      return ['shYear', 'shMake', 'shModel', 'shVin', 'shMileage'].some(id => $(id).value.trim()) || this.form.photos.length || $('shPhotoFiles').files.length;
    },

    // Upload new photo files once; a retry after a failed save reuses them.
    async uploadPhotos(bikeId) {
      const f = this.form; const files = [...$('shPhotoFiles').files];
      for (let i = f.uploaded.length; i < files.length; i++) {
        const file = files[i];
        const ext = (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] || 'jpg').toLowerCase();
        const path = `${bikeId}/${Date.now()}-${genId().slice(0, 8)}.${ext}`;
        $('shSaveBtn').textContent = `Uploading photo ${i + 1} of ${files.length}…`;
        await ShApi.upload(BUCKET, path, file, file.type || 'image/jpeg');
        f.uploaded.push(path);
      }
      return [...f.photos, ...f.uploaded];
    },

    async save() {
      const f = this.form; if (!f || this.busy) return;
      const { calc, items, jobs } = this.recalc();
      const errs = this.validate(calc);
      const box = $('shFormErrors');
      if (errs.length) { box.replaceChildren(el('strong', { text: 'Fix before saving:' }), el('ul', {}, errs.map(e => el('li', { text: e })))); box.hidden = false; box.scrollIntoView?.({ block: 'center' }); return; }
      box.hidden = true;
      if (!calc.taxRateSet && calc.appliesTo !== 'none' && !root.confirm('No tax rate is entered, so this estimate will show $0.00 tax. Save anyway?')) return;

      this.busy = true; const btn = $('shSaveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const withBike = !f.noBike && (!f.bikeIsNew || this.bikeEntered());
        const photos = withBike ? await this.uploadPhotos(f.bikeId) : [];
        btn.textContent = 'Saving…';
        const res = await ShApi.rpc('shop_save_estimate', {
          p_job_id: f.jobId, p_customer_id: f.customerId,
          p_customer: { name: $('shName').value, phone: $('shPhone').value, email: $('shEmail').value, address: $('shAddress').value },
          p_bike_id: withBike ? f.bikeId : null,
          p_bike: withBike ? { vin: $('shVin').value, make: $('shMake').value, model: $('shModel').value, year: $('shYear').value, mileage: $('shMileage').value.replace(/,/g, ''), photos } : null,
          p_job: {
            status: f.status, job_date: $('shJobDate').value, invoice_number: $('shInvoiceNumber').value,
            work_description: jobs.map(j => j.name).filter(Boolean).join(', '), customer_notes: $('shCustomerNotes').value, notes: $('shNotes').value,
            tax_rate: $('shTaxRate').value.trim(), tax_applies_to: $('shTaxApplies').value,
            expected_updated_at: f.expectedUpdatedAt,
          },
          p_items: items,
        });
        if (ShCalc.centsOf(res.total_amount) !== calc.totalCents) console.warn('Server total differs from screen total', res.total_amount, calc.total);
        f.dirty = false;
        // Remember these jobs and their hours for next time (best effort, never blocks the save).
        try { await ShApi.rpc('shop_remember_jobs', { p_jobs: jobs.map(j => ({ name: j.name, hours: j.hours })) }); await this.loadSavedJobs(); } catch { /* shop-007 not installed yet */ }
        this.message(`${wo(res.estimate_number)} saved.`);
        this.busy = false;
        await this.openPrint(res.job_id);
      } catch (e) {
        if (!this.handleAuthError(e)) {
          box.replaceChildren(el('strong', { text: 'Not saved. ' }), document.createTextNode(e.message || 'Unknown error.'));
          box.hidden = false; box.scrollIntoView?.({ block: 'center' });
        }
      } finally { this.busy = false; btn.disabled = false; btn.textContent = 'Save estimate'; }
    },

    // ---------- customer copy ----------
    async openPrint(jobId) {
      this.message('', false);
      let job, items;
      try {
        await this.refresh();
        job = this.jobs.find(j => j.id === jobId);
        if (!job) throw new Error('That job no longer exists.');
        items = await ShApi.select('shop_job_line_items', `select=kind,description,quantity,unit_price,sort_order&job_id=eq.${encodeURIComponent(jobId)}&order=sort_order.asc`);
      } catch (e) { if (!this.handleAuthError(e)) this.message(`Could not open the estimate: ${e.message}`, true); return; }
      this.printJobId = jobId;
      $('shDoc').replaceChildren(...this.buildDoc(job, items).filter(Boolean));
      document.title = `SIC Cycles ${job.status === 'complete' ? 'Invoice' : 'Estimate'} ${wo(job.estimate_number)} — ${this.customer(job.customer_id)?.name || ''}`;
      this.show('shPrintView');
    },

    // Builds the customer copy from SAVED data only. Never includes parts
    // cost, profit, invoice-internal fields or internal notes.
    buildDoc(job, items) {
      const s = this.settings || {}; const c = this.customer(job.customer_id) || {}; const b = this.bike(job.bike_id);
      const jobs = ShCalc.groupJobs(items);
      const jobRow = j => el('tr', {},
        el('td', { text: j.name }),
        el('td', { class: 'num', text: j.partsCents ? ShCalc.money(j.partsCents) : '' }),
        el('td', { class: 'num', text: j.hours ? `${j.hours} hr` : '' }),
        el('td', { class: 'num', text: j.laborCents ? ShCalc.money(j.laborCents) : '' }),
        el('td', { class: 'num', text: ShCalc.money(j.totalCents) }));
      const taxLabel = job.tax_applies_to === 'none' ? 'Tax' : job.tax_rate === null || job.tax_rate === undefined ? 'Tax (not included)' : `Tax ${numText(job.tax_rate)}% ${TAX_LABEL[job.tax_applies_to]}`;
      const isInv = job.status === 'complete';
      const contact = [s.phone, s.email].filter(Boolean).join(' · ');
      const bikeBits = b ? [bikeLabel(b), b.vin ? `VIN ${b.vin}` : '', b.mileage !== null && b.mileage !== undefined ? `${Number(b.mileage).toLocaleString('en-US')} mi` : ''].filter(Boolean) : [];
      return [
        el('header', { class: 'sh-doc-head' },
          el('div', {},
            el('img', { class: 'sh-doc-logo', src: 'sic-logo.png', alt: s.business_name || 'SIC Cycles' }),
            s.address ? el('div', { class: 'sh-doc-addr', text: s.address }) : null,
            contact ? el('div', { text: contact }) : null),
          el('div', { class: 'sh-doc-meta' },
            el('div', { class: 'sh-doc-title', text: isInv ? 'INVOICE' : 'ESTIMATE' }),
            el('div', { text: wo(job.estimate_number) }),
            el('div', { text: `Date ${fmtDate(job.job_date)}` }),
            isInv ? el('div', { text: `Status: ${{ paid: 'Paid', partial: 'Partial payment', unpaid: 'Unpaid' }[job.payment_status] || 'Unpaid'}` }) : null)),
        el('div', { class: 'sh-doc-parties' },
          el('div', {}, el('h3', { text: 'Customer' }), el('div', { text: c.name || '' }),
            c.phone ? el('div', { text: c.phone }) : null, c.email ? el('div', { text: c.email }) : null,
            c.address ? el('div', { text: c.address }) : null),
          el('div', {}, el('h3', { text: 'Motorcycle' }), ...(bikeBits.length ? bikeBits.map(t => el('div', { text: t })) : [el('div', { text: '—' })]))),
        el('table', { class: 'sh-doc-table' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Work to be done' }), el('th', { class: 'num', text: 'Parts' }), el('th', { class: 'num', text: 'Hours' }), el('th', { class: 'num', text: 'Labor' }), el('th', { class: 'num', text: 'Amount' }))),
          el('tbody', {}, ...(jobs.length ? jobs.map(jobRow) : [el('tr', {}, el('td', { colspan: '5', text: 'No work listed.' }))])),
          jobs.length ? el('tfoot', {}, el('tr', { class: 'sh-doc-sum' }, el('td', { text: 'Subtotal' }),
            el('td', { class: 'num', text: money(job.parts_amount) }),
            el('td', { class: 'num', text: jobs.some(j => j.hours) ? `${jobs.reduce((n, j) => n + (Number(j.hours) || 0), 0)} hr` : '' }),
            el('td', { class: 'num', text: money(job.labor_amount) }),
            el('td', { class: 'num', text: ShCalc.money(jobs.reduce((n, j) => n + j.totalCents, 0n)) }))) : null),
        el('table', { class: 'sh-doc-totals' }, el('tbody', {},
          el('tr', {}, el('td', { text: taxLabel }), el('td', { class: 'num', text: money(job.tax_amount) })),
          el('tr', { class: 'sh-doc-grand' }, el('td', { text: isInv ? 'Total' : 'Estimated total' }), el('td', { class: 'num', text: money(job.total_amount) })))),
        job.customer_notes ? el('div', { class: 'sh-doc-block' }, el('h3', { text: 'Notes' }), el('p', { class: 'sh-pre', text: job.customer_notes })) : null,
        s.estimate_terms ? el('div', { class: 'sh-doc-block sh-doc-terms' }, el('p', { class: 'sh-pre', text: s.estimate_terms })) : null,
        isInv ? null : el('p', { class: 'sh-doc-auth', text: 'I authorize the work listed above.' }),
        el('div', { class: 'sh-doc-sign' },
          el('div', {}, el('span', { text: 'Authorized by (signature)' })), el('div', {}, el('span', { text: 'Date' }))),
      ];
    },

    // ---------- settings ----------
    async openSettings() {
      if (!this.confirmLeave()) return;
      if (!(await this.refresh())) return;
      const s = this.settings || {};
      $('shSetName').value = s.business_name || 'SIC Cycles'; $('shSetPhone').value = s.phone || '';
      $('shSetEmail').value = s.email || ''; $('shSetAddress').value = s.address || '';
      $('shSetTaxRate').value = s.default_tax_rate === null || s.default_tax_rate === undefined ? '' : numText(s.default_tax_rate);
      $('shSetTaxApplies').value = s.default_tax_applies_to || 'parts'; $('shSetTerms').value = s.estimate_terms || '';
      this.show('shSettings');
    },

    async saveSettings() {
      if (this.busy) return;
      const rate = $('shSetTaxRate').value.trim();
      if (rate && Number.isNaN(ShCalc.parseScaled(rate, 3))) { this.message('Tax rate must be a number like 8.7', true); return; }
      this.busy = true; const btn = $('shSetSave'); btn.disabled = true;
      try {
        await ShApi.rpc('shop_update_settings', { p_settings: {
          business_name: $('shSetName').value, phone: $('shSetPhone').value, email: $('shSetEmail').value,
          address: $('shSetAddress').value, default_tax_rate: rate, default_tax_applies_to: $('shSetTaxApplies').value,
          estimate_terms: $('shSetTerms').value } });
        this.busy = false;
        await this.refresh(); this.message('Settings saved.'); this.show('shList');
      } catch (e) { if (!this.handleAuthError(e)) this.message(`Settings not saved: ${e.message}`, true); }
      finally { this.busy = false; btn.disabled = false; }
    },
  };
  root.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})(typeof window !== 'undefined' ? window : globalThis);
