// Vercel serverless function: receives events from the demo store
// and forwards them to Meta's Conversions API (CAPI).
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   META_PIXEL_ID         - your pixel/dataset ID
//   META_ACCESS_TOKEN     - CAPI access token from Events Manager (keep secret!)
//   META_TEST_EVENT_CODE  - optional, e.g. TEST12345. Sends events to the Test Events tab.

const crypto = require('crypto');

const API_VERSION = 'v23.0';
const ALLOWED_EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'];

// Meta requires customer info to be normalized, then SHA-256 hashed.
// Values that are already hashed (64 hex characters) are passed through as-is.
function hash(value) {
  if (!value) return undefined;
  const v = String(value).trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(v)) return v;
  return crypto.createHash('sha256').update(v).digest('hex');
}

function normalizePhone(phone) {
  if (!phone) return undefined;
  const digits = String(phone).replace(/\D/g, ''); // keep digits only, incl. country code
  return digits || undefined;
}

function getCookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : undefined;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { META_PIXEL_ID, META_ACCESS_TOKEN, META_TEST_EVENT_CODE } = process.env;
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Missing META_PIXEL_ID or META_ACCESS_TOKEN' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { event_name, event_id, event_source_url, custom_data = {}, user = {} } = body;

  if (!ALLOWED_EVENTS.includes(event_name) || !event_id) {
    return res.status(400).json({ error: 'Invalid event_name or missing event_id' });
  }

  const user_data = {
    // Hashed customer info (only sent when the visitor typed it, e.g. at checkout)
    // email/phone come raw from the checkout form, or as em/ph (already hashed) for returning customers
    em: (user.email || user.em) ? [hash(user.email || user.em)] : undefined,
    ph: user.phone ? [hash(normalizePhone(user.phone))] : (user.ph ? [hash(user.ph)] : undefined),
    fn: user.fn ? [hash(user.fn)] : undefined,
    ln: user.ln ? [hash(user.ln)] : undefined,
    // Visitor ID that links all of this person's events together
    external_id: user.external_id ? [hash(user.external_id)] : undefined,
    // Not hashed: browser/device signals
    client_ip_address: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
    client_user_agent: req.headers['user-agent'],
    fbp: getCookie(req, '_fbp'), // Meta browser ID cookie (set by the pixel)
    fbc: getCookie(req, '_fbc')  // Meta click ID cookie (set when arriving from an ad)
  };

  const payload = {
    data: [{
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,            // same ID as the browser pixel -> Meta deduplicates
      action_source: 'website',
      event_source_url,
      user_data,
      custom_data
    }]
  };
  if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;

  try {
    const r = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const result = await r.json();
    return res.status(r.ok ? 200 : 502).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
