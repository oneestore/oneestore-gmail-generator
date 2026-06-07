const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzNNWA2j5aVYCDdeM-dsFZBBjpkfpK7kAqfoJ56wFrPEh8icwiFIDcUfbCRBLHzUo3E/exec';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');
    const payload = Object.assign({}, body);
    if (!payload.action) payload.action = 'update'; // boleh 'update' atau 'delete'
    const r = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
