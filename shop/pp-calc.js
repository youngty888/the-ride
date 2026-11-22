/* Payment plan math (no DOM). A set payment is due monthly (on one day of the
   month) or every 14 days. Extra money comes off the balance and moves the
   payoff date earlier; it does not skip a due date. With interest (apr > 0)
   the finance charge is worked out once with amortize() when the plan is
   saved and stored on the plan; the balance is then
   price - down payment + finance charge - payments.
   Late fees and missed payments are only worked out for display, never charged.
   Dates are plain YYYY-MM-DD strings, worked out in UTC so a time zone can
   never shift a day. */
(function (root) {
  'use strict';
  const cents = v => Math.round(Number(String(v ?? 0).replace(/[$,]/g, '') || 0) * 100);
  const parse = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return { y, m, d }; };
  const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const utc = s => { const p = parse(s); return Date.UTC(p.y, p.m - 1, p.d); };
  function addMonths(isoDate, n, day) {
    const p = parse(isoDate); const total = p.y * 12 + (p.m - 1) + n;
    return fmt(Math.floor(total / 12), (total % 12) + 1, day || p.d);
  }
  function addDays(isoDate, n) { const d = new Date(utc(isoDate) + n * 86400000); return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  const PERIODS = { monthly: 12, biweekly: 26 };

  // The k-th due date (k >= 1).
  function dueDate(plan, k) {
    return plan.schedule === 'biweekly' ? addDays(plan.first_due_date, 14 * (k - 1))
      : addMonths(plan.first_due_date, k - 1, Number(plan.due_day) || undefined);
  }

  // Level payments on a simple-interest loan. apr in percent (20 = 20%).
  // Returns the payment (rounded up to the cent), the last payment (which
  // takes up the rounding), the total of payments and the finance charge.
  function amortize({ financedCents, apr, payments, schedule }) {
    const n = Math.floor(Number(payments)); const P = Math.round(financedCents);
    if (!(n >= 1) || !(P > 0)) return null;
    const r = Number(apr || 0) / 100 / (PERIODS[schedule] || 12);
    let pay = r > 0 ? Math.ceil(P * r / (1 - Math.pow(1 + r, -n))) : Math.ceil(P / n);
    let bal = P;
    for (let i = 1; i < n; i++) bal = bal + Math.round(bal * r) - pay;
    let last = bal + Math.round(bal * r);
    if (last <= 0) { pay = Math.ceil(P / n); last = P - pay * (n - 1); } // only with apr 0 and odd cents
    const total = pay * (n - 1) + last;
    return { paymentCents: pay, lastPaymentCents: last, totalCents: total, financeChargeCents: total - P, payments: n };
  }

  // plan: the row from shop_payment_plan_summary (or the same fields)
  // payments: [{amount, received_date}] (only payments marked received)
  // today: YYYY-MM-DD
  function summary(plan, payments, today) {
    const m = cents(plan.payment_amount);
    const financed = cents(plan.sale_price) - cents(plan.down_payment);
    const owed = financed + cents(plan.finance_charge);
    const paid = (payments || []).reduce((s, p) => s + cents(p.amount), 0);
    const balance = Math.max(owed - paid, 0);
    const out = {
      financedCents: financed, financeChargeCents: cents(plan.finance_charge), owedCents: owed,
      paidCents: paid, totalPaidCents: paid + cents(plan.down_payment),
      balanceCents: balance, paymentsLeft: m > 0 ? Math.ceil(balance / m) : 0,
      nextDue: null, pastDueCents: 0, late: false, payoff: null, paidOff: balance === 0,
      missed: 0, lateDays: 0, lateFeeCents: 0, lateFeeStarts: null, lateFeeWaived: !!plan.late_fee_waived,
      standing: balance === 0 ? 'paid' : 'ok',  // ok | late | last_chance | default | paid
    };
    if (balance === 0 || m <= 0) return out;
    const due = k => dueDate(plan, k);
    let kToday = 0; while (due(kToday + 1) <= today) kToday++;        // due dates already reached
    const requiredNow = Math.min(kToday * m, owed);
    let kNext;
    if (paid < requiredNow) {
      out.late = true; out.pastDueCents = requiredNow - paid;
      kNext = Math.floor(paid / m) + 1;                                 // oldest unpaid due date
      out.missed = kToday - Math.floor(paid / m);
      out.lateDays = daysBetween(due(kNext), today);
      const grace = plan.late_fee_grace_days == null ? 2 : Number(plan.late_fee_grace_days);
      out.lateFeeStarts = addDays(due(kNext), grace + 1);
      const perDay = cents(plan.late_fee_per_day);
      if (perDay > 0 && !out.lateFeeWaived) out.lateFeeCents = Math.max(out.lateDays - grace, 0) * perDay;
      const limit = Number(plan.missed_limit) || 3;
      out.standing = out.missed > limit ? 'default' : out.missed === limit ? 'last_chance' : 'late';
    } else {
      // A payment made since the last due date (or since the sale) counts for
      // the coming due date once it adds up to a full payment.
      const since = kToday === 0 ? '0000-00-00' : due(kToday);
      const inWindow = (payments || []).filter(p => String(p.received_date).slice(0, 10) > since)
        .reduce((s, p) => s + cents(p.amount), 0);
      kNext = kToday + (inWindow >= m ? 2 : 1);
    }
    out.nextDue = due(kNext);
    out.payoff = due(kNext + out.paymentsLeft - 1);
    return out;
  }

  const money = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const PpCalc = { summary, amortize, dueDate, addMonths, addDays, daysBetween, cents, money, PERIODS };
  if (typeof module !== 'undefined' && module.exports) module.exports = PpCalc;
  root.PpCalc = PpCalc;
})(typeof window !== 'undefined' ? window : globalThis);
