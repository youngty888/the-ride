/* Motorcycle retail installment contract, filled in from a payment plan.
   DRAFT TEMPLATE FOR ATTORNEY REVIEW. NOT FOR SIGNATURE until a licensed
   Arizona attorney has approved it. No customer data lives in this file: the
   page passes the plan in and the text is built in the browser.
   build(ctx) returns plain strings only; the page writes them with textContent. */
(function (root) {
  'use strict';
  const C = root.PpCalc || (typeof require !== 'undefined' ? require('./pp-calc.js') : null);
  const BLANK = '____________________';
  const money = c => C.money(c);
  const fmtDate = s => { if (!s) return BLANK; const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  const or = (v, b = BLANK) => (v == null || String(v).trim() === '' ? b : String(v));
  const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 10 > 3 || [11, 12, 13].includes(n % 100)) ? 0 : n % 10]);

  const STATUS_LINE = 'DRAFT FOR ATTORNEY REVIEW. NOT FOR SIGNATURE. Not a binding offer until approved by a licensed Arizona attorney.';

  // ctx: {seller:{name,address,phone,email}, buyer:{name,address,phone,email},
  //       vehicle:{year,make,model,vin,mileage,color}, plan:{...plan row}, sample:boolean}
  function build(ctx) {
    const p = ctx.plan || {}; const b = ctx.buyer || {}; const v = ctx.vehicle || {}; const s = ctx.seller || {};
    const biweekly = p.schedule === 'biweekly';
    const financed = C.cents(p.sale_price) - C.cents(p.down_payment);
    const fc = C.cents(p.finance_charge);
    const n = Number(p.term_payments) || (C.cents(p.payment_amount) > 0 ? Math.ceil((financed + fc) / C.cents(p.payment_amount)) : 0);
    const pay = C.cents(p.payment_amount);
    const last = financed + fc - pay * (n - 1);
    const lastDue = n ? C.dueDate(p, n) : null;
    const apr = Number(p.apr || 0);
    const when = biweekly ? `every 14 days starting ${fmtDate(p.first_due_date)}`
      : `on the ${ord(Number(p.due_day))} day of each month starting ${fmtDate(p.first_due_date)}`;
    const perDay = C.cents(p.late_fee_per_day); const grace = p.late_fee_grace_days == null ? 2 : Number(p.late_fee_grace_days);
    const limit = Number(p.missed_limit) || 3;
    const lateText = perDay > 0
      ? `If any payment is not received in full within ${grace} days after its due date, a late charge of ${money(perDay)} per day accrues for each day after that until the payment is received, unless Seller has agreed in writing to a different payment arrangement.`
      : 'No late charge applies to this contract.';
    const vehicleName = [v.year, v.make, v.model].filter(Boolean).join(' ') || or(p.item);

    const sections = [
      { h: '1. Parties', p: [
        `Seller / Creditor: ${or(s.name, 'SIC Cycles')}, ${or(s.address)}. Phone ${or(s.phone)}.`,
        `Buyer: ${or(b.name)}, ${or(b.address)}. Phone ${or(b.phone)}. Email ${or(b.email)}.`,
        `Co-Buyer (if any): ${BLANK}.`,
        `Contract date: ${fmtDate(p.sale_date)}. "You" and "your" mean the Buyer and any Co-Buyer, each of whom is responsible for the whole amount. "We", "us" and "Seller" mean the Seller and anyone to whom this contract is assigned.`] },
      { h: '2. Motorcycle', p: [
        `Year, make and model: ${vehicleName}. VIN: ${or(v.vin)}. Odometer at sale: ${v.mileage != null && v.mileage !== '' ? Number(v.mileage).toLocaleString('en-US') + ' miles' : BLANK}. Color: ${or(v.color)}.`,
        'Condition: used. Sold AS IS, with no warranty from Seller, unless a separate written warranty is signed by Seller. Any manufacturer warranty still in effect is not affected.'] },
      { h: '3. Truth-in-Lending disclosures', box: [
        ['ANNUAL PERCENTAGE RATE', `${apr.toFixed(2)}%`, 'The cost of your credit as a yearly rate.'],
        ['FINANCE CHARGE', money(fc), 'The dollar amount the credit will cost you.'],
        ['Amount Financed', money(financed), 'The amount of credit provided to you or on your behalf.'],
        ['Total of Payments', money(financed + fc), 'The amount you will have paid after you have made all payments as scheduled.'],
        ['Total Sale Price', money(financed + fc + C.cents(p.down_payment)), `The total cost of your purchase on credit, including your down payment of ${money(C.cents(p.down_payment))}.`],
      ], p: [
        `Payment schedule: ${n > 1 ? `${n - 1} payments of ${money(pay)} and a final payment of ${money(last)}` : `1 payment of ${money(last)}`}, due ${when}. Final payment due ${fmtDate(lastDue)}.`,
        `Late charge: ${lateText}`,
        `Prepayment: you may pay off all or part of this contract early at any time with no penalty.${fc > 0 ? ' If you pay early you will not have to pay the part of the Finance Charge that has not been earned.' : ''}`,
        'Security: you are giving us a security interest in the motorcycle described above.',
        'See the rest of this contract for information about nonpayment, default, any required repayment in full before the scheduled date, and prepayment refunds.'] },
      { h: '4. Itemization of Amount Financed', table: [
        ['Cash price of motorcycle', money(C.cents(p.sale_price))],
        ['Less down payment', money(C.cents(p.down_payment))],
        ['Unpaid balance of cash price', money(financed)],
        ['Sales tax (if not included above)', '$' + BLANK],
        ['Title, registration and license fees paid to the State', '$' + BLANK],
        ['Other charges (describe)', '$' + BLANK],
        ['Amount Financed', money(financed)],
      ] },
      { h: '5. Your promise to pay', p: [
        `You promise to pay us the Total of Payments under the payment schedule above, plus any late charges and other amounts due under this contract. ${biweekly ? 'Payments are due every two weeks.' : 'Payments are due monthly.'} Any amount paid over the scheduled payment is applied to the unpaid balance and shortens the term; it does not excuse the next scheduled payment.`,
        'Payments may be made in person, through the payment link we provide (card or bank transfer to our bank account), or by automatic payment if you sign a separate automatic payment authorization. Automatic payment is optional and is not a condition of this contract. You may cancel an automatic payment authorization by notifying us at least 3 business days before the next payment date.',
        'Each payment is applied first to late charges then due, then to Finance Charge earned, then to the Amount Financed.'] },
      { h: '6. Insurance (required)', p: [
        'You must keep the motorcycle insured until this contract is paid in full, with at least the liability coverage required by Arizona law and comprehensive and collision coverage for the motorcycle’s actual cash value with a deductible no higher than $' + BLANK + '.',
        `The policy must list ${or(s.name, 'SIC Cycles')} as loss payee and lienholder. You must give us proof of insurance before you take the motorcycle and whenever we ask, and you must tell us within 5 days if the policy is cancelled or lapses.`,
        'Driving without the required insurance is a default under this contract. You may buy the insurance from any company you choose that is reasonably acceptable to us.'] },
      { h: '7. Title, registration and taxes (required)', p: [
        'You must title and register the motorcycle in your name with the Arizona Department of Transportation Motor Vehicle Division within the time required by law, keep the registration current, and pay all registration fees, vehicle license taxes and other taxes and fees on the motorcycle while you finance it.',
        p.title_held === false
          ? `Our lien will be recorded on the title. ${or(s.name, 'SIC Cycles')} must be shown as first lienholder until this contract is paid in full.`
          : `${or(s.name, 'SIC Cycles')} will be shown as first lienholder and will keep the certificate of title until this contract is paid in full. When it is paid in full we will release our lien and deliver the title within the time required by law.`] },
      { h: '8. Use and care of the motorcycle', p: [
        'You agree to keep the motorcycle in good condition and repair, to use it lawfully, and to keep it in Arizona unless we agree in writing. You will not sell, rent, lend, pledge or transfer the motorcycle or this contract, or allow any other lien on it, while you owe money under this contract.',
        'You must tell us within 10 days if you change your address or phone number, and within 48 hours if the motorcycle is stolen, damaged in an accident, impounded or seized.'] },
      { h: '9. Default and missed payments', p: [
        `You are in default if: (a) you miss more than ${limit} consecutive scheduled payments; (b) you do not keep the required insurance or registration; (c) you gave us false or misleading information on your credit application; (d) you sell or transfer the motorcycle or it is seized, destroyed or lost and not repaired or replaced; or (e) you break any other promise in this contract in a material way.`,
        `If you miss more than ${limit} consecutive payments, this contract is in default and you must surrender the motorcycle to us at a place we name.`,
        `Voluntary surrender: if you return the motorcycle to us voluntarily, in its condition at the time of sale less normal wear, with its keys and title documents, before your ${ord(limit + 1)} consecutive payment is missed, we will accept the motorcycle in full satisfaction of this contract and you will owe no further amount, fee or deficiency.`,
        'If you are in default we may, as the law allows, require you to pay the whole unpaid balance at once and take back (repossess) the motorcycle.'] },
      { h: '10. Repossession and sale', p: [
        'If we repossess the motorcycle we will do so only as Arizona law allows and without breach of the peace. We will send you any notices the law requires, including notice of the time after which or the time and place at which the motorcycle will be sold. You may get the motorcycle back (redeem it) by paying what the law requires before it is sold.',
        'Personal property left on the motorcycle will be held for you for at least ' + BLANK + ' days. Except as stated in the Voluntary surrender paragraph, if the sale brings less than you owe, you may owe the difference as the law allows; if it brings more, we will pay you the surplus.'] },
      { h: '11. Other terms', p: [
        'Returned payment: if a payment is returned unpaid you may be charged a returned-payment fee of $' + BLANK + ' (not more than the law allows).',
        'No waiver: if we accept a late or partial payment, or delay enforcing any right, we do not give up the right to enforce it later.',
        'Assignment: we may assign this contract. You may not assign it without our written consent.',
        'Governing law: this contract is governed by federal law and the law of Arizona. If any part is found invalid, the rest stays in effect.',
        'Entire agreement: this contract, any written warranty and any separate automatic payment authorization are the whole agreement between you and us. Any change must be in writing and signed by you and us.',
        'Contact: you agree we may contact you about this contract by phone, text or email at the numbers and addresses you give us.'] },
      { h: 'NOTICE', caps: true, p: [
        'ANY HOLDER OF THIS CONSUMER CREDIT CONTRACT IS SUBJECT TO ALL CLAIMS AND DEFENSES WHICH THE DEBTOR COULD ASSERT AGAINST THE SELLER OF GOODS OR SERVICES OBTAINED PURSUANT HERETO OR WITH THE PROCEEDS HEREOF. RECOVERY HEREUNDER BY THE DEBTOR SHALL NOT EXCEED AMOUNTS PAID BY THE DEBTOR HEREUNDER.'] },
      { h: 'NOTICE TO THE BUYER', caps: true, p: [
        '1. DO NOT SIGN THIS CONTRACT BEFORE YOU READ IT OR IF IT CONTAINS ANY BLANK SPACES. 2. YOU ARE ENTITLED TO A COMPLETELY FILLED-IN COPY OF THIS CONTRACT. 3. YOU MAY PAY OFF THE FULL AMOUNT DUE AT ANY TIME.'] },
    ];
    const signatures = [
      `Buyer: ${BLANK}   Date: ${BLANK}   ${or(b.name, '')}`,
      `Co-Buyer: ${BLANK}   Date: ${BLANK}`,
      `Seller: ${or(s.name, 'SIC Cycles')}   By: ${BLANK}   Title: ${BLANK}   Date: ${BLANK}`,
      'By signing you agree to the terms of this contract and confirm you received a completely filled-in copy.',
    ];
    return {
      title: 'Motorcycle Retail Installment Contract and Security Agreement',
      status: STATUS_LINE + (ctx.sample ? ' SAMPLE: all names and numbers are made up.' : ''),
      sections, signatures,
      numbers: { financedCents: financed, financeChargeCents: fc, payments: n, paymentCents: pay, lastPaymentCents: last, lastDue },
    };
  }

  // Questions for the attorney. Kept with the template so they travel together.
  const ATTORNEY_QUESTIONS = [
    ['Licensing', 'Arizona DIFI requires a sales finance company license for anyone creating or holding motor vehicle retail installment contracts over $50,000 total outstanding, or buying them from sellers. When does SIC Cycles need it, which entity should hold it, and is a dealer license needed for regular bike sales?'],
    ['Interest rate', 'A.R.S. 44-291(A) lets the contract set the rate. Is 20% APR fine as the standard, and how do we vary it by risk without fair-lending problems (ECOA / Reg B, risk-based pricing and adverse action notices)?'],
    ['Late fee', 'A.R.S. 44-291(C) appears to allow a late charge only on an installment unpaid on the 10th day after it is due, capped at 5% of the unpaid installment. Our term ($50 a day after 2 days) likely exceeds that. What is the most we can charge, and how should the "unless an arrangement is made" exception be written?'],
    ['Default and surrender', 'Is "more than 3 consecutive missed payments" a workable default trigger, and is the voluntary-surrender clause (no further fees or deficiency if returned before the 4th miss) worded correctly? Check A.R.S. 44-289 on delinquent contracts.'],
    ['Repossession and notice', 'Confirm the repossession and sale paragraph meets Arizona UCC Article 9 (A.R.S. 47-9609 self-help, 47-9611 to 47-9614 notice of disposition, 47-9623 redemption) and what notices we must send before and after.'],
    ['Truth in Lending', 'Confirm the disclosure box and payment schedule meet TILA / Regulation Z for a seller-financed sale, including the APR for a 14-day schedule, and whether zero-interest plans with more than 4 payments still need disclosures.'],
    ['Contract contents', 'Check required contents and buyer notices under A.R.S. 44-287 and 44-289 (blank spaces), and whether anything must be in a certain type size.'],
    ['Early payoff', 'How must we rebate unearned finance charge on early payoff (A.R.S. 44-291)? The app works the finance charge out up front as simple interest.'],
    ['Insurance', 'Is the insurance requirement and loss payee clause right, and may we buy insurance for the buyer if it lapses (A.R.S. 44-288)?'],
    ['Title and lien', 'Should SIC Cycles hold the paper title or be recorded as lienholder with ADOT MVD, and how fast must we release the lien after payoff?'],
    ['Automatic payments', 'Confirm the separate autopay authorization meets the Electronic Fund Transfer Act / Regulation E and card network rules, and that autopay stays optional.'],
    ['Other notices', 'FTC Holder Rule notice (included), privacy notice (GLBA), and rules if we report to credit bureaus (FCRA) or use a collector.'],
  ];

  const PpContract = { build, ATTORNEY_QUESTIONS, STATUS_LINE, BLANK };
  if (typeof module !== 'undefined' && module.exports) module.exports = PpContract;
  root.PpContract = PpContract;
})(typeof window !== 'undefined' ? window : globalThis);
