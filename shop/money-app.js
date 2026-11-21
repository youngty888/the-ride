/* Money in vs out for a date range (shop_money_summary, shop-011). The
   database only answers for the payroll manager or staff with money access. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const money = v => (Number(v) < 0 ? '-' : '') + '$' + Math.abs(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const show = id => { for (const v of document.querySelectorAll('.mo-view')) v.hidden = v.id !== id; };
  const msg = (t, bad) => { const m = $('moMsg'); m.textContent = t || ''; m.hidden = !t; m.classList.toggle('sh-msg-error', !!bad); };
  const row = (...cells) => { const tr = document.createElement('tr'); cells.forEach(([t, cls]) => { const td = document.createElement('td'); td.textContent = t; if (cls) td.className = cls; tr.append(td); }); return tr; };

  function period(p) {
    const n = new Date(); let from;
    if (p === 'week') { from = new Date(n); from.setDate(n.getDate() - ((n.getDay() + 6) % 7)); }   // weeks start Monday
    else if (p === 'year') from = new Date(n.getFullYear(), 0, 1);
    else from = new Date(n.getFullYear(), n.getMonth(), 1);
    $('moFrom').value = ymd(from); $('moTo').value = ymd(n);
  }

  async function load() {
    const from = $('moFrom').value, to = $('moTo').value;
    if (!from || !to) return;
    try {
      const m = await ShApi.rpc('shop_money_summary', { p_from: from, p_to: to });
      msg('');
      $('moIn').textContent = money(m.money_in); $('moOut').textContent = money(m.money_out); $('moNet').textContent = money(m.net);
      $('moInRows').replaceChildren(
        row([`Jobs marked paid (${m.in_jobs_count})`], [money(m.in_jobs), 'num']),
        row([m.plans_installed ? `Payment plan payments (${m.in_plans_count})` : 'Payment plan payments (not set up yet)'], [money(m.in_plans), 'num']));
      $('moPartNote').textContent = m.part_paid_count ? `${m.part_paid_count} part-paid job${m.part_paid_count === 1 ? '' : 's'} (${money(m.part_paid_total)} total) ${m.part_paid_count === 1 ? 'is' : 'are'} not counted, because the shop doesn't record how much was paid on them.` : '';
      const cats = m.out_by_category || [];
      $('moOutRows').replaceChildren(...(cats.length ? cats.map(c => row([c.category], [String(c.count), 'num'], [money(c.amount), 'num'])) : [row(['No receipts in this period.'], [''], [''])]));
      show('moMain');
    } catch (e) {
      if (/money access/.test(e.message || '')) { show('moBlocked'); return; }
      if (e.status === 401) { $('moBlockedText').textContent = 'Sign in on the shop page first.'; show('moBlocked'); return; }
      if (/Pick a date range/.test(e.message || '')) { msg('The From date is after the To date.', true); return; }
      msg(e.status === 404 ? 'Money is not set up on the server yet (ask Tyler to run the shop-011 SQL file).' : `Could not load money: ${e.message}`, true);
      show('moMain');
    }
  }

  async function init() {
    try { await ShApi.verify(); } catch { $('moBlockedText').textContent = 'Sign in on the shop page first.'; show('moBlocked'); return; }
    $('moChips').addEventListener('click', e => {
      const b = e.target.closest('[data-p]'); if (!b) return;
      $('moChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      period(b.dataset.p); load();
    });
    ['moFrom', 'moTo'].forEach(id => $(id).addEventListener('change', () => { $('moChips').querySelectorAll('button').forEach(x => x.classList.remove('on')); load(); }));
    period('month'); load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
