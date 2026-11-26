// Edge function: Moto Tow alerts and inbound texts.
// Runs in the shop server's supabase-edge-functions container at
//   https://api.ride.siccycles.com/functions/v1/tow-alert?key=<TOW_HOOK_KEY>
// Two callers, both must send the shared key:
//   1. A Supabase database webhook on INSERT into public.shop_tow_requests.
//      It texts (Quo) and emails (Resend, optional) everyone on duty.
//   2. A Quo webhook for "message.received" on the tow number. The text is
//      added to the board as a new tow (or to that number's open tow), then
//      the on-duty crew is alerted the same way.
// Settings it reads (server only, never in this repo):
//   TOW_HOOK_KEY        long random string; the same value goes in both webhook URLs
//   QUO_API_KEY         Quo > Settings > API
//   QUO_FROM            the tow number in +1 format
//   RESEND_API_KEY      optional, for email alerts
//   TOW_EMAIL_FROM      optional, e.g. "Moto Tow <dispatch@your-domain>"
//   TOW_BOARD_URL       optional, default https://ride.siccycles.com/shop/tow.html
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   already set for every function
// Never logs customer details.
const env = (k: string) => (Deno.env.get(k) ?? '').trim();

async function db(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: env('SUPABASE_SERVICE_ROLE_KEY'), authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} ${res.status}`);
  return res.json();
}

const e164 = (p: string) => { const d = (p || '').replace(/\D/g, ''); return d.length === 10 ? `+1${d}` : d.length === 11 && d[0] === '1' ? `+${d}` : ''; };

async function text(to: string, content: string) {
  if (!env('QUO_API_KEY') || !env('QUO_FROM') || !to) return false;
  const res = await fetch('https://api.quo.com/messages', {
    method: 'POST',
    headers: { authorization: env('QUO_API_KEY'), 'content-type': 'application/json', 'Quo-Api-Version': '2026-03-30' },
    body: JSON.stringify({ content: content.slice(0, 1500), from: env('QUO_FROM'), to: [to] }),
  });
  if (!res.ok) console.error('quo send failed', res.status);
  return res.ok;
}

async function email(to: string, subject: string, body: string) {
  if (!env('RESEND_API_KEY') || !env('TOW_EMAIL_FROM') || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env('TOW_EMAIL_FROM'), to: [to], subject, text: body }),
  });
  if (!res.ok) console.error('email send failed', res.status);
  return res.ok;
}

const VEH: Record<string, string> = { motorcycle: 'Motorcycle', atv: 'ATV', golf_cart: 'Golf cart', side_by_side: 'Side-by-side' };
const AREA: Record<string, string> = { tucson: 'Tucson', sierra_vista: 'Sierra Vista', phoenix: 'Phoenix', other: 'Other area' };

async function alertCrew(lines: string[]) {
  const board = env('TOW_BOARD_URL') || 'https://ride.siccycles.com/shop/tow.html';
  const body = [...lines, `Board: ${board}`].join('\n');
  const crew = await db('shop_tow_alert_targets', {}) as { phone?: string; email?: string }[];
  let sent = 0;
  for (const c of crew) {
    if (await text(e164(c.phone ?? ''), body)) sent++;
    if (await email(c.email ?? '', lines[0], body)) sent++;
  }
  console.log('tow alert', crew.length, 'on duty,', sent, 'sent');
  return sent;
}

Deno.serve(async (req: Request) => {
  const key = new URL(req.url).searchParams.get('key') ?? '';
  if (!env('TOW_HOOK_KEY') || key !== env('TOW_HOOK_KEY')) return new Response('no', { status: 401 });
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  // deno-lint-ignore no-explicit-any
  let p: any; try { p = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  try {
    // 1. Database webhook: a new tow row.
    if (p?.type === 'INSERT' && p?.table === 'shop_tow_requests' && p.record) {
      const r = p.record;
      await alertCrew([
        `NEW TOW ${r.ref}: ${VEH[r.vehicle_type] ?? r.vehicle_type}, ${AREA[r.zone] ?? r.zone}${r.price ? `, $${r.price}` : ''}`,
        `From ${r.source}. ${r.waiver_signed_at ? 'Waiver signed.' : 'Waiver not signed yet.'} Not paid yet.`,
      ]);
      return new Response('ok');
    }
    // 2. Quo inbound text.
    if (p?.type === 'message.received') {
      const from = p.data?.context?.senderIdentifier ?? '';
      const msg = String(p.data?.resource?.text ?? '');
      const out = await db('shop_tow_inbound', { p: { source: 'text', phone: from, message: msg } }) as { ref: string; new: boolean };
      // A brand new tow is alerted by the database webhook; a follow-up text is alerted here.
      if (!out.new) await alertCrew([`TEXT on ${out.ref}`, msg.slice(0, 300)]);
      return new Response('ok');
    }
    return new Response('ignored');
  } catch (e) {
    console.error('tow-alert error', (e as Error).message);
    return new Response('error', { status: 500 });
  }
});
