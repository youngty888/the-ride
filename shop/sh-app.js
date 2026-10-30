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
  const NEXT = { estimate: ['in_progress', 'Start job'], in_progress: ['complete', 'Mark complete'] };
  const TAX_LABEL = { parts: 'on parts', parts_labor: 'on parts and labor', none: '' };

  const genId = () => (root.crypto?.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)));
  const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
  const money = v => ShCalc.money(ShCalc.centsOf(v ?? 0));
  const numText = v => { if (v === null || v === undefined || v === '') return ''; const n = Number(v); return Number.isInteger(n) ? String(n) : String(n); };
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
    user: null, jobs: [], customers: [], bikes: [], settings: null,
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
      $('shNewJobBtn').addEventListener('click', () => this.openEditor(null));
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
      $('shAddPart').addEventListener('click', () => { this.addLine('part'); this.form.dirty = true; });
      $('shAddLabor').addEventListener('click', () => { this.addLine('labor'); this.form.dirty = true; });
      $('shPhotoFiles').addEventListener('change', () => this.renderPhotos());
      $('shPrintBtn').addEventListener('click', () => root.print());
      $('shPrintBack').addEventListener('click', () => this.show('shList'));
      $('shPrintEdit').addEventListener('click', () => this.openEditor(this.printJobId));
      $('shSettingsForm').addEventListener('submit', e => { e.preventDefault(); this.saveSettings(); });
      $('shSetCancel').addEventListener('click', () => this.show('shList'));
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
      if (await this.refresh()) this.show('shList');
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
      $('shNav').hidden = true; $('shJobsList').replaceChildren();
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
        this.renderJobs();
        return true;
      } catch (e) {
        if (!this.handleAuthError(e)) this.message(`Could not load shop records: ${e.message}`, true);
        return false;
      }
    },

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
        return [c.name, c.phone, c.email, b.vin, bikeLabel(b), j.estimate_number, j.invoice_number, j.work_description]
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
              el('span', { text: `#${j.estimate_number ?? '—'}` }),
              el('span', { text: fmtDate(j.job_date) }),
              el('span', { class: 'sh-pill', text: STATUS_LABEL[j.status] || j.status }),
              b ? el('span', { text: bikeLabel(b) || b.vin || '' }) : null),
            j.work_description ? el('div', { class: 'sh-job-desc', text: j.work_description }) : null),
          el('div', { class: 'sh-job-actions' },
            el('button', { type: 'button', class: 'sh-btn', text: 'View / Print', onclick: () => this.openPrint(j.id) }),
            el('button', { type: 'button', class: 'sh-btn', text: 'Edit', onclick: () => this.openEditor(j.id) }),
            next ? el('button', { type: 'button', class: 'sh-btn sh-btn-step', text: next[1], onclick: ev => this.setStatus(j.id, next[0], ev.currentTarget) }) : null));
      }));
    },

    async setStatus(jobId, status, btn) {
      if (this.busy) return;
      const j = this.jobs.find(x => x.id === jobId);
      if (status === 'complete' && !root.confirm(`Mark #${j?.estimate_number} complete?`)) return;
      this.busy = true; if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        await ShApi.rpc('shop_set_job_status', { p_job_id: jobId, p_status: status });
        this.message(`#${j?.estimate_number} is now ${STATUS_LABEL[status].toLowerCase()}.`);
      } catch (e) {
        if (!this.handleAuthError(e)) this.message(`Status not changed: ${e.message}`, true);
      } finally { this.busy = false; await this.refresh(); }
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
      $('shPartLines').replaceChildren(); $('shLaborLines').replaceChildren();
      $('shFormErrors').hidden = true;
      $('shFormTitle').textContent = job ? 'Edit estimate' : 'New estimate';
      $('shFormNumber').textContent = job ? `#${job.estimate_number}` : 'Number is assigned when saved';
      $('shStatusText').value = STATUS_LABEL[this.form.status];
      $('shJobDate').value = job?.job_date?.slice(0, 10) || localToday();
      $('shWorkDescription').value = job?.work_description || '';
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

      for (const it of items) this.addLine(it.kind, it);
      if (!items.length) { this.addLine('part'); this.addLine('labor'); }
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

    addLine(kind, it = {}) {
      const isPart = kind === 'part';
      const field = (cls, label, props) => el('label', { class: `sh-lf sh-f-${cls}` }, el('span', { text: label }), el('input', { class: `sh-l-${cls}`, 'aria-label': label, autocomplete: 'off', ...props }));
      const moneyText = v => (v === undefined || v === null || v === '') ? '' : Number(v).toFixed(2);
      const row = el('div', { class: `sh-line sh-lines-${kind}`, dataset: { kind } },
        field('desc', isPart ? 'Part description' : 'Labor description', { placeholder: isPart ? 'Part' : 'Labor', value: it.description || '' }),
        field('qty', isPart ? 'Qty' : 'Hours', { inputmode: 'decimal', value: it.quantity !== undefined ? numText(it.quantity) : '1' }),
        field('price', isPart ? 'Price each' : 'Rate / hr', { inputmode: 'decimal', placeholder: '0.00', value: moneyText(it.unit_price) }),
        isPart ? field('cost', 'Our cost each (internal)', { inputmode: 'decimal', placeholder: '0.00', value: Number(it.unit_cost) ? moneyText(it.unit_cost) : '' }) : null,
        el('output', { class: 'sh-l-total', text: '$0.00' }),
        el('button', { type: 'button', class: 'sh-l-x', 'aria-label': 'Remove line', title: 'Remove line', onclick: () => { row.remove(); this.form.dirty = true; this.recalc(); } }, '×'));
      $(isPart ? 'shPartLines' : 'shLaborLines').append(row);
      this.recalc();
      return row;
    },

    // Line rows -> items. Completely empty rows are ignored (not saved).
    readLines() {
      const rows = [...document.querySelectorAll('#shPartLines .sh-line, #shLaborLines .sh-line')];
      const out = [];
      for (const r of rows) {
        const v = c => r.querySelector(c)?.value?.trim() ?? '';
        const item = { kind: r.dataset.kind, description: v('.sh-l-desc'), quantity: v('.sh-l-qty'), unit_price: v('.sh-l-price'), unit_cost: r.dataset.kind === 'part' ? v('.sh-l-cost') : '' };
        const empty = !item.description && !item.unit_price && !item.unit_cost && (item.quantity === '' || item.quantity === '1');
        out.push({ row: r, item, empty });
      }
      return out;
    },

    recalc() {
      if (!this.form) return null;
      const lines = this.readLines();
      const used = lines.filter(l => !l.empty);
      const r = ShCalc.calculate(used.map(l => l.item), { rate: $('shTaxRate').value, appliesTo: $('shTaxApplies').value });
      lines.forEach(l => { l.row.querySelector('.sh-l-total').textContent = l.empty ? '' : ShCalc.money(r.lines[used.indexOf(l)].totalCents); });
      $('shTotParts').textContent = ShCalc.money(r.partsCents);
      $('shTotLabor').textContent = ShCalc.money(r.laborCents);
      $('shTotTaxLabel').textContent = r.appliesTo === 'none' ? 'Tax (none)' : r.taxRateSet ? `Tax ${$('shTaxRate').value.trim()}% ${TAX_LABEL[r.appliesTo]}` : 'Tax (rate not set)';
      $('shTotTax').textContent = ShCalc.money(r.taxCents);
      $('shTotTotal').textContent = ShCalc.money(r.totalCents);
      $('shTotInternal').textContent = `Internal: our parts cost ${ShCalc.money(r.partsCostCents)} · parts profit ${ShCalc.money(r.partsCents - r.partsCostCents)}`;
      return { calc: r, items: used.map(l => l.item) };
    },

    validate(calc) {
      const errs = [...calc.errors];
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
      const { calc, items } = this.recalc();
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
            work_description: $('shWorkDescription').value, customer_notes: $('shCustomerNotes').value, notes: $('shNotes').value,
            tax_rate: $('shTaxRate').value.trim(), tax_applies_to: $('shTaxApplies').value,
            expected_updated_at: f.expectedUpdatedAt,
          },
          p_items: items,
        });
        if (ShCalc.centsOf(res.total_amount) !== calc.totalCents) console.warn('Server total differs from screen total', res.total_amount, calc.total);
        f.dirty = false;
        this.message(`Estimate #${res.estimate_number} saved.`);
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
      document.title = `SIC Cycles Estimate ${job.estimate_number} — ${this.customer(job.customer_id)?.name || ''}`;
      this.show('shPrintView');
    },

    // Builds the customer copy from SAVED data only. Never includes parts
    // cost, profit, invoice-internal fields or internal notes.
    buildDoc(job, items) {
      const s = this.settings || {}; const c = this.customer(job.customer_id) || {}; const b = this.bike(job.bike_id);
      const lines = kind => items.filter(i => i.kind === kind);
      const lineRow = i => el('tr', {},
        el('td', { text: i.description }), el('td', { class: 'num', text: numText(i.quantity) }),
        el('td', { class: 'num', text: money(i.unit_price) }),
        el('td', { class: 'num', text: ShCalc.money(ShCalc.calculate([{ ...i, quantity: String(i.quantity), unit_price: String(i.unit_price) }]).lines[0].totalCents) }));
      const section = (title, qtyLabel, priceLabel, rows) => rows.length ? [
        el('tr', { class: 'sh-doc-group' }, el('th', { text: title }), el('th', { class: 'num', text: qtyLabel }), el('th', { class: 'num', text: priceLabel }), el('th', { class: 'num', text: 'Amount' })),
        ...rows.map(lineRow)] : [];
      const taxLabel = job.tax_applies_to === 'none' ? 'Tax' : job.tax_rate === null || job.tax_rate === undefined ? 'Tax (not included)' : `Tax ${numText(job.tax_rate)}% ${TAX_LABEL[job.tax_applies_to]}`;
      const contact = [s.phone, s.email].filter(Boolean).join(' · ');
      const bikeBits = b ? [bikeLabel(b), b.vin ? `VIN ${b.vin}` : '', b.mileage !== null && b.mileage !== undefined ? `${Number(b.mileage).toLocaleString('en-US')} mi` : ''].filter(Boolean) : [];
      return [
        el('header', { class: 'sh-doc-head' },
          el('div', {},
            el('div', { class: 'sh-doc-brand', text: s.business_name || 'SIC Cycles' }),
            s.address ? el('div', { class: 'sh-doc-addr', text: s.address }) : null,
            contact ? el('div', { text: contact }) : null),
          el('div', { class: 'sh-doc-meta' },
            el('div', { class: 'sh-doc-title', text: 'ESTIMATE' }),
            el('div', { text: `No. ${job.estimate_number}` }),
            el('div', { text: `Date ${fmtDate(job.job_date)}` }))),
        el('div', { class: 'sh-doc-parties' },
          el('div', {}, el('h3', { text: 'Customer' }), el('div', { text: c.name || '' }),
            c.phone ? el('div', { text: c.phone }) : null, c.email ? el('div', { text: c.email }) : null,
            c.address ? el('div', { text: c.address }) : null),
          el('div', {}, el('h3', { text: 'Motorcycle' }), ...(bikeBits.length ? bikeBits.map(t => el('div', { text: t })) : [el('div', { text: '—' })]))),
        job.work_description ? el('div', { class: 'sh-doc-block' }, el('h3', { text: 'Work to be done' }), el('p', { class: 'sh-pre', text: job.work_description })) : null,
        el('table', { class: 'sh-doc-table' }, el('tbody', {},
          ...section('Parts', 'Qty', 'Price', lines('part')),
          ...section('Labor', 'Hours', 'Rate', lines('labor')),
          !items.length ? el('tr', {}, el('td', { colspan: '4', text: 'No line items.' })) : null)),
        el('table', { class: 'sh-doc-totals' }, el('tbody', {},
          el('tr', {}, el('td', { text: 'Parts' }), el('td', { class: 'num', text: money(job.parts_amount) })),
          el('tr', {}, el('td', { text: 'Labor' }), el('td', { class: 'num', text: money(job.labor_amount) })),
          el('tr', {}, el('td', { text: taxLabel }), el('td', { class: 'num', text: money(job.tax_amount) })),
          el('tr', { class: 'sh-doc-grand' }, el('td', { text: 'Estimated total' }), el('td', { class: 'num', text: money(job.total_amount) })))),
        job.customer_notes ? el('div', { class: 'sh-doc-block' }, el('h3', { text: 'Notes' }), el('p', { class: 'sh-pre', text: job.customer_notes })) : null,
        s.estimate_terms ? el('div', { class: 'sh-doc-block sh-doc-terms' }, el('p', { class: 'sh-pre', text: s.estimate_terms })) : null,
        el('div', { class: 'sh-doc-sign' },
          el('div', {}, el('span', { text: 'Customer approval' })), el('div', {}, el('span', { text: 'Date' }))),
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
