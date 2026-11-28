/* Moto Tow board (shop/tow.html). Every rule (who may see, pay first, waiver
   signed, who may claim, pay split) is checked by the database (shop-014);
   this page only shows what it answers. Text from customers is only ever put
   on the page with textContent. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.TowCalc;
  const VIEWS = ['twLoading', 'twSignIn', 'twBlocked', 'twMain'];
  const show = id => VIEWS.forEach(v => { $(v).hidden = v !== id; });
  const msg = (t, bad) => { const m = $('twMsg'); m.textContent = t || ''; m.hidden = !t; m.classList.toggle('sh-msg-error', !!bad); if (t) m.scrollIntoView({ block: 'nearest' }); };
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const btn = (label, fn, primary) => { const b = el('button', label, 'sh-btn' + (primary ? ' sh-btn-primary' : '')); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const when = iso => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const STATUS = { new: 'New', quoted: 'Quoted, waiting on payment', paid: 'Paid, ready to go', en_route: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };
  const SIGN_BASE = new URL('../tow/', location.href).href;

  let me = null; let tows = []; let tab = 'open'; let crew = [];

  async function call(fn, args, okText) {
    try { const r = await ShApi.rpc(fn, args); if (okText) msg(okText); return r; }
    catch (e) { msg(e.status === 404 ? 'The tow board is not set up on the server yet (ask Tyler to run the shop-014 SQL file).' : e.message, true); throw e; }
  }

  // ---------- cards ----------
  function fact(dl, k, v, cls) { if (v == null || v === '') return; dl.append(el('dt', k)); dl.append(el('dd', v, cls)); }

  function card(t) {
    const node = $('twCardTpl').content.firstElementChild.cloneNode(true);
    node.dataset.s = t.status;
    const k = n => node.querySelector(`[data-k="${n}"]`);
    k('title').textContent = `${t.ref} · ${C.VEHICLES[t.vehicle_type] || t.vehicle_type}${t.vehicle ? ' · ' + t.vehicle : ''}`;
    k('badge').textContent = STATUS[t.status] || t.status;
    const dl = k('facts');
    fact(dl, 'Customer', `${t.customer_name} · ${t.phone}${t.email ? ' · ' + t.email : ''}`);
    fact(dl, 'Pick up', t.pickup_address);
    fact(dl, 'Drop off', t.to_shop ? 'SIC Cycles (shop price)' : t.dropoff_address);
    fact(dl, 'Area', (C.ZONES[t.zone] || {}).label + (t.miles != null ? ` · ${t.miles} mi` : ''));
    fact(dl, 'Price', t.price != null ? C.money(t.price) : 'Needs a price', t.price != null ? '' : 'tw-warn');
    fact(dl, 'Paid', t.paid_at ? `${t.paid_method} · ${t.paid_ref}` : 'Not paid', t.paid_at ? 'tw-ok' : 'tw-warn');
    fact(dl, 'Waiver', t.waiver_signed ? 'Signed' : 'Not signed', t.waiver_signed ? 'tw-ok' : 'tw-warn');
    if (t.before_photos != null) fact(dl, 'Before-tow photos', `${t.before_photos} of ${MIN_PHOTOS}${t.before_photos >= MIN_PHOTOS ? '' : ' needed before the tow starts'}`, t.before_photos >= MIN_PHOTOS ? 'tw-ok' : 'tw-warn');
    fact(dl, 'Vehicle runs', t.vehicle_runs == null ? '' : t.vehicle_runs ? 'Yes' : 'No');
    fact(dl, 'Rides along', t.rider_count ? 'Customer rides along' : '');
    fact(dl, 'Crew', [t.driver_name && `Driver: ${t.driver_name}`, t.navigator_name && `Navigator: ${t.navigator_name}`].filter(Boolean).join(' · ') || 'Nobody yet');
    if (t.status === 'delivered') fact(dl, 'Crew pay', [`${t.driver_name}: ${C.money(t.driver_pay)}`, t.navigator_name && `${t.navigator_name}: ${C.money(t.navigator_pay)}`].filter(Boolean).join(' · '));
    if (t.refund_due) fact(dl, 'Refund', 'Paid before it was cancelled. Refund is due.', 'tw-warn');
    fact(dl, 'Notes', t.notes);
    fact(dl, 'Came in', `${when(t.created_at)} by ${t.source}${t.rider_id ? ' (signed in to RIDE)' : ''}`);
    if (t.cancel_reason) fact(dl, 'Cancelled', t.cancel_reason);

    const a = k('actions'); const extra = k('extra');
    const open = !['delivered', 'cancelled'].includes(t.status);
    const run = async (fn, args, ok) => { try { await call(fn, { p_id: t.id, ...args }, ok); await load(); } catch { /* message shown */ } };
    if (open) {
      if (me.crew_member && !t.driver_id && t.navigator_id !== me.user_id) a.append(btn('Take it (driver)', () => run('shop_tow_claim', { p_role: 'driver' }, `You are driving ${t.ref}.`), true));
      if (me.crew_member && t.driver_id && t.driver_id !== me.user_id && !t.navigator_id) a.append(btn('Ride along (navigator)', () => run('shop_tow_claim', { p_role: 'navigator' }, `You are riding along on ${t.ref}.`)));
      if (t.mine && t.status !== 'en_route') a.append(btn('Drop it', () => run('shop_tow_unclaim', {}, `You dropped ${t.ref}.`)));
      if (!t.paid_at || me.admin) a.append(btn(t.price == null ? 'Set price' : 'Change price', () => priceForm(extra, t)));
      if (!t.paid_at && t.price != null) a.append(btn('Mark paid', () => paidForm(extra, t), true));
      if (!t.waiver_signed) a.append(btn('Waiver link', () => signLink(extra, t)));
      if (t.before_photos != null && t.status !== 'en_route') a.append(btn('Before-tow photos', () => photoPanel(extra, t), t.status === 'paid' && t.before_photos < MIN_PHOTOS));
      if (t.status === 'paid' && (t.mine || me.admin)) a.append(btn('Start tow', () => run('shop_tow_start', {}, `${t.ref} is on the way.`), true));
      if (t.status === 'en_route' && (t.mine || me.admin)) a.append(btn('Delivered', () => run('shop_tow_deliver', {}, `${t.ref} delivered. Crew pay is saved.`), true));
      a.append(btn('Cancel', () => cancelForm(extra, t)));
    }
    if (t.waiver_signed) a.append(btn('See waiver', () => showWaiver(extra, t)));
    if (me.admin) a.append(btn('Set crew', () => crewForm(extra, t)));
    return node;
  }

  // ---------- before-tow photos (shop-018) ----------
  // Taken at the pickup spot before it goes on the trailer. Each one is stamped
  // with the server time and who took it, and can't be changed or deleted.
  const MIN_PHOTOS = 4; const PHOTO_BUCKET = 'shop-condition-photos';
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  async function photoPanel(extra, t) {
    let photos;
    try { photos = await ShApi.select('shop_condition_photos', `select=id,storage_path,taken_at&tow_id=eq.${encodeURIComponent(t.id)}&order=taken_at.asc`); }
    catch (e) { msg(`Could not open photos: ${e.message}`, true); return; }
    const box = el('div', null, 'tw-photos');
    box.append(el('p', `Get the front, back, both sides and any damage up close. ${photos.length} saved so far.`, 'sh-muted'));
    const grid = el('div', null, 'tw-photo-grid');
    for (const p of photos) {
      const fig = el('figure'); const img = el('img'); img.alt = 'Before-tow photo';
      ShApi.download(PHOTO_BUCKET, p.storage_path).then(b => { img.src = URL.createObjectURL(b); }).catch(() => { img.alt = 'Photo unavailable'; });
      fig.append(img, el('figcaption', when(p.taken_at))); grid.append(fig);
    }
    const input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.setAttribute('capture', 'environment');
    input.setAttribute('aria-label', `Before-tow photos for ${t.ref}`);
    const save = btn('Save photos', async () => {
      const files = [...input.files];
      if (!files.length) { msg('Take or pick at least one photo first.', true); return; }
      save.disabled = true; let n = 0;
      try {
        for (const file of files) {
          save.textContent = `Saving ${n + 1} of ${files.length}…`;
          const id = newId(); const ext = (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] || 'jpg').toLowerCase();
          const path = `tow/${t.id}/${Date.now()}-${id.slice(0, 8)}.${ext}`;
          await ShApi.upload(PHOTO_BUCKET, path, file, file.type || 'image/jpeg');
          await ShApi.rpc('shop_add_condition_photo', { p_id: id, p_kind: 'before_tow', p_target_id: t.id, p_path: path, p_note: null });
          n++;
        }
        msg(`${n} before-tow photo${n === 1 ? '' : 's'} saved for ${t.ref}.`);
      } catch (e) { msg(`${n ? `${n} saved, then ` : ''}a photo was not saved: ${e.message}. Pick the rest again and press Save.`, true); }
      await load();
    }, true);
    const pick = el('label', 'Take or pick photos'); pick.append(input);
    box.append(grid, pick, save);
    extra.replaceChildren(box);
  }

  function inlineForm(extra, fields, submitLabel, onSubmit) {
    const f = el('form', null, 'tw-inline');
    for (const [name, label, type, value, opts] of fields) {
      const l = el('label', label);
      let input;
      if (opts) { input = el('select'); for (const [v, t] of opts) { const o = el('option', t); o.value = v; input.append(o); } }
      else { input = el('input'); input.type = type || 'text'; }
      input.name = name; if (value != null) input.value = value;
      l.append(input); f.append(l);
    }
    const b = el('button', submitLabel, 'sh-btn sh-btn-primary'); b.type = 'submit'; f.append(b);
    f.addEventListener('submit', async e => { e.preventDefault(); b.disabled = true; try { await onSubmit(new FormData(f)); } finally { b.disabled = false; } });
    extra.replaceChildren(f); f.querySelector('input,select')?.focus();
  }

  const priceForm = (extra, t) => inlineForm(extra, [
    ['miles', 'Miles from shop', 'text', t.miles ?? ''],
    ['price', 'Price $ (blank = standard)', 'text', t.price ?? '']], 'Save price',
  async fd => { await call('shop_tow_set_price', { p_id: t.id, p_price: fd.get('price'), p_miles: fd.get('miles') }, `Price saved for ${t.ref}. Send them the payment link.`); load(); });

  const paidForm = (extra, t) => inlineForm(extra, [
    ['method', 'Paid with', null, 'Square', [['Square', 'Square'], ['Stripe', 'Stripe'], ['PayPal', 'PayPal'], ['Cash App', 'Cash App'], ['Zelle', 'Zelle'], ['Cash', 'Cash']]],
    ['ref', 'Payment or receipt #', 'text', '']], `Mark ${C.money(t.price)} paid`,
  async fd => { await call('shop_tow_mark_paid', { p_id: t.id, p_method: fd.get('method'), p_ref: fd.get('ref') }, `${t.ref} marked paid.`); load(); });

  const cancelForm = (extra, t) => inlineForm(extra, [['reason', 'Why cancel', 'text', '']], 'Cancel tow',
    async fd => { await call('shop_tow_cancel', { p_id: t.id, p_reason: fd.get('reason') }, t.paid_at ? `${t.ref} cancelled. It was paid, so a refund is due.` : `${t.ref} cancelled.`); load(); });

  async function signLink(extra, t) {
    try {
      const token = await call('shop_tow_sign_link', { p_id: t.id });
      const url = `${SIGN_BASE}?sign=${encodeURIComponent(token)}`;
      const box = el('div'); const input = el('input'); input.readOnly = true; input.value = url;
      box.append(el('p', 'Text or email this link to the customer. They read and sign the waiver there.', 'sh-muted'), input);
      if (navigator.clipboard) box.append(btn('Copy link', async () => { await navigator.clipboard.writeText(url); msg('Waiver link copied.'); }));
      extra.replaceChildren(box);
    } catch { /* message shown */ }
  }

  async function showWaiver(extra, t) {
    try {
      const w = await call('shop_tow_waiver', { p_id: t.id });
      const box = el('div');
      box.append(el('p', `Signed by ${w.name} on ${when(w.signed_at)} (waiver ${w.version})`, 'sh-muted'));
      const img = el('img', null, 'tw-sig'); img.alt = 'Customer signature'; if (/^data:image\/png;base64,/.test(w.signature || '')) img.src = w.signature;
      const body = el('pre', w.body); body.style.whiteSpace = 'pre-wrap'; body.style.fontSize = '.85rem';
      box.append(img, body); extra.replaceChildren(box);
    } catch { /* message shown */ }
  }

  async function crewForm(extra, t) {
    if (!crew.length) { try { crew = await call('shop_tow_crew_list', {}); } catch { return; } }
    const opts = [['', 'Nobody'], ...crew.map(c => [c.user_id, c.name])];
    inlineForm(extra, [['driver', 'Driver', null, t.driver_id || '', opts], ['navigator', 'Navigator', null, t.navigator_id || '', opts]], 'Save crew',
      async fd => { await call('shop_tow_assign', { p_id: t.id, p_driver: fd.get('driver') || null, p_navigator: fd.get('navigator') || null }, `Crew saved for ${t.ref}.`); load(); });
  }

  function renderLists() {
    const open = tows.filter(t => !['delivered', 'cancelled'].includes(t.status));
    const list = (id, items, empty) => $(id).replaceChildren(...(items.length ? items.map(card) : [el('p', empty, 'sh-muted')]));
    list('twOpenList', open, 'No open tows.');
    list('twMineList', tows.filter(t => t.mine && !['cancelled'].includes(t.status)), 'You have not taken any tows yet.');
    list('twDoneList', tows.filter(t => ['delivered', 'cancelled'].includes(t.status)), 'Nothing delivered in the last 30 days.');
  }

  function renderDuty() {
    $('twDutyState').textContent = me.on_duty ? 'On duty' : 'Off duty';
    $('twDutyState').className = me.on_duty ? 'tw-on' : 'tw-off';
    const names = me.on_duty_names || [];
    $('twDutyWho').textContent = names.length ? `On duty now: ${names.join(', ')}` : 'Nobody is on duty. New tows alert no one.';
    $('twDutyPhone').value = me.alert_phone || ''; $('twDutyEmail').value = me.alert_email || '';
    $('twDutyBtn').textContent = me.on_duty ? 'Go off duty' : 'Go on duty';
    $('twDutyForm').hidden = !me.crew_member;
  }

  async function load() {
    try { tows = await call('shop_tow_board', { p_days: 30 }); renderLists(); } catch { /* message shown */ }
  }

  // ---------- pay ----------
  function payPeriod(p) {
    const n = new Date(); const monday = new Date(n); monday.setDate(n.getDate() - ((n.getDay() + 6) % 7));
    let from = monday, to = n;
    if (p === 'last') { from = new Date(monday); from.setDate(monday.getDate() - 7); to = new Date(monday); to.setDate(monday.getDate() - 1); }
    if (p === 'month') from = new Date(n.getFullYear(), n.getMonth(), 1);
    $('twPayFrom').value = ymd(from); $('twPayTo').value = ymd(to);
  }
  async function loadPay() {
    let r; try { r = await call('shop_tow_pay', { p_from: $('twPayFrom').value, p_to: $('twPayTo').value }); } catch { return; }
    const out = [];
    if (r.admin) {
      const s = el('div', null, 'sh-card');
      s.append(el('p', `${r.tows} tows delivered · ${C.money(r.revenue)} in · ${C.money(r.crew_pay)} crew pay · ${C.money(r.revenue - r.crew_pay)} left before gas and costs`));
      out.push(s);
    }
    if (!r.people.length) out.push(el('p', 'No delivered tows in this period.', 'sh-muted'));
    for (const p of r.people) {
      const s = el('section', null, 'sh-card');
      s.append(el('h2', `${p.name}: ${C.money(p.pay)}`), el('p', `Drove ${p.drove} · Rode along ${p.rode}`, 'sh-muted'));
      const tb = el('table', null, 'tw-table'); const head = el('tr');
      ['Day', 'Tow', 'Role', 'Price', 'Pay'].forEach((h, i) => head.append(el('th', h, i > 2 ? 'num' : '')));
      const body = el('tbody');
      for (const x of p.tows) { const tr = el('tr'); [x.day, x.ref, x.role === 'driver' ? 'Driver' : 'Navigator', C.money(x.price), C.money(x.pay)].forEach((v, i) => tr.append(el('td', v, i > 2 ? 'num' : ''))); body.append(tr); }
      const th = el('thead'); th.append(head); tb.append(th, body); s.append(tb); out.push(s);
    }
    $('twPayOut').replaceChildren(...out);
  }

  // ---------- settings ----------
  function preview() {
    const f = $('twSetForm'); const s = { solo_pct: f.solo_pct.value, pair_pct: f.pair_pct.value, driver_pct: f.driver_pct.value };
    const rows = [['Tucson', 125], ['Tucson to SIC Cycles', 100], ['Sierra Vista', 295], ['Phoenix', 425], ['Phoenix to SIC Cycles', 375]].map(([name, price]) => {
      const solo = C.crewPay(price, s); const pair = C.crewPay(price, { ...s, navigator: true });
      const tr = el('tr'); [name, C.money(price), C.money(solo.driver), C.money(pair.driver), C.money(pair.navigator), C.money(price - pair.pool)]
        .forEach((v, i) => tr.append(el('td', v, i ? 'num' : ''))); return tr;
    });
    $('twSetPreview').replaceChildren(...rows);
  }
  function fillSettings() {
    const f = $('twSetForm'); const s = me.settings || {};
    for (const k of ['solo_pct', 'pair_pct', 'driver_pct', 'pay_link_tucson', 'pay_link_sierra_vista', 'pay_link_phoenix']) f[k].value = s[k] ?? '';
    preview();
  }

  function setTab(t) {
    tab = t;
    $('twTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    for (const [id, name] of [['tabOpen', 'open'], ['tabMine', 'mine'], ['tabDone', 'done'], ['tabPay', 'pay'], ['tabSettings', 'settings']]) $(id).hidden = name !== t;
    if (t === 'pay') loadPay();
  }

  function addPricePreview() {
    const f = $('twAddForm');
    const p = C.quote(f.zone.value, { toShop: f.to_shop.checked, miles: f.miles.value });
    $('twAddPrice').textContent = p == null ? 'Somewhere else: set the price on the card after you add it.' : `Standard price: ${C.money(p)}`;
  }

  async function start() {
    try { me = await ShApi.rpc('shop_tow_me', {}); }
    catch (e) { if (e.status === 401) { show('twSignIn'); return; } if (!e.status) { show('twSignIn'); msg('Could not reach the shop. Check your signal and reload.', true); return; } msg(e.status === 404 ? 'The tow board is not set up on the server yet (ask Tyler to run the shop-014 SQL file).' : e.message, true); show('twBlocked'); return; }
    $('twSignOut').hidden = false;
    if (!me) { show('twBlocked'); return; }
    $('twTabSettings').hidden = !me.admin;
    renderDuty(); if (me.admin) fillSettings();
    show('twMain'); load();
  }

  function init() {
    for (const [id, map] of [['twAddType', C.VEHICLES], ['twAddZone', Object.fromEntries(Object.entries(C.ZONES).map(([k, z]) => [k, z.label]))]]) {
      $(id).replaceChildren(...Object.entries(map).map(([v, t]) => { const o = el('option', t); o.value = v; return o; }));
    }
    $('twAddForm').addEventListener('input', addPricePreview); addPricePreview();
    $('twAddForm').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target; const fd = new FormData(f); const p = Object.fromEntries(fd);
      p.to_shop = f.to_shop.checked; p.ride_along = f.ride_along.checked;
      try { const t = await call('shop_tow_add_call', { p }, null); f.reset(); $('twAddWrap').open = false;
        msg(`${t.ref} added. Send them the waiver link (on the card) and the payment link.`); load(); } catch { /* shown */ }
    });
    $('twSignInForm').addEventListener('submit', async e => {
      e.preventDefault();
      try { await ShApi.signIn($('twEmail').value.trim(), $('twPassword').value); $('twPassword').value = ''; msg(''); start(); }
      catch (err) { msg(err.status === 400 ? 'That email and password did not match.' : err.message, true); }
    });
    $('twSignOut').addEventListener('click', async () => { await ShApi.signOut(); location.reload(); });
    $('twDutyForm').addEventListener('submit', async e => {
      e.preventDefault();
      try { me = await call('shop_tow_set_duty', { p_on: !me.on_duty, p_phone: $('twDutyPhone').value, p_email: $('twDutyEmail').value },
        me.on_duty ? 'You are off duty.' : 'You are on duty. New tows will alert you.'); renderDuty(); } catch { /* shown */ }
    });
    $('twTabs').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) setTab(b.dataset.t); });
    $('twPayChips').addEventListener('click', e => {
      const b = e.target.closest('[data-p]'); if (!b) return;
      $('twPayChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); payPeriod(b.dataset.p); loadPay();
    });
    ['twPayFrom', 'twPayTo'].forEach(id => $(id).addEventListener('change', () => { $('twPayChips').querySelectorAll('button').forEach(x => x.classList.remove('on')); loadPay(); }));
    payPeriod('week');
    $('twSetForm').addEventListener('input', preview);
    $('twSetForm').addEventListener('submit', async e => {
      e.preventDefault(); const p = Object.fromEntries(new FormData(e.target));
      try { me = await call('shop_tow_save_settings', { p }, 'Tow settings saved. New deliveries use these percents.'); fillSettings(); } catch { /* shown */ }
    });
    setInterval(() => { if (!document.hidden && me && tab !== 'pay' && tab !== 'settings') load(); }, 60000);
    start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
