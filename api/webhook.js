/**
 * /api/webhook
 * Called by Plati.market server when a purchase is confirmed.
 * Plati POST fields: id_order, id_goods, unique_code, email, goods_name, sign, amount
 * sign = md5(seller_id + id_goods + unique_code + secret_key)
 *
 * Configure in Plati product settings → Automatic delivery → API URL:
 *   https://grok-delivery.vercel.app/api/webhook
 */
const crypto = require('crypto');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
  SHEET_NAME,
} = require('../lib/sheets');

function generateSign(idSeller, idGoods, uniqueCode, secretKey) {
  return crypto
    .createHash('md5')
    .update(`${idSeller}${idGoods}${uniqueCode}${secretKey}`)
    .digest('hex');
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(raw);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        resolve(obj);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try { body = await parseBody(req); }
  catch { return res.status(400).json({ error: 'Cannot parse request body' }); }

  const { id_order, id_goods, unique_code, email, goods_name, sign, amount } = body;

  // ── 1. Verify signature ──────────────────────────────────────────────
  const idSeller = process.env.PLATI_SELLER_ID  || '';
  const idGoods  = process.env.PLATI_GOODS_ID   || '';
  const secret   = process.env.PLATI_SECRET_KEY || '';

  const expectedSign = generateSign(idSeller, id_goods || idGoods, unique_code, secret);

  if (!sign || sign.toLowerCase() !== expectedSign.toLowerCase()) {
    console.error('[webhook] Invalid sign. Got:', sign, 'Expected:', expectedSign);
    return res.status(403).json({ success: false, error: 'Invalid signature' });
  }

  if (!unique_code) return res.status(400).json({ success: false, error: 'Missing unique_code' });

  // ── 2. Idempotency: already delivered? ──────────────────────────────
  const existing = await findOrderByCode(unique_code);
  if (existing) {
    return res.status(200).json({
      success: true,
      alreadyDelivered: true,
      account: existing.accountEmail + ':' + existing.accountPassword,
    });
  }

  // ── 3. Get account from product sheet ───────────────────────────────
  const account = await getNextAvailableAccount(SHEET_NAME);
  if (!account) {
    return res.status(503).json({
      success: false,
      outOfStock: true,
      error: 'Out of stock: Grok Account',
    });
  }

  // ── 4. Delete from sheet + save to Orders ───────────────────────────
  await deleteAccountRow(SHEET_NAME, account.rowIndex);
  await saveOrder({
    uniqueCode:      unique_code,
    buyerEmail:      email || '',
    accountEmail:    account.email,
    accountPassword: account.password,
    orderId:         id_order || '',
    productType:     'grok',
    productName:     'Grok Account',
  });

  console.log(`[webhook] Delivered Grok Account for order ${id_order}, unique_code ${unique_code}`);

  return res.status(200).json({
    success: true,
    account: account.email + ':' + account.password,
  });
};
