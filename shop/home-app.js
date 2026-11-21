/* Shop home strip, shown above the job board after a staff sign-in.
   Per signed-in person: shop appointments plus their own personal ones for
   the next 7 days, their hours earned this week / month / year from tech
   sign-off, and shortcuts (consignment, warehouse, money, receipts, pay
   stubs). Money shows only for the payroll manager or staff with money
   access. Needs shop-011; without it the strip says what is missing and the
   job board below works as before. Text is written with textContent only. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const hrs = v => { const n = Number(v) || 0; return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''); };
  const li = (when, title, tag) => {
    const row = document.createElement('li');
    const w = document.createElement('span'); w.className = 'sh-home-when'; w.textContent = when;
    const t = document.createElement('span'); t.textContent = title;
    if (tag) { const g = document.createElement('span'); g.className = 'sh-home-tag'; g.textContent = tag; t.append(g); }
    row.append(w, t); return row;
  };
  const note = text => { const row = document.createElement('li'); row.className = 'sh-muted'; row.textContent = text; return row; };
  const whenText = a => {
    const d = new Date(a.starts_at); const today = new Date(); const tom = new Date(Date.now() + 86400000);
    const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === tom.toDateString() ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    return a.all_day ? day : `${day} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  };

  async function load(user) {
    $('shHome').hidden = false;
    const [me, hours, appts] = await Promise.all([
      ShApi.rpc('shop_me', {}).catch(() => null),
      ShApi.rpc('shop_my_hours', {}).catch(() => undefined),
      ShApi.select('shop_appointments', 'select=id,title,starts_at,ends_at,all_day,visibility,cancelled,owner_user_id&order=starts_at.asc').catch(() => null),
    ]);
    const name = me?.name || (user?.email || '').split('@')[0];
    $('hmHi').textContent = name ? `Hi, ${name}` : 'Shop home';
    $('hmMoney').hidden = !me?.money;
    if (hours === undefined || hours === null) {
      ['hmWeek', 'hmMonth', 'hmYear'].forEach(id => { $(id).textContent = '–'; });
      $('hmHoursNote').textContent = 'Hours show here once the shop-011 database file is run on the server.';
    } else {
      $('hmWeek').textContent = hrs(hours.week); $('hmMonth').textContent = hrs(hours.month); $('hmYear').textContent = hrs(hours.year);
      $('hmHoursNote').textContent = 'From tech sign-off on finished steps.' + (hours.disputed ? ` ${hours.disputed} of your steps this year are disputed and waiting on the payroll manager.` : '');
    }
    const list = $('hmAppts');
    if (!appts) { list.replaceChildren(note('The shop calendar shows here once the shop-011 database file is run on the server.')); return; }
    const now = Date.now(), end = now + 7 * 86400000;
    const soon = appts.filter(a => !a.cancelled && new Date(a.ends_at || a.starts_at).getTime() >= now - 3600000 && new Date(a.starts_at).getTime() <= end);
    list.replaceChildren(...(soon.length ? soon.slice(0, 8).map(a => li(whenText(a), a.title, a.visibility === 'personal' ? 'personal' : null))
      : [note('Nothing on the calendar for the next 7 days.')]));
  }

  document.addEventListener('shop:ready', e => { load(e.detail?.user).catch(() => { /* home strip is extra; the job board still works */ }); });
  document.addEventListener('shop:signedout', () => { $('shHome').hidden = true; });
})(window);
