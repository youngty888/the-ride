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
  const KIND = { estimate: 'Estimate', invoice: 'Invoice', intake: 'Intake form', meeting: 'Syndicate meeting', plan: 'Finance agreement', legal: 'Legal', receipt: 'Receipt', paystub: 'Pay stub', consignment: 'Consignment', other: 'Other' };
  const CONSIGN_TERMS = [
    'CONSIGNMENT TERMS (sample wording, have a lawyer review before use)',
    '',
    'The owner says they own the bike or item above, or have the right to sell it, and that it is free of liens except as written above.',
    'SIC Cycles will show and try to sell it for the term above. The owner may take it back during the term by giving SIC Cycles notice.',
    'When it sells, SIC Cycles keeps the commission above and pays the owner the rest within ______ days, by the method above.',
    'SIC Cycles will not sell below the lowest price above without the owner\'s OK.',
    'SIC Cycles is not responsible for loss or damage except as the law requires. The owner keeps their own insurance on a bike.',
    'If it has not sold by the end of the term, the owner picks it up within ______ days or agrees to new terms.',
  ].join('\n');
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
    docs: [], jobs: [], plans: null, customers: [], bikes: [], staff: [], me: null, cur: null, pendingFile: null, busy: false, dirty: false,

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
      // receipt
      $('dcReceiptForm').addEventListener('submit', e => { e.preventDefault(); this.saveReceipt(); });
      $('dcReceiptForm').addEventListener('input', () => { this.dirty = true; });
      ['rcCamera', 'rcFile'].forEach(id => $(id).addEventListener('change', () => this.pickReceiptFile($(id))));
      $('rcArchive').addEventListener('click', () => this.archive());
      $('rcFileView').addEventListener('click', () => this.viewFile());
      // pay stub
      $('dcPaystubForm').addEventListener('submit', e => { e.preventDefault(); this.savePaystub(); });
      $('dcPaystubForm').addEventListener('input', () => { this.dirty = true; });
      $('psArchive').addEventListener('click', () => this.archive());
      $('psFileView').addEventListener('click', () => this.viewFile());
      // consignment
      $('dcConsignForm').addEventListener('submit', e => { e.preventDefault(); this.saveConsignment(); });
      $('dcConsignForm').addEventListener('input', () => { this.dirty = true; });
      document.querySelectorAll('input[name=cnKind]').forEach(r => r.addEventListener('change', () => this.showConsignKind()));
      $('cnCustomerPick').addEventListener('change', () => this.pickConsignCustomer());
      $('cnBikePick').addEventListener('change', () => { this.setConsignBike(this.bike($('cnBikePick').value)); this.dirty = true; });
      $('cnPrint').addEventListener('click', () => root.print());
      $('cnArchive').addEventListener('click', () => this.archive());
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
        try { this.staff = await ShApi.select('shop_staff', 'select=user_id,display_name,active&order=display_name.asc'); } catch { this.staff = []; }
        try { this.me = await ShApi.rpc('shop_me', {}); } catch { this.me = null; }
        $('dcNewStub').hidden = !this.me?.payroll_manager;
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
      if (neu === 'receipt') return this.openReceipt(null);
      if (neu === 'consignment') return this.openConsign(null);
      if (neu === 'paystub') {
        if (!this.me?.payroll_manager) { this.message('Only the payroll manager can file pay stubs.', true); $('dcType').value = 'paystub'; return this.openList(); }
        return this.openPaystub(null);
      }
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
      if (d.doc_type === 'receipt') return this.openReceipt(d);
      if (d.doc_type === 'paystub') return this.openPaystub(d);
      if (d.doc_type === 'consignment') return this.openConsign(d);
      return this.openLegal(d);
    },

    // ---------- library ----------
    customer(id) { return this.customers.find(c => c.id === id) || null; },
    staffName(uid) { if (!uid) return 'unknown'; if (uid === this.me?.user_id) return 'me'; return this.staff.find(s => s.user_id === uid)?.display_name || 'staff'; },
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
          href: '', search: p.item });
      }
      for (const d of this.docs) {
        const kind = KIND[d.doc_type] ? d.doc_type : 'other';
        const label = d.doc_type === 'legal' && d.data?.category ? `Legal · ${d.data.category}`
          : d.doc_type === 'receipt' ? `Receipt · ${d.data?.category || 'Other'}`
          : d.doc_type === 'consignment' ? `Consignment · ${d.data?.kind === 'item' ? 'item' : 'bike'}` : KIND[kind];
        const amt = ['receipt', 'paystub', 'consignment'].includes(d.doc_type) ? money(d.amount) : '';
        out.push({ kind, label, archived: !!d.archived, amt, who: d.doc_type === 'paystub' ? `For ${this.staffName(d.owner_user_id)}` : d.doc_type === 'receipt' ? `Turned in by ${this.staffName(d.owner_user_id)}` : '',
          title: d.title, date: d.doc_date || String(d.created_at || '').slice(0, 10), customer_id: d.customer_id, bike_id: d.bike_id,
          extra: [amt, d.file_name ? 'File attached' : ''], href: d.doc_type === 'meeting' ? `syndicate.html?doc=${encodeURIComponent(d.id)}` : `docs.html?doc=${encodeURIComponent(d.id)}`,
          search: [d.title, d.data?.category, d.file_name, d.data?.reason, d.data?.insurance_company, d.data?.vendor, d.data?.item, this.staffName(d.owner_user_id)].join(' ') });
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
        return el(r.href ? 'a' : 'div', { class: 'dc-row' + (r.archived ? ' dc-archived' : ''), ...(r.href ? { href: r.href } : {}), dataset: { kind: r.kind } },
          el('div', {}, el('span', { class: 'dc-kind', text: r.label + (r.archived ? ' · archived' : '') }), el('div', { class: 'dc-row-title', text: r.title })),
          el('div', { class: 'dc-row-sub', text: [c?.name, bikeLabel(b)].filter(Boolean).join(' · ') || (r.kind === 'meeting' ? 'Shop meeting' : r.kind === 'paystub' || r.kind === 'receipt' ? r.who : 'No customer linked') }),
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
    fillJobSelect(chosen, sel = $('lgJob'), cid = $('lgCustomer').value) {
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

    // ---------- file upload shared by receipts and pay stubs ----------
    checkFile(file) {
      if (!file) return true;
      if (file.size > MAX_FILE) { this.message('That file is over 20 MB. Pick a smaller one.', true); return false; }
      if (!/^(application\/pdf|image\/)/.test(file.type || '')) { this.message('Attach a PDF or a picture.', true); return false; }
      return true;
    },
    async uploadFor(id, file, btn) {
      const label = btn.textContent; this.busy = true; btn.disabled = true; btn.textContent = 'Uploading file…';
      const path = `docs/${id}/${Date.now()}-${safeName(file.name)}`;
      try { await ShApi.upload(BUCKET, path, file, file.type); return { file_path: path, file_name: file.name.slice(0, 200), file_type: file.type }; }
      catch (e) { this.message(e.status === 401 ? 'Your sign-in expired. Sign in again on the shop page.' : `The file did not upload: ${e.message}`, true); return null; }
      finally { this.busy = false; btn.disabled = false; btn.textContent = label; }
    },
    fileLine(d, nowId, viewId, none) {
      $(nowId).textContent = d?.file_name ? `Attached: ${d.file_name}` : none;
      $(viewId).hidden = !d?.file_path;
    },

    // ---------- receipts ----------
    openReceipt(d) {
      this.cur = d ? { ...d } : { id: genId(), doc_type: 'receipt', isNew: true };
      const data = d?.data || {};
      $('rcAmount').value = d?.amount ?? ''; $('rcDate').value = d?.doc_date || today();
      $('rcVendor').value = data.vendor || ''; $('rcCategory').value = data.category || 'Parts';
      $('rcPaidWith').value = data.paid_with || 'shop card'; $('rcBill').checked = !!data.bill_customer; $('rcNotes').value = data.notes || '';
      this.fillJobSelect(d?.job_id, $('rcJob'), '');
      ['rcCamera', 'rcFile'].forEach(id => { $(id).value = ''; });
      this.pendingFile = null; $('rcPicked').textContent = ''; $('rcPreview').hidden = true; $('rcPreview').removeAttribute('src');
      this.fileLine(d, 'rcFileNow', 'rcFileView', 'No file attached yet.');
      $('rcStamp').textContent = d ? `${this.stamp(d)} · turned in by ${this.staffName(d.owner_user_id)}` : '';
      $('rcArchive').hidden = !d; $('rcArchive').textContent = d?.archived ? 'Bring back' : 'Archive';
      this.dirty = false; this.message(''); this.show('dcReceipt');
    },
    pickReceiptFile(input) {
      const file = input.files[0]; if (!file) return;
      if (!this.checkFile(file)) { input.value = ''; return; }
      this.pendingFile = file; this.dirty = true; this.message('');
      $('rcPicked').textContent = `Ready to attach: ${file.name}`;
      const img = $('rcPreview');
      if (/^image\//.test(file.type)) { if (img.src) URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(file); img.hidden = false; }
      else img.hidden = true;
    },
    async saveReceipt() {
      if (this.busy) return;
      const amount = val('rcAmount').replace(/[$,]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { this.message('Enter the amount, like 42.50.', true); $('rcAmount').focus(); return; }
      if (!this.pendingFile && !this.cur.file_path) { this.message('Take a picture of the receipt or upload the file.', true); return; }
      const vendor = val('rcVendor'); const cat = $('rcCategory').value;
      const job = this.jobs.find(j => j.id === $('rcJob').value);
      const doc = {
        title: `Receipt · ${vendor || cat} · ${money(amount)}`.slice(0, 200), doc_date: $('rcDate').value || today(), amount,
        job_id: job?.id || null, customer_id: job?.customer_id || null, bike_id: job?.bike_id || null,
        expected_updated_at: this.cur.isNew ? null : this.cur.updated_at,
        data: { vendor, category: cat, paid_with: $('rcPaidWith').value, bill_customer: $('rcBill').checked, notes: val('rcNotes') },
      };
      const btn = $('rcSave');
      if (this.pendingFile) {
        const f = await this.uploadFor(this.cur.id, this.pendingFile, btn); if (!f) return;
        Object.assign(doc, f);
      }
      await this.runSave(btn, 'shop_save_receipt', { p_id: this.cur.id, p_doc: doc }, d => this.openReceipt(d), 'Receipt saved.');
    },

    // ---------- pay stubs ----------
    openPaystub(d) {
      const canEdit = !!this.me?.payroll_manager;
      this.cur = d ? { ...d } : { id: genId(), doc_type: 'paystub', isNew: true };
      const data = d?.data || {};
      const active = this.staff.filter(s => s.active || s.user_id === d?.owner_user_id);
      $('psOwner').replaceChildren(el('option', { value: '', text: 'Pick a staff member' }), ...active.map(s => el('option', { value: s.user_id, text: s.display_name })));
      $('psOwner').value = d?.owner_user_id || '';
      if (d && !$('psOwner').value && d.owner_user_id) $('psOwner').append(el('option', { value: d.owner_user_id, text: this.staffName(d.owner_user_id), selected: true }));
      $('psOwner').disabled = !!d || !canEdit;                          // a stub never moves to another person
      $('psDate').value = d?.doc_date || today(); $('psFrom').value = data.period_start || ''; $('psTo').value = data.period_end || '';
      $('psAmount').value = d?.amount ?? ''; $('psHours').value = data.hours ?? ''; $('psNotes').value = data.notes || ''; $('psFile').value = '';
      this.fileLine(d, 'psFileNow', 'psFileView', 'No file attached.');
      // Staff see their own stub read-only; the Open button stays usable.
      $('dcPaystubForm').querySelectorAll('input,textarea').forEach(x => { x.disabled = !canEdit; });
      $('psFileWrap').hidden = !canEdit; $('psSave').hidden = !canEdit;
      $('psStamp').textContent = this.stamp(d);
      $('psArchive').hidden = !d || !canEdit; $('psArchive').textContent = d?.archived ? 'Bring back' : 'Archive';
      this.dirty = false; this.message(''); this.show('dcPaystub');
    },
    async savePaystub() {
      if (this.busy || !this.me?.payroll_manager) return;
      const owner = $('psOwner').value;
      if (!owner) { this.message('Pick the staff member this pay stub is for.', true); $('psOwner').focus(); return; }
      const amount = val('psAmount').replace(/[$,]/g, '');
      if (amount && !/^\d+(\.\d{1,2})?$/.test(amount)) { this.message('Net pay should be a number, like 812.40.', true); $('psAmount').focus(); return; }
      if (val('psHours') && !/^\d+(\.\d{1,2})?$/.test(val('psHours'))) { this.message('Hours should be a number, like 38.5.', true); $('psHours').focus(); return; }
      if ($('psFrom').value && $('psTo').value && $('psTo').value < $('psFrom').value) { this.message('The period ends before it starts.', true); return; }
      const file = $('psFile').files[0];
      if (!this.checkFile(file)) return;
      const name = this.staff.find(s => s.user_id === owner)?.display_name || 'staff';
      const doc = {
        title: `Pay stub · ${name} · ${fmtDate($('psDate').value || today())}`.slice(0, 200), doc_date: $('psDate').value || today(), amount,
        expected_updated_at: this.cur.isNew ? null : this.cur.updated_at,
        data: { period_start: $('psFrom').value, period_end: $('psTo').value, hours: val('psHours'), notes: val('psNotes') },
      };
      const btn = $('psSave');
      if (!file) return this.runSave(btn, 'shop_save_paystub', { p_id: this.cur.id, p_owner: owner, p_doc: doc }, d => this.openPaystub(d), 'Pay stub saved.');
      // Save the row first so the file is private from the moment it lands, then attach it.
      this.busy = true; btn.disabled = true;
      let row;
      try { row = await ShApi.rpc('shop_save_paystub', { p_id: this.cur.id, p_owner: owner, p_doc: doc }); }
      catch (e) { this.busy = false; btn.disabled = false; this.message(`Not saved: ${e.message}`, true); return; }
      this.busy = false; btn.disabled = false;
      this.cur = { ...this.cur, ...row, isNew: false };
      const f = await this.uploadFor(this.cur.id, file, btn);
      if (!f) { await this.refresh(); this.message('The pay stub details were saved, but the file did not upload. Attach it again and save.', true); return; }
      await this.runSave(btn, 'shop_save_paystub', { p_id: this.cur.id, p_owner: owner, p_doc: { ...doc, ...f, expected_updated_at: row.updated_at } }, d => this.openPaystub(d), 'Pay stub saved.');
    },

    // ---------- consignment ----------
    openConsign(d) {
      this.cur = d ? { ...d } : { id: genId(), doc_type: 'consignment', isNew: true };
      const data = d?.data || {};
      const c = d ? this.customer(d.customer_id) : null; const b = d ? this.bike(d.bike_id) : null;
      document.querySelector(`input[name=cnKind][value=${data.kind === 'item' ? 'item' : 'bike'}]`).checked = true;
      this.fillCustomerSelect($('cnCustomerPick'), c?.id, '+ New customer');
      this.fillBikeSelect($('cnBikePick'), c?.id, b?.id, '+ New bike');
      $('cnName').value = c?.name || ''; $('cnPhone').value = c?.phone || ''; $('cnEmail').value = c?.email || ''; $('cnAddress').value = c?.address || '';
      this.setConsignBike(b);
      $('cnDate').value = d?.doc_date || today(); $('cnTitle').value = data.title_status || '';
      $('cnItem').value = data.item || ''; $('cnQty').value = data.quantity ?? 1;
      $('cnAsk').value = data.asking_price || ''; $('cnMin').value = data.minimum_price || ''; $('cnCommission').value = data.commission_pct || '';
      $('cnTerm').value = data.term_days || ''; $('cnPayout').value = data.payout_method || '';
      $('cnCondition').value = data.condition || ''; $('cnTerms').value = d ? (data.terms || '') : CONSIGN_TERMS;
      $('cnStamp').textContent = this.stamp(d);
      $('cnArchive').hidden = !d; $('cnArchive').textContent = d?.archived ? 'Bring back' : 'Archive';
      this.showConsignKind(); this.dirty = false; this.message(''); this.show('dcConsign');
    },
    consignKind() { return document.querySelector('input[name=cnKind]:checked')?.value || 'bike'; },
    showConsignKind() { const bike = this.consignKind() === 'bike'; $('cnBikeBox').hidden = !bike; $('cnItemBox').hidden = bike; },
    setConsignBike(b) {
      $('cnYear').value = b?.year ?? ''; $('cnMake').value = b?.make || ''; $('cnModel').value = b?.model || '';
      $('cnVin').value = b?.vin || ''; $('cnMiles').value = b?.mileage ?? '';
    },
    pickConsignCustomer() {
      const c = this.customer($('cnCustomerPick').value);
      $('cnName').value = c?.name || ''; $('cnPhone').value = c?.phone || ''; $('cnEmail').value = c?.email || ''; $('cnAddress').value = c?.address || '';
      this.fillBikeSelect($('cnBikePick'), c?.id, '', '+ New bike'); this.setConsignBike(null); this.dirty = true;
    },
    async saveConsignment() {
      if (this.busy) return;
      const name = val('cnName'); const kind = this.consignKind();
      if (!name) { this.message('Enter the owner\'s name.', true); $('cnName').focus(); return; }
      const num = (id, label) => { const v = val(id).replace(/[$,%]/g, ''); if (v && !/^\d+(\.\d{1,2})?$/.test(v)) { this.message(`${label} should be a number.`, true); $(id).focus(); return null; } return v; };
      const ask = num('cnAsk', 'Asking price'); if (ask === null) return;
      const min = num('cnMin', 'Lowest price'); if (min === null) return;
      const pct = num('cnCommission', 'Commission'); if (pct === null) return;
      if (pct && Number(pct) > 100) { this.message('Commission can\'t be more than 100%.', true); return; }
      if (ask && min && Number(min) > Number(ask)) { this.message('The lowest price is higher than the asking price.', true); return; }
      if (val('cnTerm') && !/^\d+$/.test(val('cnTerm'))) { this.message('Term should be a whole number of days.', true); return; }
      let bid = null, bike = null, what;
      if (kind === 'bike') {
        if (val('cnYear') && !/^\d{4}$/.test(val('cnYear'))) { this.message('Year should be 4 digits, like 2019.', true); $('cnYear').focus(); return; }
        if (val('cnMiles') && !/^\d[\d,]*$/.test(val('cnMiles'))) { this.message('Miles should be a whole number.', true); $('cnMiles').focus(); return; }
        bid = $('cnBikePick').value || genId();
        bike = { year: val('cnYear'), make: val('cnMake'), model: val('cnModel'), vin: val('cnVin'), mileage: val('cnMiles').replace(/,/g, '') };
        what = [val('cnYear'), val('cnMake'), val('cnModel')].filter(Boolean).join(' ') || 'Bike';
      } else {
        if (!val('cnItem')) { this.message('Say what the item is.', true); $('cnItem').focus(); return; }
        if (val('cnQty') && !/^\d+$/.test(val('cnQty'))) { this.message('Quantity should be a whole number.', true); return; }
        what = val('cnItem');
      }
      const args = {
        p_doc_id: this.cur.id, p_customer_id: $('cnCustomerPick').value || genId(),
        p_customer: { name, phone: val('cnPhone'), email: val('cnEmail'), address: val('cnAddress') },
        p_bike_id: bid, p_bike: bike,
        p_doc: {
          title: `Consignment · ${what} · ${name}`.slice(0, 200), doc_date: $('cnDate').value || today(),
          expected_updated_at: this.cur.isNew ? null : this.cur.updated_at,
          data: { kind, item: kind === 'item' ? val('cnItem') : '', quantity: kind === 'item' ? (val('cnQty') || '1') : '', title_status: kind === 'bike' ? $('cnTitle').value : '',
            asking_price: ask, minimum_price: min, commission_pct: pct, term_days: val('cnTerm'), payout_method: $('cnPayout').value,
            condition: val('cnCondition'), terms: $('cnTerms').value },
        },
      };
      await this.runSave($('cnSave'), 'shop_save_consignment', args, d => this.openConsign(d), 'Consignment agreement saved. The customer record is updated too.');
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
