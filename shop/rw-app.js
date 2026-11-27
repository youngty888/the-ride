/* Rewards points and Dollars for Dads page (needs shop-010 on the server).
   Rewards: every customer's points, their history, use points on a reward
   from the rewards list (prizes or discounts; points never turn into cash),
   add/remove by hand, the rewards list itself, and the earn rules. Points are earned by the database when a job is
   marked Paid; this page never types a balance.
   Dollars for Dads: add donations, see each donor's raffle entries and tier
   prizes, hand prizes out, mark donations sent to ManUp, refund.
   Every write is one database call that checks staff access. All text from
   the database is written with textContent, never innerHTML. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const genId = () => (root.crypto?.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)));
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = s => { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  const money = v => '$' + (Math.round(Number(v || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pts = v => Number(v || 0).toLocaleString('en-US');
  const KIND = { earn: 'Earned', reverse: 'Taken back', redeem: 'Used', adjust: 'Changed by hand' };
  const PRIZES = [['gaiter', 'Gaiter', 'earned_gaiter', 'given_gaiter'], ['shirt', 'T-shirt', 'earned_shirt', 'given_shirt'], ['vest_entry', 'Vest drawing', 'earned_vest_entry', 'given_vest_entry']];
  const DEFAULT_CAMPAIGN = 'Dollars for Dads 2026';

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
    settings: {}, catalog: [], editing: null, balances: [], entries: [], jobs: [], customers: [], staff: {},
    donations: [], donors: [], summary: [], tab: 'rewards', current: null, campaign: DEFAULT_CAMPAIGN,
    ids: { redeem: genId(), adjust: genId(), donation: genId(), item: genId() }, busy: false,

    async init() {
      this.bind();
      this.show('rwLoading');
      try { await ShApi.verify(); }
      catch (e) { return this.signedOut(e.status && e.status !== 401 ? `Could not reach the shop server: ${e.message}` : null); }
      let ok = false;
      try { ok = await ShApi.rpc('shop_has_staff_access', {}); } catch (e) { return this.signedOut(`Could not check shop access: ${e.message}`); }
      if (ok !== true) return this.signedOut('This account is not on the shop staff list.');
      $('rwTabs').hidden = false;
      $('rwDonDate').value = today(); $('rwFwdDate').value = today();
      if (await this.refresh()) this.go(location.hash === '#d4d' ? 'd4d' : 'rewards');
    },

    bind() {
      for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => this.go(b.dataset.tab));
      $('rwSearch').addEventListener('input', () => this.renderCustomers());
      $('rwBack').addEventListener('click', () => this.go('rewards'));
      $('rwRedeemForm').addEventListener('submit', e => { e.preventDefault(); this.redeem(); });
      $('rwRedeemReward').addEventListener('change', () => this.showWorth());
      $('rwItemForm').addEventListener('submit', e => { e.preventDefault(); this.saveItem(); });
      $('rwItemCancel').addEventListener('click', () => this.editItem(null));
      $('rwAdjustForm').addEventListener('submit', e => { e.preventDefault(); this.adjust(); });
      $('rwSetForm').addEventListener('submit', e => { e.preventDefault(); this.saveSettings(); });
      $('rwBackfill').addEventListener('click', () => this.backfill());
      $('rwCampaign').addEventListener('change', () => { this.campaign = $('rwCampaign').value; this.renderD4d(); });
      $('rwDonCust').addEventListener('change', () => this.pickDonor());
      $('rwDonOrder').addEventListener('input', () => { if ($('rwDonOrder').value.trim()) { $('rwDonSource').value = 'shopify'; $('rwDonMethod').value = 'Shopify'; } });
      $('rwDonForm').addEventListener('submit', e => { e.preventDefault(); this.saveDonation(); });
      $('rwFwdSave').addEventListener('click', () => this.forward());
    },

    show(id) {
      for (const s of document.querySelectorAll('.rw-view')) s.hidden = s.id !== id;
      for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === this.tab));
    },
    message(text, isError) { const m = $('rwMsg'); m.textContent = text || ''; m.hidden = !text; m.classList.toggle('sh-msg-error', !!isError); if (text) root.scrollTo(0, 0); },
    signedOut(text) { if (text) $('rwSignedOutText').textContent = text + ' Sign in on the shop page with a staff account.'; this.show('rwSignedOut'); },
    async busyRun(btn, fn) {
      if (this.busy) return; this.busy = true; btn.disabled = true;
      try { await fn(); } catch (e) { this.message(e.message || String(e), true); } finally { this.busy = false; btn.disabled = false; }
    },

    async refresh() {
      try {
        const [settings, catalog, balances, entries, jobs, customers, staff, donations, donors, summary] = await Promise.all([
          ShApi.select('shop_settings', 'select=rewards_enabled,rewards_points_per_dollar,rewards_start_date'),
          ShApi.select('shop_reward_catalog', 'select=*&order=active.desc,points_cost.asc,name.asc'),
          ShApi.select('shop_reward_balances', 'select=*&order=name.asc'),
          ShApi.select('shop_reward_entries', 'select=*&order=created_at.desc'),
          ShApi.select('shop_jobs', 'select=id,customer_id,invoice_number,estimate_number,job_date,total_amount,payment_status&order=job_date.desc'),
          ShApi.select('shop_customers', 'select=id,name,phone,email&order=name.asc'),
          ShApi.select('shop_staff', 'select=user_id,display_name'),
          ShApi.select('shop_d4d_donations', 'select=*&order=donated_on.desc,created_at.desc'),
          ShApi.select('shop_d4d_donor_totals', 'select=*&order=total.desc'),
          ShApi.select('shop_d4d_campaign_summary', 'select=*'),
        ]);
        Object.assign(this, { settings: settings[0] || {}, catalog, balances, entries, jobs, customers, donations, donors, summary });
        this.staff = Object.fromEntries(staff.map(s => [s.user_id, s.display_name]));
        return true;
      } catch (e) {
        const missing = e.status === 404 || /relation|does not exist|schema cache|column/i.test(e.message);
        this.message(missing ? 'Rewards and Dollars for Dads are not set up on the shop server yet (shop-010 has not been run).' : `Could not load: ${e.message}`, true);
        this.show('rwLoading'); $('rwLoading').replaceChildren(); return false;
      }
    },

    go(tab) {
      this.tab = tab; history.replaceState(null, '', tab === 'd4d' ? '#d4d' : location.pathname);
      if (tab === 'd4d') this.renderD4d(); else this.renderRewards();
    },

    // ------------------------------------------------------------- rewards
    activeRewards() { return this.catalog.filter(r => r.active).sort((a, b) => a.points_cost - b.points_cost); },
    renderRewards() {
      const s = this.settings;
      $('rwRule').textContent = s.rewards_enabled
        ? `Customers earn ${Number(s.rewards_points_per_dollar)} point per $1 (before tax) when a job is marked Paid, on jobs dated ${fmtDate(s.rewards_start_date)} or later. Points are used for prizes or discounts on the rewards list, never cash.`
        : 'Rewards are turned off. Turn them on in Rewards settings below.';
      $('rwSetOn').checked = !!s.rewards_enabled;
      $('rwSetRate').value = s.rewards_points_per_dollar ?? '';
      $('rwSetStart').value = s.rewards_start_date || '';
      if (!$('rwBackfillFrom').value) $('rwBackfillFrom').value = s.rewards_start_date || '';
      this.renderCustomers(); this.renderCatalog(); this.show('rwRewards');
    },
    renderCustomers() {
      const q = $('rwSearch').value.trim().toLowerCase();
      const rows = this.balances.filter(b => !q || [b.name, b.phone, b.email].some(v => String(v || '').toLowerCase().includes(q)));
      rows.sort((a, b) => (b.balance - a.balance) || String(a.name).localeCompare(String(b.name)));
      const box = $('rwCustomers');
      if (!rows.length) { box.replaceChildren(el('p', { class: 'sh-empty sh-muted', text: q ? 'No customer matches.' : 'No customers yet.' })); return; }
      box.replaceChildren(...rows.map(b => el('button', { type: 'button', class: `sh-job rw-row${b.balance > 0 ? ' rw-has' : ''}`, onclick: () => this.openCustomer(b.customer_id) },
        el('div', { class: 'sh-job-top' }, el('strong', { text: b.name || 'Customer' }), el('span', { class: 'sh-job-total', text: `${pts(b.balance)} pts` })),
        el('div', { class: 'sh-job-sub' }, el('span', { text: [b.phone, b.email].filter(Boolean).join(' · ') || ' ' }),
          el('span', { text: this.readyText(b.balance) })))));
    },
    readyText(balance) {
      const act = this.activeRewards(); if (!act.length) return '';
      const ready = act.filter(r => r.points_cost <= balance).length;
      if (ready) return `${ready} reward${ready === 1 ? '' : 's'} ready`;
      return `${pts(act[0].points_cost - balance)} to next reward`;
    },
    renderCatalog() {
      const box = $('rwCatalog');
      if (!this.catalog.length) { box.replaceChildren(el('p', { class: 'sh-muted', text: 'No rewards yet. Add the first one below.' })); return; }
      box.replaceChildren(...this.catalog.map(r => el('div', { class: `rw-item${r.active ? '' : ' rw-off'}` },
        el('div', {}, el('strong', { text: r.name }),
          el('small', { text: [`${pts(r.points_cost)} points`, r.kind === 'discount' ? 'Discount' : 'Prize', r.details, r.active ? null : 'Switched off'].filter(Boolean).join(' · ') })),
        el('button', { type: 'button', class: 'sh-btn rw-x', onclick: () => this.editItem(r.id), text: 'Edit' }))));
    },
    editItem(id) {
      const r = id && this.catalog.find(x => x.id === id);
      this.editing = r ? r.id : null; this.ids.item = r ? r.id : genId();
      $('rwItemTitle').textContent = r ? 'Change reward' : 'Add a reward';
      $('rwItemName').value = r ? r.name : ''; $('rwItemKind').value = r ? r.kind : 'prize';
      $('rwItemCost').value = r ? r.points_cost : ''; $('rwItemDetails').value = r ? (r.details || '') : '';
      $('rwItemActive').checked = r ? !!r.active : true; $('rwItemCancel').hidden = !r;
      if (r) $('rwItemForm').scrollIntoView({ block: 'nearest' });
    },
    saveItem() {
      const btn = $('rwItemSave');
      return this.busyRun(btn, async () => {
        const name = $('rwItemName').value.trim(), cost = $('rwItemCost').value.trim();
        if (!name) throw new Error('Give the reward a name.');
        if (!/^\d+$/.test(cost) || Number(cost) <= 0) throw new Error('Points cost must be a whole number above 0.');
        await ShApi.rpc('shop_save_reward_item', { p_id: this.ids.item, p_item: { name, kind: $('rwItemKind').value,
          points_cost: cost, details: $('rwItemDetails').value.trim(), active: $('rwItemActive').checked } });
        const was = this.editing;
        await this.refresh(); this.editItem(null); this.renderRewards();
        this.message(was ? `Saved ${name}.` : `Added ${name} to the rewards list.`);
      });
    },
    openCustomer(id) {
      const b = this.balances.find(x => x.customer_id === id); if (!b) return this.go('rewards');
      this.current = id; this.message('');
      $('rwCName').textContent = b.name || 'Customer';
      $('rwCSub').textContent = [b.phone, b.email].filter(Boolean).join(' · ');
      $('rwCBal').textContent = pts(b.balance);
      $('rwCVal').textContent = pts(this.activeRewards().filter(r => r.points_cost <= b.balance).length);
      $('rwCEarned').textContent = pts(b.points_earned); $('rwCUsed').textContent = pts(b.points_redeemed);
      const jobs = Object.fromEntries(this.jobs.map(j => [j.id, j]));
      const rows = this.entries.filter(e => e.customer_id === id);
      $('rwCRows').replaceChildren(...(rows.length ? rows.map(e => {
        const j = e.job_id && jobs[e.job_id];
        const what = KIND[e.kind] + (j ? ` · IV#${j.estimate_number || j.invoice_number || ''}` : '') + (e.reward_name ? ` · ${e.reward_name}` : '');
        return el('tr', {}, el('td', { text: fmtDate(e.created_at) }), el('td', { text: what }),
          el('td', { class: 'rw-num', text: (e.points > 0 ? '+' : '') + pts(e.points) }), el('td', { text: e.note || '' }),
          el('td', { text: e.created_by ? (this.staff[e.created_by] || 'Staff') : 'Automatic' }));
      }) : [el('tr', {}, el('td', { colspan: '5', class: 'sh-muted', text: 'No points yet. Points come in when a job is marked Paid.' }))]));
      const sel = $('rwRedeemJob');
      sel.replaceChildren(el('option', { value: '', text: 'No job' }), ...this.jobs.filter(j => j.customer_id === id)
        .map(j => el('option', { value: j.id, text: `IV#${j.estimate_number || j.invoice_number || '?'} · ${fmtDate(j.job_date)} · ${money(j.total_amount)}` })));
      const act = this.activeRewards();
      $('rwRedeemReward').replaceChildren(...(act.length
        ? [el('option', { value: '', text: 'Pick a reward' }), ...act.map(r => el('option', { value: r.id, disabled: r.points_cost > b.balance,
            text: `${r.name} · ${pts(r.points_cost)} pts${r.points_cost > b.balance ? ' (not enough yet)' : ''}` }))]
        : [el('option', { value: '', text: 'No rewards on the list yet' })]));
      $('rwRedeemNote').value = ''; $('rwAdjPts').value = ''; $('rwAdjNote').value = '';
      this.ids.redeem = genId(); this.ids.adjust = genId(); this.showWorth();
      this.show('rwCustomer'); root.scrollTo(0, 0);
    },
    showWorth() {
      const r = this.catalog.find(x => x.id === $('rwRedeemReward').value);
      const b = this.balances.find(x => x.customer_id === this.current);
      $('rwRedeemWorth').textContent = r && b ? [`Takes ${pts(r.points_cost)} points, leaves ${pts(b.balance - r.points_cost)}.`, r.details].filter(Boolean).join(' ') : '';
    },
    redeem() {
      const btn = $('rwRedeemSave');
      return this.busyRun(btn, async () => {
        const reward = $('rwRedeemReward').value;
        if (!reward) throw new Error('Pick a reward from the list.');
        const r = await ShApi.rpc('shop_rewards_redeem', { p_entry_id: this.ids.redeem, p_customer_id: this.current, p_reward_id: reward,
          p_job_id: $('rwRedeemJob').value || null, p_note: $('rwRedeemNote').value.trim() || null });
        await this.refresh(); this.openCustomer(this.current);
        this.message(`Used points on ${r.reward || 'the reward'}. ${pts(r.balance)} points left.`);
      });
    },
    adjust() {
      const btn = $('rwAdjSave');
      return this.busyRun(btn, async () => {
        const p = $('rwAdjPts').value.trim();
        if (!/^-?\d+$/.test(p) || Number(p) === 0) throw new Error('Enter points as a whole number, like 50 or -20.');
        if (!$('rwAdjNote').value.trim()) throw new Error('Say why the points are changing.');
        const r = await ShApi.rpc('shop_rewards_adjust', { p_entry_id: this.ids.adjust, p_customer_id: this.current, p_points: Number(p), p_note: $('rwAdjNote').value.trim() });
        await this.refresh(); this.openCustomer(this.current);
        this.message(`Saved. ${pts(r.balance)} points now.`);
      });
    },
    saveSettings() {
      const btn = $('rwSetSave');
      return this.busyRun(btn, async () => {
        await ShApi.rpc('shop_update_reward_settings', { p_settings: { rewards_enabled: $('rwSetOn').checked,
          rewards_points_per_dollar: $('rwSetRate').value.trim(),
          rewards_start_date: $('rwSetStart').value } });
        await this.refresh(); this.renderRewards(); this.message('Rewards settings saved.');
      });
    },
    backfill() {
      const btn = $('rwBackfill'); const from = $('rwBackfillFrom').value;
      return this.busyRun(btn, async () => {
        if (!from) throw new Error('Pick a start date first.');
        if (!root.confirm(`Give points for every job marked Paid since ${fmtDate(from)}?`)) return;
        const r = await ShApi.rpc('shop_rewards_backfill', { p_from: from });
        await this.refresh(); this.renderRewards();
        this.message(r.jobs ? `Gave ${pts(r.points)} points across ${r.jobs} earlier paid jobs.` : 'No earlier paid jobs needed points.');
      });
    },

    // ------------------------------------------------------- Dollars for Dads
    renderD4d() {
      const camps = [...new Set([DEFAULT_CAMPAIGN, ...this.summary.map(s => s.campaign)])];
      if (!camps.includes(this.campaign)) this.campaign = DEFAULT_CAMPAIGN;
      $('rwCampaign').replaceChildren(...camps.map(c => el('option', { value: c, text: c, selected: c === this.campaign })));
      const s = this.summary.find(x => x.campaign === this.campaign) || {};
      $('rwSRaised').textContent = money(s.total_raised); $('rwSSent').textContent = money(s.forwarded);
      $('rwSOwed').textContent = money(s.not_forwarded); $('rwSDonors').textContent = String(s.donors || 0);
      const back = Number(s.refunded_after_forwarding || 0);
      $('rwRefundWarn').hidden = !back;
      $('rwRefundWarn').textContent = back ? `${money(back)} was refunded after it was already sent to ManUp. Ask ManUp to return it or take it off the next transfer.` : '';
      const cust = $('rwDonCust');
      if (cust.options.length !== this.customers.length + 1) {
        cust.replaceChildren(el('option', { value: '', text: 'Not a shop customer' }), ...this.customers.map(c => el('option', { value: c.id, text: [c.name, c.phone].filter(Boolean).join(' · ') })));
      }
      this.renderDonors(); this.renderDonations(); this.show('rwD4d');
    },
    pickDonor() {
      const c = this.customers.find(x => x.id === $('rwDonCust').value);
      if (c) { $('rwDonName').value = c.name || ''; $('rwDonEmail').value = c.email || ''; $('rwDonPhone').value = c.phone || ''; }
    },
    renderDonors() {
      const rows = this.donors.filter(d => d.campaign === this.campaign);
      const box = $('rwDonors');
      if (!rows.length) { box.replaceChildren(el('p', { class: 'sh-empty sh-muted', text: 'No donations yet.' })); return; }
      box.replaceChildren(...rows.map(d => el('div', { class: 'sh-job' },
        el('div', { class: 'sh-job-top' }, el('strong', { text: (d.over_75_disclosure ? '⚠ ' : '') + (d.donor_name || 'Donor') }), el('span', { class: 'sh-job-total', text: money(d.total) })),
        el('div', { class: 'sh-job-sub' }, el('span', { text: `${pts(d.raffle_entries)} raffle entries` }), el('span', { text: `${d.donations} gift${d.donations === 1 ? '' : 's'}` }),
          el('span', { text: [d.donor_email, d.donor_phone].filter(Boolean).join(' · ') })),
        el('div', { class: 'rw-prizes' }, ...PRIZES.filter(p => d[p[2]]).map(([item, label, , given]) => el('button', {
          type: 'button', class: `sh-btn rw-prize${d[given] ? ' rw-given' : ''}`, 'aria-pressed': String(!!d[given]),
          text: d[given] ? `✓ ${label} given` : `Give ${label}`, onclick: e => this.prize(e.currentTarget, d, item, !!d[given], label) }))))));
    },
    prize(btn, d, item, given, label) {
      return this.busyRun(btn, async () => {
        if (given) {
          const why = root.prompt(`Undo "${label} given" for ${d.donor_name}? Say why:`);
          if (!why) return;
          await ShApi.rpc('shop_d4d_undo_prize', { p_campaign: d.campaign, p_donor_key: d.donor_key, p_item: item, p_reason: why });
        } else {
          await ShApi.rpc('shop_d4d_give_prize', { p_campaign: d.campaign, p_donor_key: d.donor_key, p_item: item, p_note: null });
        }
        await this.refresh(); this.renderD4d();
      });
    },
    renderDonations() {
      const rows = this.donations.filter(d => d.campaign === this.campaign);
      $('rwDonRows').replaceChildren(...(rows.length ? rows.map(d => {
        const status = d.refunded_at ? `Refunded: ${d.refund_reason || ''}` : d.forwarded_at ? `Sent ${fmtDate(d.forwarded_on)} · ${d.forwarded_ref || ''}` : 'Not sent yet';
        const box = !d.refunded_at && !d.forwarded_at ? el('input', { type: 'checkbox', 'data-fwd': d.id, 'aria-label': `Sent ${d.donor_name} ${money(d.amount)}` }) : '';
        return el('tr', { class: d.refunded_at ? 'rw-refunded' : '' }, el('td', {}, box), el('td', { text: fmtDate(d.donated_on) }),
          el('td', { text: d.donor_name + (d.shopify_order ? ` · ${d.shopify_order}` : '') }), el('td', { class: 'rw-num', text: money(d.amount) }),
          el('td', { text: status }),
          el('td', {}, d.refunded_at ? '' : el('button', { type: 'button', class: 'sh-btn rw-x', text: 'Refund', onclick: e => this.refund(e.currentTarget, d) })));
      }) : [el('tr', {}, el('td', { colspan: '6', class: 'sh-muted', text: 'No donations yet.' }))]));
    },
    saveDonation() {
      const btn = $('rwDonSave'); const errs = $('rwDonErrors'); errs.hidden = true;
      return this.busyRun(btn, async () => {
        const amount = $('rwDonAmount').value.trim().replace(/^\$/, '');
        const problems = [];
        if (!$('rwDonName').value.trim() && !$('rwDonCust').value) problems.push('Donor name is required.');
        if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) problems.push('Amount must be a dollar amount more than $0, like 20 or 25.50.');
        if (!$('rwDonDate').value) problems.push('Pick the date.');
        if (problems.length) { errs.replaceChildren(el('ul', {}, ...problems.map(p => el('li', { text: p })))); errs.hidden = false; return; }
        await ShApi.rpc('shop_d4d_save_donation', { p_id: this.ids.donation, p_d: { campaign: this.campaign, customer_id: $('rwDonCust').value || null,
          donor_name: $('rwDonName').value.trim(), donor_email: $('rwDonEmail').value.trim(), donor_phone: $('rwDonPhone').value.trim(),
          amount, donated_on: $('rwDonDate').value, source: $('rwDonSource').value, method: $('rwDonMethod').value,
          shopify_order: $('rwDonOrder').value.trim(), note: $('rwDonNote').value.trim() } });
        this.ids.donation = genId();
        for (const f of ['rwDonName', 'rwDonEmail', 'rwDonPhone', 'rwDonAmount', 'rwDonOrder', 'rwDonNote']) $(f).value = '';
        $('rwDonCust').value = ''; $('rwDonSource').value = 'shop'; $('rwDonMethod').value = 'Cash';
        await this.refresh(); this.renderD4d(); this.message(`Saved ${money(amount)} donation.`);
      });
    },
    forward() {
      const btn = $('rwFwdSave');
      return this.busyRun(btn, async () => {
        const ids = [...document.querySelectorAll('[data-fwd]:checked')].map(c => c.dataset.fwd);
        if (!ids.length) throw new Error('Tick the donations you sent to ManUp first.');
        if (!$('rwFwdRef').value.trim()) throw new Error('Add a reference, like the check number or transfer id.');
        const r = await ShApi.rpc('shop_d4d_mark_forwarded', { p_ids: ids, p_forwarded_on: $('rwFwdDate').value || null, p_ref: $('rwFwdRef').value.trim() });
        $('rwFwdRef').value = '';
        await this.refresh(); this.renderD4d(); this.message(`Marked ${r.count} donation${r.count === 1 ? '' : 's'} (${money(r.amount)}) as sent to ManUp.`);
      });
    },
    refund(btn, d) {
      return this.busyRun(btn, async () => {
        const why = root.prompt(`Refund ${money(d.amount)} from ${d.donor_name}? Say why:`);
        if (!why) return;
        const r = await ShApi.rpc('shop_d4d_refund', { p_id: d.id, p_reason: why });
        await this.refresh(); this.renderD4d();
        this.message(r.was_forwarded ? 'Refunded. This one was already sent to ManUp, so it needs to come back from them.' : 'Refunded.');
      });
    },
  };

  root.RwApp = App;
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => App.init());
})(typeof window !== 'undefined' ? window : globalThis);
