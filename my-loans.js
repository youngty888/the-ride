/* "On payments": loans a rider is paying off to SIC Cycles, shown in their Garage with the
   bike. Read-only. Data comes from the database function shop_my_payment_plans(), which
   matches the signed-in rider's CONFIRMED email to the customer record SIC Cycles keeps;
   a rider only ever gets their own loans. Nothing here can change a loan. */
const MyLoans = {
  plans: [],

  async load() {
    try {
      const account = getAccountId();
      if (!account) return;
      const plans = await CloudRest.call(account, 'rpc/shop_my_payment_plans', { method: 'POST', body: '{}' });
      this.plans = Array.isArray(plans) ? plans : [];
    } catch { /* offline or not set up yet: the Garage works without loans */ }
  },

  esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  today() {
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  day(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  },
  same(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); },

  /* The loan that belongs to a Garage bike (same year, make and model), or null. */
  match(bike) {
    if (!bike) return null;
    return this.plans.find(p => p.bike && this.same(p.bike.make, bike.make) && this.same(p.bike.model, bike.model)
      && (!p.bike.year || !bike.year || Number(p.bike.year) === Number(bike.year))) || null;
  },
  /* Loans whose bike is not in the rider's Garage yet; they get a card of their own. */
  unmatched(bikes) {
    return this.plans.filter(p => !(bikes || []).some(b => this.match(b) === p));
  },

  info(plan) {
    const s = PpCalc.summary(plan, plan.payments, this.today());
    let label = 'On track', tone = 'ok';
    if (plan.status === 'paid_off' || s.paidOff) { label = 'Paid off'; }
    else if (plan.status === 'cancelled') { label = 'Cancelled'; tone = 'late'; }
    else if (s.late) { label = 'Past due ' + PpCalc.money(s.pastDueCents); tone = 'late'; }
    return { s, label, tone };
  },
  bikeName(plan) {
    const b = plan.bike || {};
    const name = [b.year, b.make, b.model].filter(Boolean).join(' ');
    return name || plan.item;
  },

  badgeHtml(plan) {
    const { label, tone } = this.info(plan);
    return `<span class="loan-badge loan-${tone}">Loan · ${this.esc(label)}</span>`;
  },

  /* A card for a loan whose bike is not in the Garage list. */
  cardHtml(plan) {
    const { s } = this.info(plan);
    return `<div class="bike-card loan-card" data-loan-id="${this.esc(plan.id)}" role="button" tabindex="0">
      <div class="bike-card-header">
        <div class="bike-card-info">
          <div class="bike-card-title">${this.esc(this.bikeName(plan))}</div>
          <div class="bike-card-subtitle">${this.badgeHtml(plan)}</div>
        </div>
      </div>
      <div class="bike-card-stats">
        <div class="bike-stat"><div class="bike-stat-value">${this.esc(PpCalc.money(s.balanceCents))}</div><div class="bike-stat-label">Balance</div></div>
        <div class="bike-stat"><div class="bike-stat-value">${s.nextDue ? this.esc(this.day(s.nextDue)) : '—'}</div><div class="bike-stat-label">Next payment</div></div>
      </div>
    </div>`;
  },

  /* The full loan: balance, next payment, payments received. */
  blockHtml(plan) {
    if (!plan) return '';
    const { s, label, tone } = this.info(plan);
    const rows = (plan.payments || []).map(p => `<div class="service-record"><div class="service-record-info">
      <div class="service-record-type">${this.esc(PpCalc.money(PpCalc.cents(p.amount)))}${p.method ? ' · ' + this.esc(p.method) : ''}</div>
      <div class="service-record-date">${this.esc(this.day(p.received_date))}</div></div></div>`).join('');
    const link = plan.pay_link_url && /^https:\/\//.test(plan.pay_link_url)
      ? `<a class="btn-primary btn-large" style="display:block;text-align:center;margin-top:var(--space-3);" href="${this.esc(plan.pay_link_url)}" rel="noopener">Make a payment</a>` : '';
    return `<hr class="divider">
      <h3 class="section-title">Your Loan <span class="loan-badge loan-${tone}">${this.esc(label)}</span></h3>
      <div class="bike-card-stats">
        <div class="bike-stat"><div class="bike-stat-value">${this.esc(PpCalc.money(s.balanceCents))}</div><div class="bike-stat-label">Balance left</div></div>
        <div class="bike-stat"><div class="bike-stat-value">${s.nextDue ? this.esc(PpCalc.money(PpCalc.cents(plan.payment_amount))) : '—'}</div><div class="bike-stat-label">${s.nextDue ? 'Due ' + this.esc(this.day(s.nextDue)) : 'Next payment'}</div></div>
      </div>
      <p class="loan-note">Sale price ${this.esc(PpCalc.money(PpCalc.cents(plan.sale_price)))} · ${this.esc(plan.interest_note || '')} · paid so far ${this.esc(PpCalc.money(s.totalPaidCents))}${s.payoff ? ' · on pace to be paid off ' + this.esc(this.day(s.payoff)) : ''}</p>
      <p class="loan-note">Paying more than the monthly amount lowers your balance and moves your payoff date earlier.${plan.title_held ? ' SIC Cycles holds the title until the balance is $0.00, then signs it over to you.' : ''}</p>
      ${link}
      <h3 class="section-title" style="margin-top:var(--space-4);">Payments received</h3>
      ${rows || '<p class="empty-state">None yet. Payments appear here once SIC Cycles marks them received.</p>'}`;
  }
};
