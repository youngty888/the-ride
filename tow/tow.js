/* Moto Tow public page (ride.siccycles.com/tow/). Anyone can ask for a tow
   here without an account. A rider signed in to RIDE gets the form filled in
   from their account and Garage. The database (shop_tow_request, shop-014) checks
   everything and sets the price itself; this page only shows a preview.
   ?sign=<token> opens the waiver alone, for calls the crew took by phone. */
(function () {
  'use strict';
  const PHONE = '+15209995691';   // Moto Tow line, 520-999-5691. Empty hides the call button.
  const $ = id => document.getElementById(id);
  const C = window.TowCalc;
  const cfg = window.SICC_RIDE_SUPABASE || {};
  let waiver = null;

  function msg(t) { const m = $('mtMsg'); m.textContent = t || ''; m.hidden = !t; if (t) setTimeout(() => { if (m.textContent === t) m.hidden = true; }, 8000); }

  // token: a signed-in rider's access token, or nothing for a guest.
  async function rpc(fn, args, token) {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token || cfg.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    });
    const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) { const e = new Error((data && data.message) || 'Something went wrong. Call or text us.'); e.status = res.status; throw e; }
    return data;
  }

  // ---------- signed-in RIDE rider ----------
  // Same sign-in the RIDE app keeps on this site (auth-guard.js). A refreshed
  // sign-in is saved back the same way, so the app stays signed in too.
  // Riders only ever get their own details back (shop_tow_my_info, shop-015).
  const SESSION_KEY = 'sicc-ride-auth-session';
  const store = window.RideSessionStore;
  const readSession = () => { try { return store ? JSON.parse(store.getItem(SESSION_KEY)) : null; } catch { return null; } };
  const jwt = t => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } };
  let riderId = '';

  async function riderToken() {
    const s = readSession(); if (!s || !s.access_token) return null;
    if ((jwt(s.access_token).exp || 0) * 1000 > Date.now() + 60000) return s.access_token;
    if (!s.refresh_token) return null;
    try {
      const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      const now = readSession();
      if (now && now.access_token !== s.access_token) return now.access_token;   // another tab refreshed first
      if (!res.ok) return null;
      const next = await res.json();
      if (!next || !next.access_token) return null;
      store.setItem(SESSION_KEY, JSON.stringify(next));
      return next.access_token;
    } catch { return null; }
  }

  // Bikes this device has that may not be saved online yet (the app's own copy).
  function localGarage(uid) {
    try {
      const raw = localStorage.getItem(`rideflow_bikes:${uid}`);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(b => b && typeof b === 'object' && b.id) : [];
    } catch { return []; }
  }

  const bikeText = b => [b.year, b.make, b.model].filter(Boolean).join(' ').trim().slice(0, 100)
    + (b.color ? ` (${String(b.color).slice(0, 30)})` : '');
  const bikeLabel = b => (b.nickname ? `${b.nickname}: ` : '') + (bikeText(b) || 'Bike');

  async function initRider(f) {
    const s = readSession();
    riderId = (s && ((s.user && s.user.id) || jwt(s.access_token || '').sub)) || '';
    if (!riderId) { $('mtGuest').hidden = false; return; }
    const token = await riderToken();
    if (!token) { $('mtGuest').hidden = false; riderId = ''; return; }
    let info = null;
    try { info = await rpc('shop_tow_my_info', {}, token); } catch { /* before shop-015 runs: use what this device has */ }
    info = info || {};
    const fill = (name, v) => { if (v && !String(f[name].value || '').trim()) f[name].value = v; };
    fill('customer_name', info.name);
    fill('phone', info.phone);
    fill('email', info.email || (s.user && s.user.email));

    const bikes = new Map();
    for (const b of (Array.isArray(info.bikes) ? info.bikes : [])) if (b && b.id) bikes.set(String(b.id), b);
    for (const b of localGarage(riderId)) bikes.set(String(b.id), b);   // this device's copy is the newest
    $('mtRider').hidden = false;
    $('mtRiderHi').textContent = `Signed in to RIDE${info.name ? ' as ' + info.name : ''}. ${bikes.size ? 'Pick your bike and we fill in the rest.' : 'Your details are filled in. Add your bike to your Garage in RIDE to skip typing it next time.'}`;
    if (!bikes.size) return;
    const sel = $('mtBike');
    sel.replaceChildren(...[...bikes.values()].map(b => new Option(bikeLabel(b), String(b.id))), new Option('Something else (type it below)', ''));
    const want = new URLSearchParams(location.search).get('bike');
    sel.value = want && bikes.has(want) ? want : String([...bikes.keys()][0]);
    const pick = () => {
      const b = bikes.get(sel.value);
      if (!b) return;
      f.vehicle_type.value = 'motorcycle';
      f.vehicle.value = bikeText(b);
      quote();
    };
    sel.addEventListener('change', pick); pick();
    $('mtBikeWrap').hidden = false;
  }

  // ---------- signature pad ----------
  function pad(canvas) {
    const ctx = canvas.getContext('2d'); let drawing = false; let strokes = 0; let last = null;
    const pos = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000';
    canvas.addEventListener('pointerdown', e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
    canvas.addEventListener('pointermove', e => {
      if (!drawing) return; const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; strokes++;
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
    return {
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); strokes = 0; },
      empty() { return strokes < 5; },
      // White background so the PNG reads on any viewer.
      png() { const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
        const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0); return out.toDataURL('image/png'); },
    };
  }

  function setupWaiver(form) {
    const p = pad(form.querySelector('canvas'));
    form.querySelector('[data-clear]').addEventListener('click', () => p.clear());
    return p;
  }

  async function loadWaiver() {
    try {
      waiver = await rpc('shop_tow_waiver_text');
      document.querySelectorAll('[data-waiver]').forEach(d => { d.textContent = waiver.body; });
    } catch { document.querySelectorAll('[data-waiver]').forEach(d => { d.textContent = 'The waiver could not load. Call or text us to book.'; }); }
  }

  // ---------- booking ----------
  function quote() {
    const f = $('mtForm'); const z = f.zone.value; const toShop = f.to_shop.checked;
    $('mtDropWrap').hidden = toShop;
    const p = C.quote(z, { toShop });
    $('mtQuote').textContent = p == null ? 'We will call you with a price.' : z === 'tucson' ? `${C.money(p)} within 15 miles of our shop. Farther out adds $3.50 a mile; we confirm before you pay.` : `${C.money(p)} flat.`;
  }

  function initBooking() {
    const f = $('mtForm');
    $('mtType').replaceChildren(...Object.entries(C.VEHICLES).map(([v, t]) => new Option(t, v)));
    $('mtZone').replaceChildren(...Object.entries(C.ZONES).map(([v, z]) => new Option(z.label, v)));
    const sig = setupWaiver(f);
    f.addEventListener('change', quote); quote();
    initRider(f);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(f); const p = Object.fromEntries(fd);
      for (const k of ['customer_name', 'phone', 'pickup_address']) if (!String(p[k] || '').trim()) { msg('Fill in your name, phone and where to pick it up.'); f[k].focus(); return; }
      if (!f.agree.checked) { msg('Read and agree to the waiver to continue.'); return; }
      if (sig.empty()) { msg('Sign in the white box.'); return; }
      if (!waiver) { msg('The waiver did not load. Call or text us.'); return; }
      p.to_shop = f.to_shop.checked; p.ride_along = f.ride_along.checked; p.agree = true;
      p.vehicle_runs = p.vehicle_runs === '' ? null : p.vehicle_runs === 'true';
      p.signature = sig.png(); p.waiver_version = waiver.version;
      if (riderId && !$('mtBikeWrap').hidden && $('mtBike').value) p.bike_id = $('mtBike').value;
      const b = f.querySelector('button[type=submit]'); b.disabled = true;
      try {
        // A signed-in rider's tow is saved with their account. If that sign-in
        // has run out, the tow still goes in as a guest's.
        const token = riderId ? await riderToken() : null;
        let r;
        try { r = await rpc('shop_tow_request', { p }, token); }
        catch (err) { if (token && err.status === 401) r = await rpc('shop_tow_request', { p }); else throw err; }
        $('mtSite').hidden = true; $('mtDone').hidden = false; window.scrollTo(0, 0);
        $('mtDoneTitle').textContent = `Got it. Your tow number is ${r.ref}`;
        if (r.price == null) $('mtDoneText').textContent = 'We will call you with a price, then text or email you an invoice, or you can pay by Zelle. Once it is paid, we head your way.';
        else $('mtDoneText').textContent = `${r.price_is_start ? 'Price: ' + C.money(r.price) + ' if you are within 15 miles of our shop. We call to confirm the miles first.' : 'Price: ' + C.money(r.price) + '.'} Pay first, then a driver heads your way.`;
        if (r.pay_link && /^https:\/\//.test(r.pay_link)) { $('mtPay').href = r.pay_link; $('mtPay').hidden = false; }
        $('mtDoneNote').textContent = `${r.pay_link ? 'Put ' + r.ref + ' in the payment note.' : 'We will text or email you an invoice for ' + r.ref + ', or you can pay by Zelle with ' + r.ref + ' in the note.'} No pickup until it is paid. Same price day or night.`;
      } catch (err) { msg(err.message); } finally { b.disabled = false; }
    });
  }

  // ---------- waiver from a link ----------
  async function initSign(token) {
    $('mtSite').hidden = true; $('mtSignView').hidden = false;
    const f = $('mtSignForm'); const sig = setupWaiver(f);
    let info = null;
    try { info = await rpc('shop_tow_sign_info', { p_token: token }); } catch { /* below */ }
    if (!info) { $('mtSignIntro').textContent = 'This link is not valid. Call or text us.'; f.hidden = true; return; }
    if (info.signed) { $('mtSignIntro').textContent = `Thanks ${info.first_name}, your waiver for tow ${info.ref} is already signed.`; f.hidden = true; return; }
    $('mtSignIntro').textContent = `Hi ${info.first_name}. Please read and sign the waiver for tow ${info.ref}.`;
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (sig.empty()) { msg('Sign in the white box.'); return; }
      if (!waiver) { msg('The waiver did not load. Call or text us.'); return; }
      const b = f.querySelector('button[type=submit]'); b.disabled = true;
      try {
        await rpc('shop_tow_sign', { p_token: token, p_name: f.waiver_name.value, p_signature: sig.png(), p_version: waiver.version });
        f.hidden = true; $('mtSignIntro').textContent = `Signed. Thank you. Once it's paid, we head your way for tow ${info.ref}.`;
      } catch (err) { msg(err.message); } finally { b.disabled = false; }
    });
  }

  function init() {
    if (PHONE) { $('mtCall').href = `tel:${PHONE}`; $('mtCall').textContent = 'Call or text 520-999-5691'; $('mtCall').hidden = false; }
    loadWaiver();
    const token = new URLSearchParams(location.search).get('sign');
    if (token) initSign(token); else initBooking();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
