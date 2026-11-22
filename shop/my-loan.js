/* "My loan": a customer signs in and sees only their own payment plan (read-only).
   All data comes from the database function shop_my_payment_plans(), which matches
   the confirmed sign-in email to the customer record. Nothing here can change a plan. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = c => PpCalc.money(c);
  const day = iso => {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  };
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const show = id => { for (const s of ['mlLoading', 'mlSignIn', 'mlNone', 'mlPlans']) $(s).hidden = s !== id; $('mlSignOut').hidden = id === 'mlSignIn' || id === 'mlLoading'; };
  const error = text => { $('mlMsg').textContent = text || ''; $('mlMsg').hidden = !text; };

  function planHtml(plan) {
    const s = PpCalc.summary(plan, plan.payments, todayIso());
    const status = plan.status === 'paid_off' || s.paidOff ? ['Paid off', 'ok'] : plan.status === 'cancelled' ? ['Cancelled', 'late'] : s.late ? ['Past due ' + money(s.pastDueCents), 'late'] : ['On track', 'ok'];
    const rows = (plan.payments || []).map(p => `<tr><td>${esc(day(p.received_date))}</td><td>${esc(money(PpCalc.cents(p.amount)))}</td><td>${esc(p.method || '')}</td></tr>`).join('');
    const pay = plan.pay_link_url && /^https:\/\//.test(plan.pay_link_url) ? `<p><a class="sh-btn sh-btn-primary" href="${esc(plan.pay_link_url)}" rel="noopener">Make a payment</a></p>` : '';
    return `<article class="sh-card">
      <h2>${esc(plan.item)}</h2>
      <p><strong>${esc(status[0])}</strong></p>
      <div class="sh-grid2">
        <p>Balance left<br><strong style="font-size:1.6rem">${esc(money(s.balanceCents))}</strong></p>
        <p>Next payment<br><strong>${s.nextDue ? esc(money(PpCalc.cents(plan.payment_amount))) + ' on ' + esc(day(s.nextDue)) : '—'}</strong></p>
      </div>
      <p class="sh-muted">Sale price ${esc(money(PpCalc.cents(plan.sale_price)))} · ${esc(plan.interest_note || '')} · paid so far ${esc(money(s.totalPaidCents))}${s.payoff ? ' · on pace to be paid off ' + esc(day(s.payoff)) : ''}</p>
      <p class="sh-muted">Paying more than the monthly amount lowers your balance and moves the payoff date earlier.${plan.title_held ? ' SIC Cycles holds the title until the balance is $0.00, then signs it over to you.' : ''}</p>
      ${pay}
      <h3>Payments received</h3>
      ${rows ? `<table class="sh-table"><thead><tr><th>Date</th><th>Amount</th><th>Method</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="sh-muted">None yet. Payments show here once SIC Cycles marks them received.</p>'}
    </article>`;
  }

  async function load() {
    error('');
    let session;
    try { session = await ShApi.verify(); } catch { show('mlSignIn'); return; }
    try {
      const plans = await ShApi.rpc('shop_my_payment_plans');
      if (!plans || !plans.length) { $('mlWho').textContent = session.user?.email || 'this email'; show('mlNone'); return; }
      $('mlPlans').innerHTML = plans.map(planHtml).join('');
      show('mlPlans');
    } catch (e) { show('mlSignIn'); error(e.message || 'Could not load your loan.'); }
  }

  $('mlForm').addEventListener('submit', async ev => {
    ev.preventDefault(); error(''); $('mlGo').disabled = true;
    try { await ShApi.signIn($('mlEmail').value.trim(), $('mlPassword').value); $('mlPassword').value = ''; show('mlLoading'); await load(); }
    catch (e) { error(/invalid/i.test(e.message) ? 'Email or password is wrong.' : e.message); }
    finally { $('mlGo').disabled = false; }
  });
  $('mlSignOut').addEventListener('click', async () => { await ShApi.signOut(); show('mlSignIn'); });
  load();
})(window);
