/* Payment plans page: customers who bought a bike (or anything) on payments
   (monthly or every two weeks, with or without interest). Lists every plan with its balance and next due date, shows one
   plan's terms and payment log, records payments and edits terms. Every write
   is one database call that checks staff access (shop_save_customer,
   shop_save_payment_plan, shop_record_plan_payment, shop_delete_plan_payment).
   The balance and dates are worked out from the payments (pp-calc.js), never typed.
   All text from the database is written with textContent, never innerHTML. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = root.PpCalc;
  const genId = () => (root.crypto?.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)));
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = s => { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  const money = v => C.money(C.cents(v));
  const bikeLabel = b => b ? [b.year, b.make, b.model].filter(Boolean).join(' ') : '';
  const STATUS = { active: 'Active', paid_off: 'Paid off', cancelled: 'Cancelled' };
  const SCHED = { monthly: 'month', biweekly: 'two weeks' };
  const AUTOPAY = { off: 'Autopay off', pending: 'Autopay sent, waiting on buyer', on: 'Autopay on' };
  const PROVIDER = { stripe: 'Stripe', chase: 'Chase', square: 'Square', shopify: 'Shopify', bank: 'Direct bank transfer', other: 'Other processor' };
  const SAFE_LINK = /^https:\/\/[A-Za-z0-9.-]+(\/[^\s"'<>]*)?$/;
  const ord = n => n + ['th', 'st', 'nd', 'rd'][(n % 10 > 3 || [11, 12, 13].includes(n % 100)) ? 0 : n % 10];
  // Defaults for new plans (Tyler, Nov 21): 20% APR, due every two weeks,
  // $50 a day late after 2 days, default after missing more than 3 in a row.
  const NEW_PLAN = { schedule: 'biweekly', apr: '20', late_fee_per_day: '50', late_fee_grace_days: '2', missed_limit: '3', pay_provider: 'stripe' };
  const SELLER = { name: 'SIC Cycles', address: '', phone: '', email: '' };

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  const App = {
    plans: [], payments: [], customers: [], bikes: [], staff: {}, current: null, editing: null, busy: false,

    async init() {
      this.bind();
      this.show('ppLoading');
      try { await ShApi.verify(); }
      catch (e) { return this.signedOut(e.status && e.status !== 401 ? `Could not reach the shop server: ${e.message}` : null); }
      let ok = false;
      try { ok = await ShApi.rpc('shop_has_staff_access', {}); } catch (e) { return this.signedOut(`Could not check shop access: ${e.message}`); }
      if (ok !== true) return this.signedOut('This account is not on the shop staff list.');
      $('ppNewBtn').hidden = false;
      if (await this.refresh()) this.route();
    },

    bind() {
      $('ppNewBtn').addEventListener('click', () => this.openEditor(null));
      $('ppBack').addEventListener('click', () => { history.replaceState(null, '', location.pathname); this.renderList(); });
      $('ppEdit').addEventListener('click', () => this.openEditor(this.current));
      $('ppPrint').addEventListener('click', () => root.print());
      $('ppContractBtn').addEventListener('click', () => this.openContract(this.current));
      $('ppContractBack').addEventListener('click', () => this.openPlan(this.current));
      $('ppContractPrint').addEventListener('click', () => root.print());
      $('ppPayLinkCopy').addEventListener('click', () => this.copyLink());
      $('ppSchedule').addEventListener('change', () => this.syncSchedule());
      $('ppCalcBtn').addEventListener('click', () => this.workOut(true));
      $('ppPayForm').addEventListener('submit', e => { e.preventDefault(); this.savePayment(); });
      $('ppPlanForm').addEventListener('submit', e => { e.preventDefault(); this.savePlan(); });
      $('ppPlanCancel').addEventListener('click', () => this.current ? this.openPlan(this.current) : this.renderList());
      $('ppCustomer').addEventListener('change', () => this.pickCustomer());
      $('ppBike').addEventListener('change', () => { $('ppNewBike').hidden = $('ppBike').value !== '__new'; this.suggestItem(); });
    },

    show(id) { for (const s of document.querySelectorAll('.pp-view')) s.hidden = s.id !== id; root.scrollTo(0, 0); },
    message(text, isError) { const m = $('ppMsg'); m.textContent = text || ''; m.hidden = !text; m.classList.toggle('sh-msg-error', !!isError); },
    signedOut(text) { if (text) $('ppSignedOutText').textContent = text + ' Sign in on the shop page with a staff account.'; this.show('ppSignedOut'); },

    async refresh() {
      try {
        const [plans, payments, customers, bikes, staff] = await Promise.all([
          ShApi.select('shop_payment_plan_summary', 'select=*&order=sale_date.desc'),
          ShApi.select('shop_plan_payments', 'select=*&order=received_date.asc,created_at.asc'),
          ShApi.select('shop_customers', 'select=id,name,phone,email,address&order=name.asc'),
          ShApi.select('shop_bikes', 'select=id,customer_id,vin,make,model,year,mileage'),
          ShApi.select('shop_staff', 'select=user_id,display_name'),
        ]);
        Object.assign(this, { plans, payments, customers, bikes });
        this.staff = Object.fromEntries(staff.map(s => [s.user_id, s.display_name]));
        return true;
      } catch (e) {
        const missing = e.status === 404 || /relation|does not exist|schema cache/i.test(e.message);
        this.message(missing ? 'Payment plans are not set up on the shop server yet (shop-009 has not been run).' : `Could not load payment plans: ${e.message}`, true);
        this.show('ppList'); $('ppPlans').replaceChildren(); return false;
      }
    },

    route() {
      const id = new URLSearchParams(location.search).get('plan');
      const p = id && this.plans.find(x => x.id === id);
      if (p) this.openPlan(p.id); else this.renderList();
    },

    calc(plan) { return C.summary(plan, this.payments.filter(x => x.plan_id === plan.id), today()); },
    customer(id) { return this.customers.find(c => c.id === id); },
    bike(id) { return this.bikes.find(b => b.id === id); },

    renderList() {
      this.current = null;
      const box = $('ppPlans');
      if (!this.plans.length) { box.replaceChildren(el('p', { class: 'sh-empty sh-muted', text: 'No payment plans yet. Tap + New plan.' })); this.show('ppList'); return; }
      box.replaceChildren(...this.plans.map(p => {
        const s = this.calc(p); const c = this.customer(p.customer_id);
        const state = p.status !== 'active' ? 'pp-done' : s.late ? 'pp-late' : 'pp-ok';
        const sub = p.status !== 'active' ? STATUS[p.status]
          : s.late ? `Late: ${s.missed} missed, ${C.money(s.pastDueCents)} past due since ${fmtDate(s.nextDue)}` : `Next due ${fmtDate(s.nextDue)}`;
        return el('button', { type: 'button', class: `sh-job pp-plan ${state}`, onclick: () => this.openPlan(p.id) },
          el('div', { class: 'sh-job-top' }, el('span', {}, el('strong', { text: c?.name || 'Customer' }), ' · ', p.item),
            el('span', { class: 'sh-job-total', text: C.money(s.balanceCents) })),
          el('div', { class: 'sh-job-sub' }, el('span', { text: sub }), el('span', { text: `Paid ${C.money(s.totalPaidCents)} of ${money(p.sale_price)}` })));
      }));
      this.show('ppList');
    },

    openPlan(id) {
      const p = this.plans.find(x => x.id === id); if (!p) return this.renderList();
      this.current = id; this.message('');
      history.replaceState(null, '', `?plan=${encodeURIComponent(id)}`);
      const c = this.customer(p.customer_id); const b = this.bike(p.bike_id); const s = this.calc(p);
      $('ppTitle').textContent = `${c?.name || 'Customer'} · ${p.item}`;
      $('ppSub').textContent = [c?.phone, c?.email].filter(Boolean).join(' · ');
      const badge = $('ppBadge');
      badge.textContent = p.status !== 'active' ? STATUS[p.status] : s.standing === 'default' ? 'In default' : s.late ? `Late ${C.money(s.pastDueCents)}` : 'Up to date';
      badge.className = 'pp-badge ' + (p.status !== 'active' ? '' : s.late ? 'pp-late' : 'pp-ok');
      this.renderAlert(p, s);
      this.renderPayBox(p);
      $('ppBalance').textContent = C.money(s.balanceCents);
      $('ppPaid').textContent = C.money(s.totalPaidCents);
      $('ppNext').textContent = s.paidOff ? 'Paid' : fmtDate(s.nextDue);
      $('ppNextLabel').textContent = s.late ? 'Oldest unpaid due date' : 'Next due';
      $('ppLeft').textContent = String(s.paymentsLeft);
      $('ppLeftLabel').textContent = `Payments left at ${money(p.payment_amount)}`;
      $('ppPayoff').textContent = s.paidOff ? 'Paid off' : fmtDate(s.payoff);
      const terms = [
        ['Buyer', c?.name], ['Bike', bikeLabel(b) || p.item], ['VIN', b?.vin], ['Mileage at sale', b?.mileage != null ? Number(b.mileage).toLocaleString('en-US') : null],
        ['Sale date', fmtDate(p.sale_date)], ['Sale price', money(p.sale_price)],
        ['Down payment', Number(p.down_payment) ? `${money(p.down_payment)}${p.down_payment_date ? ' on ' + fmtDate(p.down_payment_date) : ''}` : 'None'],
        ['Interest', Number(p.apr) > 0 ? `${Number(p.apr)}% APR. Finance charge ${money(p.finance_charge)}, total of payments ${C.money(s.owedCents)}` : (p.interest_note || 'None')],
        ['Payment', p.schedule === 'biweekly' ? `${money(p.payment_amount)} every two weeks` : `${money(p.payment_amount)}, due the ${ord(Number(p.due_day))} of each month`],
        ['First payment due', fmtDate(p.first_due_date)],
        ['Late fee', Number(p.late_fee_per_day) > 0 ? `${money(p.late_fee_per_day)} a day once a payment is more than ${p.late_fee_grace_days} days late${p.late_fee_waived ? ' (waived: arrangement made)' : ''}. Shown only, never charged automatically.` : 'None'],
        ['Default', `Missing more than ${p.missed_limit} payments in a row. Surrender before the ${ord(Number(p.missed_limit) + 1)} miss means no further fees.`],
        ['Title', p.title_held ? 'Seller keeps the title until the full price is paid, then signs it over.' : 'Title already with the buyer.'],
        ['Extra payments', 'Anything over the scheduled payment comes off the balance and moves the payoff date earlier.'],
        ['Notes', p.notes],
      ].filter(([, v]) => v);
      $('ppTerms').replaceChildren(...terms.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
      let bal = s.owedCents;
      const rows = this.payments.filter(x => x.plan_id === id).map(x => {
        bal -= C.cents(x.amount);
        return el('tr', {}, el('td', { text: fmtDate(x.received_date) }), el('td', { class: 'pp-num', text: money(x.amount) }),
          el('td', { text: x.method || '' }), el('td', { text: x.notes || '' }), el('td', { text: this.staff[x.received_by] || '' }),
          el('td', { class: 'pp-num', text: C.money(bal) }),
          el('td', { class: 'pp-noprint' }, el('button', { type: 'button', class: 'sh-btn pp-x', text: 'Remove', onclick: () => this.deletePayment(x) })));
      });
      $('ppRows').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '7', class: 'sh-muted', text: 'No payments recorded yet.' }))]));
      $('ppPayForm').hidden = p.status === 'cancelled' || s.paidOff;
      $('ppPayDate').value = today();
      $('ppPayAmount').value = (Math.min(C.cents(p.payment_amount), s.balanceCents) / 100).toFixed(2);
      $('ppPayNotes').value = '';
      this.show('ppDetail');
    },

    renderAlert(p, s) {
      const a = $('ppAlert'); a.className = 'pp-alert';
      let text = '';
      if (p.status === 'active' && s.late) {
        const fee = s.lateFeeWaived ? ' Late fees waived (arrangement made).'
          : s.lateFeeCents > 0 ? ` Late fees so far: ${C.money(s.lateFeeCents)} (not charged; collect only per the signed contract).`
          : Number(p.late_fee_per_day) > 0 ? ` Late fees start ${fmtDate(s.lateFeeStarts)} if still unpaid.` : '';
        if (s.standing === 'default') { a.classList.add('pp-alert-red');
          text = `In default: ${s.missed} payments missed in a row (limit ${p.missed_limit}). Under the contract the buyer must surrender the bike.${fee}`;
        } else if (s.standing === 'last_chance') { a.classList.add('pp-alert-red');
          text = `${s.missed} payments missed in a row. One more missed payment is a default. If the bike is surrendered before then, no further fees.${fee}`;
        } else { a.classList.add('pp-alert-amber');
          text = `${s.missed} payment${s.missed === 1 ? '' : 's'} missed, ${C.money(s.pastDueCents)} past due, ${s.lateDays} day${s.lateDays === 1 ? '' : 's'} late.${fee}`;
        }
      }
      a.textContent = text; a.hidden = !text;
    },

    renderPayBox(p) {
      const link = p.pay_link_url && SAFE_LINK.test(p.pay_link_url) ? p.pay_link_url : '';
      const box = $('ppPayBox'); box.hidden = !link && !p.pay_provider && (p.autopay || 'off') === 'off';
      const open = $('ppPayLinkOpen');
      if (link) open.href = link; else open.removeAttribute('href');
      open.hidden = !link; $('ppPayLinkCopy').hidden = !link;
      $('ppAutopayText').textContent = [PROVIDER[p.pay_provider], link ? '' : 'No pay link yet.', AUTOPAY[p.autopay || 'off'], p.autopay_note].filter(Boolean).join(' · ');
    },

    async copyLink() {
      const p = this.plans.find(x => x.id === this.current); if (!p?.pay_link_url) return;
      try { await root.navigator.clipboard.writeText(p.pay_link_url); this.message('Pay link copied. Send it to the buyer yourself.'); }
      catch { this.message('Could not copy. Long-press Open pay link to copy it.', true); }
    },

    openContract(id) {
      const p = this.plans.find(x => x.id === id); if (!p) return this.renderList();
      const c = this.customer(p.customer_id) || {}; const b = this.bike(p.bike_id) || {};
      const doc = root.PpContract.build({ seller: SELLER, buyer: c, vehicle: b, plan: p });
      const kids = [el('div', { class: 'pp-draft', text: doc.status }), el('h1', { class: 'pp-ctitle', text: doc.title })];
      for (const sec of doc.sections) {
        kids.push(el('h2', { text: sec.h }));
        if (sec.box) kids.push(el('div', { class: 'pp-tila' }, ...sec.box.map(([k, v, t]) => el('div', {}, el('span', { class: 'pp-tila-k', text: k }), el('b', { text: v }), el('small', { text: t })))));
        if (sec.table) kids.push(el('table', { class: 'pp-table' }, el('tbody', {}, ...sec.table.map(([k, v]) => el('tr', {}, el('td', { text: k }), el('td', { class: 'pp-num', text: v }))))));
        for (const t of sec.p || []) kids.push(el('p', { class: sec.caps ? 'pp-caps' : null, text: t }));
      }
      kids.push(el('h2', { text: 'Signatures' }), ...doc.signatures.map(t => el('p', { class: 'pp-sign', text: t })));
      kids.push(el('div', { class: 'pp-draft', text: doc.status }));
      $('ppContractDoc').replaceChildren(...kids);
      this.message('');
      this.show('ppContract');
    },

    async savePayment() {
      if (this.busy) return;
      const p = this.plans.find(x => x.id === this.current); if (!p) return;
      const amount = $('ppPayAmount').value.trim().replace(/[$,]/g, ''); const date = $('ppPayDate').value;
      if (!date || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { this.message('Enter the date and an amount like 500 or 500.00.', true); return; }
      const c = this.customer(p.customer_id);
      if (!root.confirm(`Mark ${money(amount)} received from ${c?.name || 'the customer'} on ${fmtDate(date)}?`)) return;
      await this.write($('ppPaySave'), 'Saving…', () => ShApi.rpc('shop_record_plan_payment', { p_payment_id: genId(),
        p_payment: { plan_id: p.id, amount, received_date: date, method: $('ppPayMethod').value, notes: $('ppPayNotes').value } }),
        `Saved ${money(amount)}.`, () => this.openPlan(p.id));
    },

    async deletePayment(x) {
      if (this.busy || !root.confirm(`Remove the ${money(x.amount)} payment from ${fmtDate(x.received_date)}? Only do this if it was entered by mistake.`)) return;
      await this.write(null, '', () => ShApi.rpc('shop_delete_plan_payment', { p_payment_id: x.id }), 'Payment removed.', () => this.openPlan(x.plan_id));
    },

    async write(btn, busyText, call, okText, after) {
      this.busy = true; const label = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = busyText; }
      try { await call(); if (await this.refresh()) { after(); this.message(okText); } }
      catch (e) { this.message(e.message, true); }
      finally { this.busy = false; if (btn) { btn.disabled = false; btn.textContent = label; } }
    },

    // ---------- new / edit plan ----------
    openEditor(planId) {
      const p = planId ? this.plans.find(x => x.id === planId) : null;
      this.editing = { planId: p?.id || genId(), isNew: !p };
      $('ppEditorTitle').textContent = p ? 'Edit payment plan' : 'New payment plan';
      const cs = $('ppCustomer');
      cs.replaceChildren(el('option', { value: '', text: 'Pick a customer' }), el('option', { value: '__new', text: '+ New customer' }),
        ...this.customers.map(c => el('option', { value: c.id, text: [c.name, c.phone].filter(Boolean).join(' · ') })));
      cs.value = p?.customer_id || '';
      const set = (id, v) => { $(id).value = v ?? ''; };
      set('ppItem', p?.item); set('ppSaleDate', p?.sale_date || today()); set('ppPrice', p?.sale_price); set('ppDown', p && Number(p.down_payment) ? p.down_payment : '');
      const d = p || NEW_PLAN;
      set('ppDownDate', p?.down_payment_date); set('ppAmount', p?.payment_amount); set('ppDueDay', p?.due_day); set('ppFirstDue', p?.first_due_date);
      set('ppSchedule', d.schedule || 'monthly'); set('ppApr', d.apr != null ? String(Number(d.apr)) : ''); set('ppTerm', p?.term_payments);
      set('ppLateFee', d.late_fee_per_day != null ? String(Number(d.late_fee_per_day)) : ''); set('ppGrace', d.late_fee_grace_days); set('ppMissedLimit', d.missed_limit);
      set('ppPayLink', p?.pay_link_url); set('ppPayProvider', (p ? p.pay_provider : NEW_PLAN.pay_provider) || ''); set('ppAutopay', p?.autopay || 'off'); set('ppAutopayNote', p?.autopay_note);
      $('ppLateWaived').checked = !!p?.late_fee_waived; $('ppCalcOut').textContent = '';
      set('ppInterest', p?.interest_note); set('ppNotes', p?.notes); set('ppStatus', p?.status || 'active');
      $('ppTitleHeld').checked = p ? !!p.title_held : true;
      this.syncSchedule();
      for (const id of ['ppCName', 'ppCPhone', 'ppCEmail', 'ppCAddress', 'ppBYear', 'ppBMake', 'ppBModel', 'ppBVin', 'ppBMileage']) set(id, '');
      this.pickCustomer(p?.bike_id || '');
      $('ppErrors').hidden = true; this.message('');
      this.show('ppEditor');
    },

    pickCustomer(bikeId) {
      const cid = $('ppCustomer').value;
      $('ppNewCustomer').hidden = cid !== '__new';
      const mine = this.bikes.filter(b => b.customer_id === cid);
      $('ppBike').replaceChildren(el('option', { value: '', text: 'No bike' }), el('option', { value: '__new', text: '+ New bike' }),
        ...mine.map(b => el('option', { value: b.id, text: [bikeLabel(b), b.vin].filter(Boolean).join(' · ') || 'Bike' })));
      $('ppBike').value = typeof bikeId === 'string' && bikeId ? bikeId : (mine.length === 1 ? mine[0].id : '');
      $('ppNewBike').hidden = $('ppBike').value !== '__new';
      this.suggestItem();
    },

    syncSchedule() { $('ppDueDayWrap').hidden = $('ppSchedule').value !== 'monthly'; },

    // Work out the payment and finance charge from price, down, APR and number
    // of payments. With interest the payment always comes from this; with no
    // interest a typed payment is kept.
    workOut(fill) {
      const num = id => $(id).value.trim().replace(/[$,%]/g, '');
      const financed = C.cents(num('ppPrice')) - C.cents(num('ppDown'));
      const apr = Number(num('ppApr') || 0); const n = Number(num('ppTerm'));
      const r = Number.isInteger(n) && n > 0 && financed > 0 && apr >= 0
        ? C.amortize({ financedCents: financed, apr, payments: n, schedule: $('ppSchedule').value }) : null;
      if (!r) { if (fill) $('ppCalcOut').textContent = 'Enter the price and number of payments first.'; return null; }
      if (fill || apr > 0) $('ppAmount').value = (r.paymentCents / 100).toFixed(2);
      $('ppCalcOut').textContent = `${r.payments - 1} payments of ${C.money(r.paymentCents)}, last ${C.money(r.lastPaymentCents)}. Finance charge ${C.money(r.financeChargeCents)}, total ${C.money(r.totalCents)}.`;
      return r;
    },

    suggestItem() {
      if ($('ppItem').value.trim()) return;
      const b = this.bike($('ppBike').value); if (b) $('ppItem').value = bikeLabel(b);
    },

    async savePlan() {
      if (this.busy) return;
      const v = id => $(id).value.trim(); const errs = [];
      const money2 = s => s.replace(/[$,]/g, '');
      let cid = $('ppCustomer').value; let bid = $('ppBike').value;
      if (!cid) errs.push('Pick a customer.');
      if (cid === '__new' && !v('ppCName')) errs.push('New customer needs a name.');
      if (!v('ppItem')) errs.push('Say what was sold.');
      for (const [id, label] of [['ppSaleDate', 'Sale date'], ['ppFirstDue', 'First payment due']]) if (!v(id)) errs.push(`${label} is required.`);
      const sched = $('ppSchedule').value; const apr = Number(money2(v('ppApr')).replace('%', '') || 0);
      const term = v('ppTerm') ? Number(v('ppTerm')) : null;
      if (!(apr >= 0 && apr <= 100)) errs.push('Interest rate must be 0 to 100.');
      if (term != null && !(Number.isInteger(term) && term >= 1 && term <= 520)) errs.push('Number of payments must be a whole number.');
      if (apr > 0 && term == null) errs.push('With interest, enter the number of payments.');
      const calc = apr > 0 && term ? this.workOut(false) : null;
      if (apr === 0 && !v('ppAmount') && term) this.workOut(true);
      for (const [id, label, req] of [['ppPrice', 'Sale price', true], ['ppAmount', 'Payment amount', true], ['ppDown', 'Down payment', false], ['ppLateFee', 'Late fee', false]]) {
        const x = money2(v(id)); if ((req || x) && !/^\d+(\.\d{1,2})?$/.test(x)) errs.push(`${label} must be an amount like 500 or 500.00.`);
      }
      const day = Number(v('ppDueDay'));
      if (sched === 'monthly') {
        if (!Number.isInteger(day) || day < 1 || day > 28) errs.push('Due day must be 1 to 28.');
        if (v('ppFirstDue') && day && Number(v('ppFirstDue').slice(8, 10)) !== day) errs.push('First payment due should fall on the due day.');
      }
      for (const [id, label] of [['ppGrace', 'Late fee start'], ['ppMissedLimit', 'Missed payments limit']]) if (v(id) && !/^\d+$/.test(v(id))) errs.push(`${label} must be a whole number.`);
      if (v('ppPayLink') && !SAFE_LINK.test(v('ppPayLink'))) errs.push('Pay link must be a full https:// link.');
      if (errs.length) { const e = $('ppErrors'); e.replaceChildren(el('ul', {}, ...errs.map(t => el('li', { text: t })))); e.hidden = false; return; }
      $('ppErrors').hidden = true;
      const btn = $('ppPlanSave'); this.busy = true; btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const newBike = bid === '__new';
        if (cid === '__new' || newBike) {
          const customerId = cid === '__new' ? genId() : cid; const c = this.customer(cid);
          const bikeId = newBike ? genId() : null;
          await ShApi.rpc('shop_save_customer', { p_customer_id: customerId,
            p_customer: cid === '__new' ? { name: v('ppCName'), phone: v('ppCPhone'), email: v('ppCEmail'), address: v('ppCAddress') }
              : { name: c.name, phone: c.phone, email: c.email, address: c.address },
            p_bike_id: bikeId, p_bike: newBike ? { year: v('ppBYear'), make: v('ppBMake'), model: v('ppBModel'), vin: v('ppBVin'), mileage: v('ppBMileage') } : null });
          cid = customerId; if (newBike) bid = bikeId;
        }
        await ShApi.rpc('shop_save_payment_plan', { p_plan_id: this.editing.planId, p_plan: {
          customer_id: cid, bike_id: bid || null, item: v('ppItem'), sale_date: v('ppSaleDate'), sale_price: money2(v('ppPrice')),
          down_payment: money2(v('ppDown')) || '0', down_payment_date: v('ppDownDate'), schedule: sched,
          payment_amount: calc ? (calc.paymentCents / 100).toFixed(2) : money2(v('ppAmount')),
          due_day: sched === 'monthly' ? String(day) : null, first_due_date: v('ppFirstDue'),
          apr: String(apr), term_payments: term != null ? String(term) : null,
          finance_charge: calc ? (calc.financeChargeCents / 100).toFixed(2) : '0',
          late_fee_per_day: money2(v('ppLateFee')) || '0', late_fee_grace_days: v('ppGrace') || '2', late_fee_waived: $('ppLateWaived').checked,
          missed_limit: v('ppMissedLimit') || '3', pay_provider: $('ppPayProvider').value || null, pay_link_url: v('ppPayLink'), autopay: $('ppAutopay').value, autopay_note: v('ppAutopayNote'),
          interest_note: v('ppInterest'), title_held: $('ppTitleHeld').checked,
          status: $('ppStatus').value, notes: v('ppNotes') } });
        if (await this.refresh()) { this.openPlan(this.editing.planId); this.message('Plan saved.'); }
      } catch (e) { this.message(e.message, true); }
      finally { this.busy = false; btn.disabled = false; btn.textContent = 'Save plan'; }
    },
  };

  root.PpApp = App;
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => App.init());
})(typeof window !== 'undefined' ? window : globalThis);
