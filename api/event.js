// Conversions API endpoint: the page sends events here, and this sends them to Meta.
const crypto = require('crypto');

const API_VERSION = 'v24.0';
const ALLOWED_EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'];

// --- PART 1: Hashing. Meta requires customer info to be normalized, then SHA-256 hashed ---
function hash(value) {
  if (!value) return undefined;
  const clean = String(value).trim().toLowerCase();
  return [crypto.createHash('sha256').update(clean).digest('hex')];
}
function digitsOnly(value) {
  return value ? String(value).replace(/\D/g, '') : undefined;
}

// --- PART 2: Read Meta's browser cookies (_fbp = browser ID, _fbc = ad click ID) ---
function getCookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : undefined;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // --- PART 3: Secrets come from Vercel settings, never from the code ---
  const { META_PIXEL_ID, META_ACCESS_TOKEN, META_TEST_EVENT_CODE } = process.env;
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Missing META_PIXEL_ID or META_ACCESS_TOKEN' });
  }

  const { event_name, event_id, event_source_url, custom_data, user = {} } = req.body || {};
  if (!ALLOWED_EVENTS.includes(event_name) || !event_id) {
    return res.status(400).json({ error: 'Invalid event_name or missing event_id' });
  }

  // --- PART 4: Build the event. event_id must match the browser's eventID for dedup ---
  const event = {
    event_name,
    event_id,
    event_time: Math.floor(Date.now() / 1000),
    event_source_url,
    action_source: 'website',
    user_data: {
      em: hash(user.email),
      ph: hash(digitsOnly(user.phone)),
      fn: hash(user.first_name),
      external_id: hash(user.external_id),
      client_ip_address: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
      client_user_agent: req.headers['user-agent'],
      fbp: getCookie(req, '_fbp'),
      fbc: getCookie(req, '_fbc'),
    },
    custom_data,
  };

  const payload = { data: [event] };
  if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;

  // --- PART 5: Send to Meta and pass Meta's answer back (useful for debugging) ---
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