/* RIDE: a buyer's own bike payment plan (ride.siccycles.com/pay/).
   Read-only. The database decides what this login may see
   (shop_my_payment_plans: plans whose customer email is this login's
   confirmed email). Staff mark every payment on the shop side. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.PpCalc;
  const VIEWS = ['myLoading', 'mySignIn', 'myNone', 'myError', 'myPlans'];
  const show = id => VIEWS.forEach(v => { $(v).hidden = v !== id; });
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const nice = iso => {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };
  const ord = n => n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');

  function msg(text, error) { const m = $('myMsg'); m.textContent = text || ''; m.hidden = !text; m.classList.toggle('sh-msg-error', !!error); }

  function renderPlan(p, member) {
    const node = document.getElementById('myPlanTpl').content.cloneNode(true);
    const k = name => node.querySelector(`[data-k="${name}"]`);
    const s = C.summary(p, p.payments || [], today());
    const amount = C.cents(p.payment_amount);
    k('item').textContent = p.item;
    const when = p.schedule === 'biweekly' ? 'every 2 weeks' : `on the ${ord(Number(p.due_day))} of each month`;
    k('sub').textContent = `${C.money(amount)} due ${when}` + (p.pay_ref ? ` · Loan number ${p.pay_ref}` : '') + (p.title_held && !s.paidOff ? ' · SIC Cycles holds the title until it is paid off' : '');
    k('balance').textContent = C.money(s.balanceCents);
    k('next').textContent = s.paidOff ? 'Paid off' : nice(s.nextDue);
    k('amount').textContent = C.money(amount);
    k('paid').textContent = C.money(s.totalPaidCents);
    k('payoff').textContent = s.paidOff ? 'Done' : nice(s.payoff);
    const badge = k('badge');
    badge.textContent = s.paidOff ? 'Paid off' : s.late ? 'Past due' : 'On track';
    badge.classList.add(s.paidOff ? 'pp-done' : s.late ? 'pp-late' : 'pp-ok');
    if (s.late && !s.paidOff) {
      const a = k('alert'); a.hidden = false; a.classList.add('pp-alert-amber');
      let t = `${C.money(s.pastDueCents)} is past due (since ${nice(C.dueDate(p, Math.floor(s.paidCents / amount) + 1))}).`;
      if (s.lateFeeCents > 0) t += ` Late fees so far: ${C.money(s.lateFeeCents)}.`;
      a.textContent = t + ' Pay below or call SIC Cycles.';
    }
    const link = C.payHref(p, p.bike && p.bike.vin_last6);
    const btn = k('payBtn');
    if (link && !s.paidOff) { btn.href = link; btn.hidden = false; }
    const D = window.D4D;
    if (link && !s.paidOff && D && D.canAddTo(link)) {
      // Optional round-up: adds a Dollars for Dads gift to the same store checkout.
      const pick = k('dadsPick');
      const choices = D.roundUpChoices(amount / 100).map(c => [c.add, `Add ${C.money(c.add * 100)} (pay ${C.money(Math.round(c.total * 100))})`]);
      for (const n of [1, 5, 10]) if (!choices.some(([a]) => a === n)) choices.push([n, `Add ${C.money(n * 100)}`]);
      choices.sort((a, b) => a[0] - b[0]);
      [[0, 'No round-up'], ...choices].forEach(([value, label]) => { const o = document.createElement('option'); o.value = String(value); o.textContent = label; pick.appendChild(o); });
      const add = k('dadsAdd');
      pick.addEventListener('change', () => {
        const n = Number(pick.value);
        btn.href = D.addToCart(link, n, { member, how: 'Round-up' });
        add.textContent = n ? `+${D.pointsFor(n)} when this payment goes through` : '';
      });
      k('dads').hidden = false;
    }
    k('payNote').textContent = s.paidOff ? 'Nothing left to pay. Thank you!'
      : !link ? 'Online payment is not set up yet. Call SIC Cycles to pay.'
      : C.isShopifyCart(p) ? `Pays at the SIC Cycles checkout. Your loan number ${p.pay_ref} goes with the payment, and it shows here once the payment goes through. Use this same button every time.`
      : p.autopay === 'on' ? 'Autopay is on. You can still make an extra payment with the button.'
      : 'Pay by card or bank. You can turn on autopay on the payment page.';
    const rows = k('rows');
    const list = (p.payments || []).slice().reverse();
    if (!list.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 3; td.className = 'sh-muted'; td.textContent = 'No payments yet.'; tr.appendChild(td); rows.appendChild(tr);
    }
    for (const pay of list) {
      const tr = document.createElement('tr');
      const cells = [nice(pay.received_date), C.money(C.cents(pay.amount)), pay.method || ''];
      cells.forEach((v, i) => { const td = document.createElement('td'); td.textContent = v; if (i === 1) td.className = 'pp-num'; tr.appendChild(td); });
      rows.appendChild(tr);
    }
    return node;
  }

  // The rider's Dads Don't Quit points next to each round-up. Before SIC Cycles
  // turns points on (or with no signal) it just shows a dash.
  async function showDadsPoints(box) {
    const spots = box.querySelectorAll('[data-k="dadsPoints"]');
    if (!spots.length) return;
    let points = null;
    try { const d = await ShApi.rpc('ride_my_dads', {}); if (d && typeof d === 'object') points = Number(d.points || 0); } catch { /* dash stays */ }
    spots.forEach(b => { b.textContent = points === null ? '\u2013' : points.toLocaleString(); });
  }

  async function load() {
    show('myLoading'); msg('');
    let s;
    try { s = await ShApi.verify(); }
    catch (e) {
      // Only a rejected sign-in goes back to the form; no signal or a server error can be retried.
      if (e.status === 401 || e.status === 403) { show('mySignIn'); $('myOut').hidden = true; } else show('myError');
      return;
    }
    $('myOut').hidden = false;
    let plans;
    try { plans = await ShApi.rpc('shop_my_payment_plans', {}); }
    catch (e) { show(e.status === 401 ? 'mySignIn' : 'myError'); return; }
    if (!Array.isArray(plans) || !plans.length) { $('myNoneEmail').textContent = s.user?.email || ''; show('myNone'); return; }
    const box = $('myPlans'); box.replaceChildren(...plans.map(p => renderPlan(p, s.user?.id))); show('myPlans');
    showDadsPoints(box);
  }

  $('mySignInForm').addEventListener('submit', async e => {
    e.preventDefault(); msg('');
    const btn = e.submitter || e.target.querySelector('button'); btn.disabled = true;
    try { await ShApi.signIn($('myEmail').value.trim(), $('myPassword').value); $('myPassword').value = ''; await load(); }
    catch (err) { msg(err.status === 400 ? 'That email and password did not match.' : (err.message || 'Sign in failed.'), true); }
    finally { btn.disabled = false; }
  });
  $('myRetry').addEventListener('click', () => load());
  $('myOut').addEventListener('click', async () => { await ShApi.signOut(); location.reload(); });
  load();
})();
