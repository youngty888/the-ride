/* Shop document library.
   One list of every shop document: estimates and invoices (shop_jobs),
   finance agreements / payment plans (shop_payment_plans, if shop-009 is
   installed), and the forms kept in shop_documents (Syndicate meetings,
   customer intake forms, legal documents). Filters by type, customer, bike,
   date and text. Also holds the customer intake form and the legal document
   editor. Every write goes through a database function; the database checks
   staff access. Customer-entered text is written with textContent only. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const BUCKET = 'shop-documents';
  const MAX_FILE = 20 * 1024 * 1024;
  const KIND = { estimate: 'Estimate', invoice: 'Invoice', intake: 'Intake form', meeting: 'Syndicate meeting', plan: 'Finance agreement', legal: 'Legal', other: 'Other' };
  const TEMPLATES = {
    blank: '',
    repair: [
      'REPAIR AUTHORIZATION (sample wording, have a lawyer review before use)',
      '',
      'I authorize SIC Cycles to perform the work listed on estimate ______ on the bike described above.',
      'I understand the estimate total is $______. SIC Cycles will contact me for approval before doing any work that would raise the total by more than $______.',
      'Parts replaced will be returned to me on request unless they are warranty or core returns.',
      'Payment is due when the work is complete and before the bike is released.',
      'SIC Cycles may road test the bike as needed to diagnose or confirm the repair.',
    ].join('\n'),
    storage: [
      'STORAGE POLICY (sample wording, have a lawyer review before use)',
      '',
      'Bikes must be picked up within ______ days after SIC Cycles tells the customer the work is complete.',
      'After that, a storage fee of $______ per day applies until the bike is picked up and paid for.',
      'SIC Cycles is not responsible for loss or damage to bikes left past the pickup date, except as the law requires.',
      'Bikes left more than ______ days may be handled as abandoned property under Arizona law.',
    ].join('\n'),
  };

  const genId = () => (root.crypto?.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)));
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
  const money = v => (v === null || v === undefined || v === '') ? '' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const bikeLabel = b => b ? [b.year, b.make, b.model].filter(Boolean).join(' ') || (b.vin ? `VIN ${b.vin}` : 'Bike') : '';
  const val = id => $(id).value.trim();
  const safeName = n => (String(n || 'file').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-90) || 'file');

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  const App = {
    docs: [], jobs: [], plans: null, customers: [], bikes: [], cur: null, busy: false, dirty: false,

    async init() {
      this.bind();
      this.show('dcLoading');
      try { await ShApi.verify(); }
      catch (e) { return this.signedOut(e.status && e.status !== 401 && e.status !== 403 ? `Could not reach the shop server: ${e.message}` : null); }
      let ok = false;
      try { ok = (await ShApi.rpc('shop_has_staff_access', {})) === true; } catch (e) { return this.signedOut(`Could not check shop access: ${e.message}`); }
      if (!ok) return this.signedOut(null, 'This account is not on the shop staff list.');
      $('dcNav').hidden = false;
      if (!(await this.refresh())) return;
      this.route();
    },

    signedOut(err, text) {
      if (err) this.message(err, true);
      if (text) $('dcSignedOutText').textContent = text;
      this.show('dcSignedOut');
    },

    bind() {
      ['dcSearch', 'dcFrom', 'dcTo'].forEach(id => $(id).addEventListener('input', () => this.renderList()));
      ['dcType', 'dcBike', 'dcArchived'].forEach(id => $(id).addEventListener('change', () => this.renderList()));
      $('dcCustomer').addEventListener('change', () => { this.fillBikeFilter(); this.renderList(); });
      $('dcReset').addEventListener('click', () => {
        ['dcSearch', 'dcFrom', 'dcTo', 'dcType', 'dcCustomer'].forEach(id => { $(id).value = ''; });
        $('dcArchived').checked = false; this.fillBikeFilter(); this.renderList();
      });
      // intake
      $('dcIntakeForm').addEventListener('submit', e => { e.preventDefault(); this.saveIntake(); });
      $('dcIntakeForm').addEventListener('input', () => { this.dirty = true; });
      $('inCustomerPick').addEventListener('change', () => this.pickIntakeCustomer());
      $('inBikePick').addEventListener('change', () => this.pickIntakeBike());
      $('inPrint').addEventListener('click', () => root.print());
      $('inArchive').addEventListener('click', () => this.archive());
      $('inEstimate').addEventListener('click', () => { root.location.href = './?new=estimate'; });
      // legal
      $('dcLegalForm').addEventListener('submit', e => { e.preventDefault(); this.saveLegal(); });
      $('dcLegalForm').addEventListener('input', () => { this.dirty = true; });
      $('lgTemplate').addEventListener('change', () => this.applyTemplate());
      $('lgCustomer').addEventListener('change', () => { this.fillBikeSelect($('lgBike'), $('lgCustomer').value, ''); this.fillJobSelect(''); });
      $('lgTitle').addEventListener('input', () => { $('lgPrintTitle').textContent = val('lgTitle') || 'Legal document'; });
      $('lgPrint').addEventListener('click', () => root.print());
      $('lgArchive').addEventListener('click', () => this.archive());
      $('lgFileView').addEventListener('click', () => this.viewFile());
      root.addEventListener('beforeunload', e => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } });
    },

    show(id) {
      for (const v of document.querySelectorAll('.dc-view')) v.hidden = v.id !== id;
      root.scrollTo?.(0, 0);
    },
    message(text, isError = false) {
      const m = $('dcMsg'); m.textContent = text || ''; m.hidden = !text; m.classList.toggle('sh-msg-error', !!isError);
    },

    async refresh() {
      try {
        const [docs, jobs, customers, bikes] = await Promise.all([
          ShApi.select('shop_documents', 'select=*&order=doc_date.desc'),
          ShApi.select('shop_jobs', 'select=id,estimate_number,invoice_number,customer_id,bike_id,status,payment_status,job_date,total_amount,work_description&order=job_date.desc'),
          ShApi.select('shop_customers', 'select=id,name,phone,email,address&order=name.asc'),
          ShApi.select('shop_bikes', 'select=id,customer_id,vin,make,model,year,mileage'),
        ]);
        const day = v => (v ? String(v).slice(0, 10) : v);       // dates as YYYY-MM-DD
        docs.forEach(d => { d.doc_date = day(d.doc_date); }); jobs.forEach(j => { j.job_date = day(j.job_date); });
        this.docs = docs; this.jobs = jobs; this.customers = customers; this.bikes = bikes;
        // Payment plans live in their own table (shop-009). If that is not on the server yet, skip them.
        try { this.plans = (await ShApi.select('shop_payment_plans', 'select=id,customer_id,bike_id,item,sale_date,sale_price,status&order=sale_date.desc')).map(p => ({ ...p, sale_date: day(p.sale_date) })); }
        catch { this.plans = null; }
        this.fillFilters();
        return true;
      } catch (e) {
        if (e.status === 401) { this.signedOut('Your sign-in expired. Sign in again on the shop page.', null); return false; }
        if (/shop_documents/.test(e.message || '') || e.status === 404) this.message('The document library is not set up on the server yet (ask Tyler to run the shop-010 SQL file).', true);
        else this.message(`Could not load documents: ${e.message}`, true);
        this.show('dcList');
        return false;
      }
    },

    route() {
      const q = new URLSearchParams(root.location.search);
      const neu = q.get('new'); const doc = q.get('doc');
      if (q.get('type')) $('dcType').value = q.get('type');
      if (neu === 'intake') return this.openIntake(null);
      if (neu === 'legal') return this.openLegal(null);
      if (doc) {
        const d = this.docs.find(x => x.id === doc);
        if (!d) { this.message('That document was not found.', true); return this.openList(); }
        return this.openDoc(d);
      }
      this.openList();
    },

    openDoc(d) {
      if (d.doc_type === 'intake') return this.openIntake(d);
      if (d.doc_type === 'meeting') { root.location.href = `syndicate.html?doc=${encodeURIComponent(d.id)}`; return; }
      return this.openLegal(d);
    },

    // ---------- library ----------
    customer(id) { return this.customers.find(c => c.id === id) || null; },
    bike(id) { return this.bikes.find(b => b.id === id) || null; },

    fillFilters() {
      const sel = $('dcCustomer'); const keep = sel.value;
      sel.replaceChildren(el('option', { value: '', text: 'All customers' }), ...this.customers.map(c => el('option', { value: c.id, text: c.name + (c.phone ? ` · ${c.phone}` : '') })));
      sel.value = this.customers.some(c => c.id === keep) ? keep : '';
      this.fillBikeFilter();
      if (!this.plans) $('dcType').querySelector('option[value=plan]').textContent = 'Finance agreements (not set up yet)';
    },
    fillBikeFilter() {
      const sel = $('dcBike'); const keep = sel.value; const cid = $('dcCustomer').value;
      const list = this.bikes.filter(b => !cid || b.customer_id === cid);
      sel.replaceChildren(el('option', { value: '', text: 'All bikes' }), ...list.map(b => el('option', { value: b.id, text: bikeLabel(b) + (b.vin ? ` · …${String(b.vin).slice(-6)}` : '') })));
      sel.value = list.some(b => b.id === keep) ? keep : '';
    },

    rows() {
      const out = [];
      for (const j of this.jobs) {
        out.push({ kind: 'estimate', label: j.status === 'estimate' ? KIND.estimate : KIND.invoice, archived: false,
          title: `IV#${j.estimate_number ?? '—'}${j.work_description ? ' · ' + j.work_description : ''}`,
          date: j.job_date, customer_id: j.customer_id, bike_id: j.bike_id,
          extra: [money(j.total_amount), j.status === 'estimate' ? '' : ({ unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid' }[j.payment_status] || '')],
          href: `./?job=${encodeURIComponent(j.id)}`, search: [j.estimate_number, j.invoice_number, j.work_description].join(' ') });
      }
      for (const p of this.plans || []) {
        out.push({ kind: 'plan', label: KIND.plan, archived: p.status === 'cancelled', title: p.item, date: p.sale_date,
          customer_id: p.customer_id, bike_id: p.bike_id, extra: [money(p.sale_price), p.status === 'paid_off' ? 'Paid off' : p.status === 'cancelled' ? 'Cancelled' : 'Active'],
          href: `payments.html?plan=${encodeURIComponent(p.id)}`, search: p.item });
      }
      for (const d of this.docs) {
        const kind = KIND[d.doc_type] ? d.doc_type : 'other';
        out.push({ kind, label: d.doc_type === 'legal' && d.data?.category ? `Legal · ${d.data.category}` : KIND[kind], archived: !!d.archived,
          title: d.title, date: d.doc_date || String(d.created_at || '').slice(0, 10), customer_id: d.customer_id, bike_id: d.bike_id,
          extra: [d.file_name ? 'File attached' : ''], href: d.doc_type === 'meeting' ? `syndicate.html?doc=${encodeURIComponent(d.id)}` : `docs.html?doc=${encodeURIComponent(d.id)}`,
          search: [d.title, d.data?.category, d.file_name, d.data?.reason, d.data?.insurance_company].join(' ') });
      }
      return out;
    },

    renderList() {
      const type = $('dcType').value, cid = $('dcCustomer').value, bid = $('dcBike').value;
      const from = $('dcFrom').value, to = $('dcTo').value, showArch = $('dcArchived').checked;
      const words = $('dcSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
      const list = this.rows().filter(r => {
        if (type && r.kind !== type) return false;
        if (!showArch && r.archived) return false;
        if (cid && r.customer_id !== cid) return false;
        if (bid && r.bike_id !== bid) return false;
        if (from && (!r.date || r.date < from)) return false;
        if (to && (!r.date || r.date > to)) return false;
        if (words.length) {
          const c = this.customer(r.customer_id) || {}; const b = this.bike(r.bike_id) || {};
          const hay = [r.title, r.label, r.search, c.name, c.phone, c.email, bikeLabel(b), b.vin].join(' ').toLowerCase();
          if (!words.every(w => hay.includes(w))) return false;
        }
        return true;
      }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const box = $('dcRows');
      box.replaceChildren(...list.map(r => {
        const c = this.customer(r.customer_id); const b = this.bike(r.bike_id);
        return el('a', { class: 'dc-row' + (r.archived ? ' dc-archived' : ''), href: r.href, dataset: { kind: r.kind } },
          el('div', {}, el('span', { class: 'dc-kind', text: r.label + (r.archived ? ' · archived' : '') }), el('div', { class: 'dc-row-title', text: r.title })),
          el('div', { class: 'dc-row-sub', text: [c?.name, bikeLabel(b)].filter(Boolean).join(' · ') || (r.kind === 'meeting' ? 'Shop meeting' : 'No customer linked') }),
          el('div', { class: 'dc-row-meta' }, fmtDate(r.date), ...r.extra.filter(Boolean).map(x => [el('br'), x])));
      }));
      if (!list.length) box.append(el('div', { class: 'dc-empty', text: 'No documents match. Clear the filters or make one with + New on the shop page.' }));
      $('dcCount').textContent = `${list.length} document${list.length === 1 ? '' : 's'}`;
    },

    openList() { this.cur = null; this.renderList(); this.show('dcList'); },

    // ---------- shared pickers ----------
    fillCustomerSelect(sel, chosen, blankText) {
      sel.replaceChildren(el('option', { value: '', text: blankText }), ...this.customers.map(c => el('option', { value: c.id, text: c.name + (c.phone ? ` · ${c.phone}` : '') })));
      sel.value = chosen && this.customers.some(c => c.id === chosen) ? chosen : '';
    },
    fillBikeSelect(sel, cid, chosen, blankText = 'No bike') {
      const list = cid ? this.bikes.filter(b => b.customer_id === cid) : [];
      sel.replaceChildren(el('option', { value: '', text: blankText }), ...list.map(b => el('option', { value: b.id, text: bikeLabel(b) + (b.vin ? ` · VIN …${String(b.vin).slice(-6)}` : '') })));
      sel.value = chosen && list.some(b => b.id === chosen) ? chosen : '';
    },
    fillJobSelect(chosen) {
      const cid = $('lgCustomer').value; const sel = $('lgJob');
      const list = this.jobs.filter(j => !cid || j.customer_id === cid);
      sel.replaceChildren(el('option', { value: '', text: 'No job' }), ...list.map(j => el('option', { value: j.id, text: `IV#${j.estimate_number ?? '—'} · ${fmtDate(j.job_date)}${j.work_description ? ' · ' + j.work_description.slice(0, 40) : ''}` })));
      sel.value = chosen && list.some(j => j.id === chosen) ? chosen : '';
    },
    stamp(d) {
      if (!d) return '';
      return `Saved ${new Date(d.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}${d.archived ? ' · archived' : ''}`;
    },

    // ---------- customer intake ----------
    openIntake(d) {
      this.cur = d ? { ...d } : { id: genId(), doc_type: 'intake', isNew: true };
      const data = d?.data || {};
      const c = d ? this.customer(d.customer_id) : null; const b = d ? this.bike(d.bike_id) : null;
      this.fillCustomerSelect($('inCustomerPick'), c?.id, '+ New customer');
      this.fillBikeSelect($('inBikePick'), c?.id, b?.id, '+ New bike');
      this.setIntakeCustomer(c); this.setIntakeBike(b);
      $('inDate').value = d?.doc_date || today();
      $('inInsCo').value = data.insurance_company || ''; $('inInsPolicy').value = data.insurance_policy || '';
      $('inHeard').value = data.heard_about || ''; $('inHeardOther').value = data.heard_other || '';
      $('inReason').value = data.reason || '';
      $('inConsent').checked = !!data.consent; $('inSignName').value = data.signed_name || ''; $('inSignDate').value = data.signed_date || (d ? '' : today());
      $('inStamp').textContent = this.stamp(d);
      $('inArchive').hidden = !d; $('inArchive').textContent = d?.archived ? 'Bring back' : 'Archive';
      $('inEstimate').hidden = !d;
      this.dirty = false; this.message(''); this.show('dcIntake');
    },
    setIntakeCustomer(c) {
      $('inName').value = c?.name || ''; $('inPhone').value = c?.phone || ''; $('inEmail').value = c?.email || ''; $('inAddress').value = c?.address || '';
    },
    setIntakeBike(b) {
      $('inYear').value = b?.year ?? ''; $('inMake').value = b?.make || ''; $('inModel').value = b?.model || '';
      $('inVin').value = b?.vin || ''; $('inMiles').value = b?.mileage ?? '';
    },
    pickIntakeCustomer() {
      const c = this.customer($('inCustomerPick').value);
      this.setIntakeCustomer(c);
      this.fillBikeSelect($('inBikePick'), c?.id, '', '+ New bike');
      this.setIntakeBike(null); this.dirty = true;
    },
    pickIntakeBike() { this.setIntakeBike(this.bike($('inBikePick').value)); this.dirty = true; },

    async saveIntake() {
      if (this.busy) return;
      const name = val('inName');
      if (!name) { this.message('Enter the customer name.', true); $('inName').focus(); return; }
      if (val('inYear') && !/^\d{4}$/.test(val('inYear'))) { this.message('Year should be 4 digits, like 2019.', true); $('inYear').focus(); return; }
      if (val('inMiles') && !/^\d[\d,]*$/.test(val('inMiles'))) { this.message('Miles should be a whole number.', true); $('inMiles').focus(); return; }
      const bikeTyped = ['inYear', 'inMake', 'inModel', 'inVin', 'inMiles'].some(id => val(id));
      const cid = $('inCustomerPick').value || genId();
      const bid = $('inBikePick').value || (bikeTyped ? genId() : null);
      const bikeName = [val('inYear'), val('inMake'), val('inModel')].filter(Boolean).join(' ');
      const args = {
        p_doc_id: this.cur.id, p_customer_id: cid,
        p_customer: { name, phone: val('inPhone'), email: val('inEmail'), address: val('inAddress') },
        p_bike_id: bid,
        p_bike: bid ? { year: val('inYear'), make: val('inMake'), model: val('inModel'), vin: val('inVin'), mileage: val('inMiles').replace(/,/g, '') } : null,
        p_doc: {
          title: `Intake · ${name}${bikeName ? ' · ' + bikeName : ''}`.slice(0, 200), doc_date: $('inDate').value || today(),
          expected_updated_at: this.cur.isNew ? null : this.cur.updated_at,
          data: {
            insurance_company: val('inInsCo'), insurance_policy: val('inInsPolicy'), heard_about: $('inHeard').value, heard_other: val('inHeardOther'),
            reason: val('inReason'), consent: $('inConsent').checked, consent_text: $('inConsentText').textContent.trim(),
            signed_name: val('inSignName'), signed_date: $('inSignDate').value,
          },
        },
      };
      await this.runSave($('inSave'), 'shop_save_intake', args, d => this.openIntake(d), 'Intake saved. The customer and bike records are updated too.');
    },

    // ---------- legal documents ----------
    openLegal(d) {
      this.cur = d ? { ...d } : { id: genId(), doc_type: 'legal', isNew: true };
      const data = d?.data || {};
      $('lgTitle').value = d?.title || ''; $('lgPrintTitle').textContent = d?.title || 'Legal document';
      $('lgCategory').value = data.category || 'Repair authorization';
      $('lgDate').value = d?.doc_date || today();
      this.fillCustomerSelect($('lgCustomer'), d?.customer_id, 'No customer');
      this.fillBikeSelect($('lgBike'), $('lgCustomer').value, d?.bike_id);
      this.fillJobSelect(d?.job_id);
      $('lgBody').value = data.body || ''; $('lgTemplate').value = ''; $('lgFile').value = '';
      $('lgFileNow').textContent = d?.file_name ? `Attached: ${d.file_name}` : 'No file attached.';
      $('lgFileView').hidden = !d?.file_path;
      $('lgStamp').textContent = this.stamp(d);
      $('lgArchive').hidden = !d; $('lgArchive').textContent = d?.archived ? 'Bring back' : 'Archive';
      this.dirty = false; this.message(''); this.show('dcLegal');
    },
    applyTemplate() {
      const t = $('lgTemplate').value; if (!t) return;
      if (val('lgBody') && !root.confirm('Replace the text that is typed now with this template?')) { $('lgTemplate').value = ''; return; }
      $('lgBody').value = TEMPLATES[t] || '';
      if (!val('lgTitle') && t !== 'blank') { $('lgTitle').value = t === 'repair' ? 'Repair authorization' : 'Storage policy'; $('lgPrintTitle').textContent = val('lgTitle'); }
      if (t === 'repair') $('lgCategory').value = 'Repair authorization';
      if (t === 'storage') $('lgCategory').value = 'Storage policy';
      $('lgTemplate').value = ''; this.dirty = true;
    },
    async saveLegal() {
      if (this.busy) return;
      const title = val('lgTitle');
      if (!title) { this.message('Enter a title.', true); $('lgTitle').focus(); return; }
      const file = $('lgFile').files[0];
      if (file && file.size > MAX_FILE) { this.message('That file is over 20 MB. Pick a smaller one.', true); return; }
      if (file && !/^(application\/pdf|image\/)/.test(file.type || '')) { this.message('Attach a PDF or a picture.', true); return; }
      const doc = {
        title, doc_date: $('lgDate').value || today(), customer_id: $('lgCustomer').value || null, bike_id: $('lgBike').value || null,
        job_id: $('lgJob').value || null, expected_updated_at: this.cur.isNew ? null : this.cur.updated_at,
        data: { category: $('lgCategory').value, body: $('lgBody').value },
      };
      const btn = $('lgSave');
      if (file) {
        this.busy = true; btn.disabled = true; btn.textContent = 'Uploading file…';
        const path = `docs/${this.cur.id}/${Date.now()}-${safeName(file.name)}`;
        try { await ShApi.upload(BUCKET, path, file, file.type); }
        catch (e) {
          this.busy = false; btn.disabled = false; btn.textContent = 'Save document';
          this.message(e.status === 401 ? 'Your sign-in expired. Sign in again on the shop page.' : `The file did not upload: ${e.message}`, true); return;
        }
        this.busy = false; btn.disabled = false; btn.textContent = 'Save document';
        Object.assign(doc, { file_path: path, file_name: file.name.slice(0, 200), file_type: file.type });
      }
      await this.runSave(btn, 'shop_save_document', { p_id: this.cur.id, p_type: 'legal', p_doc: doc }, d => this.openLegal(d), 'Document saved.');
    },
    async viewFile() {
      const d = this.cur; if (!d?.file_path) return;
      const win = root.open('', '_blank');
      try {
        const blob = await ShApi.download(BUCKET, d.file_path);
        const url = URL.createObjectURL(blob);
        if (win) win.location.href = url; else root.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) { win?.close(); this.message(`Could not open the file: ${e.message}`, true); }
    },

    // ---------- save / archive ----------
    async runSave(btn, fn, args, reopen, okText) {
      this.busy = true; const label = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…'; this.message('');
      try {
        const saved = await ShApi.rpc(fn, args);
        this.dirty = false;
        await this.refresh();
        const d = this.docs.find(x => x.id === saved.id) || { ...saved, doc_date: String(saved.doc_date || '').slice(0, 10) };
        root.history.replaceState(null, '', `docs.html?doc=${encodeURIComponent(d.id)}`);
        reopen(d); this.message(okText);
      } catch (e) {
        if (e.status === 401) this.message('Your sign-in expired. Sign in again on the shop page, then save again. Your typing is still here.', true);
        else if (/changed by someone else/i.test(e.message)) this.message('Someone else saved this document after you opened it. Reload the page to see their version, then make your change again.', true);
        else this.message(`Not saved: ${e.message}`, true);
      } finally { this.busy = false; btn.disabled = false; btn.textContent = label; }
    },
    async archive() {
      const d = this.cur; if (!d || d.isNew) return;
      const to = !d.archived;
      if (to && !root.confirm('Archive this document? It stays in the library under Show archived and can be brought back.')) return;
      try {
        await ShApi.rpc('shop_archive_document', { p_id: d.id, p_archived: to });
        await this.refresh();
        const fresh = this.docs.find(x => x.id === d.id);
        if (fresh) this.openDoc(fresh);
        this.message(to ? 'Archived. Nothing was deleted.' : 'Brought back.');
      } catch (e) { this.message(`Could not change it: ${e.message}`, true); }
    },
  };

  root.DocsApp = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.init()); else App.init();
})(window);
