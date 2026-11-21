/* Payment plan math (no DOM). Same rules as the old Low Rider S tracker sheet:
   flat price, no interest, a set payment due on one day each month. Extra money
   comes off the balance and moves the payoff date earlier; it does not skip a
   month. Dates are plain YYYY-MM-DD strings, worked out in UTC so a time zone
   can never shift a day. */
(function (root) {
  'use strict';
  const cents = v => Math.round(Number(v || 0) * 100);
  const parse = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return { y, m, d }; };
  const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  function addMonths(isoDate, n, day) {
    const p = parse(isoDate); const total = p.y * 12 + (p.m - 1) + n;
    return fmt(Math.floor(total / 12), (total % 12) + 1, day || p.d);
  }

  // plan: {sale_price, down_payment, monthly_payment, due_day, first_due_date, sale_date}
  // payments: [{amount, received_date}] (only payments marked received)
  // today: YYYY-MM-DD
  function summary(plan, payments, today) {
    const m = cents(plan.monthly_payment);
    const financed = cents(plan.sale_price) - cents(plan.down_payment);
    const paid = (payments || []).reduce((s, p) => s + cents(p.amount), 0);
    const balance = Math.max(financed - paid, 0);
    const out = {
      financedCents: financed, paidCents: paid, totalPaidCents: paid + cents(plan.down_payment),
      balanceCents: balance, paymentsLeft: m > 0 ? Math.ceil(balance / m) : 0,
      nextDue: null, pastDueCents: 0, late: false, payoff: null, paidOff: balance === 0,
    };
    if (balance === 0 || m <= 0) return out;
    const due = k => addMonths(plan.first_due_date, k - 1, plan.due_day); // k-th due date, k >= 1
    let kToday = 0; while (due(kToday + 1) <= today) kToday++;           // due dates already reached
    const requiredNow = Math.min(kToday * m, financed);
    if (paid < requiredNow) {
      out.late = true; out.pastDueCents = requiredNow - paid;
      out.nextDue = due(Math.floor(paid / m) + 1);                         // oldest unpaid due date
    } else {
      // A payment made since the last due date (or since the sale) counts for
      // the coming due date once it adds up to a full payment.
      const since = kToday === 0 ? '0000-00-00' : due(kToday);
      const inWindow = (payments || []).filter(p => String(p.received_date).slice(0, 10) > since)
        .reduce((s, p) => s + cents(p.amount), 0);
      out.nextDue = due(kToday + (inWindow >= m ? 2 : 1));
    }
    out.payoff = addMonths(out.nextDue, out.paymentsLeft - 1, plan.due_day);
    return out;
  }

  const money = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const PpCalc = { summary, addMonths, cents, money };
  if (typeof module !== 'undefined' && module.exports) module.exports = PpCalc;
  root.PpCalc = PpCalc;
})(typeof window !== 'undefined' ? window : globalThis);
