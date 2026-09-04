/**
 * /api/webhook
 * Called by Plati.market server-side when a purchase is confirmed.
 * Plati POST fields: id_order, id_goods, unique_code, email, goods_name, sign, amount
 * sign = md5(seller_id + id_goods + unique_code + secret_key)
 *
 * Configure in Plati product settings → Automatic delivery → Webhook URL:
 *   https://grok-delivery.vercel.app/api/webhook
 *
 * WHY THIS EXISTS:
 *   When a buyer visits the delivery page, verify.js calls the Digiseller API.
 *   But Digiseller marks codes as "verified" almost instantly, causing retval:2 errors.
 *   This webhook pre-delivers the account at purchase time, so the customer's
 *   verify.js lookup hits the Google Sheet directly (bypassing Digiseller API entirely).
 */
const crypto = require('crypto');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  savePendingOrder,
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

  // ── 1. Verify signature ────────────────────────────────────────────────
  const idSeller = process.env.PLATI_SELLER_ID  || '';
  const idGoods  = process.env.PLATI_GOODS_ID   || '';
  const secret   = process.env.PLATI_SECRET_KEY || '';

  const expectedSign = generateSign(idSeller, id_goods || idGoods, unique_code, secret);

  if (!sign || sign.toLowerCase() !== expectedSign.toLowerCase()) {
    console.error('[webhook-grok] Invalid sign. Got:', sign, 'Expected:', expectedSign);
    return res.status(403).json({ success: false, error: 'Invalid signature' });
  }

  if (!unique_code) return res.status(400).json({ success: false, error: 'Missing unique_code' });

  // ── 2. Idempotency: already delivered? ───────────────────────────────
  const existingOrder = await findOrderByCode(unique_code);
  if (existingOrder && !existingOrder.isPending) {
    console.log(`[webhook-grok] Already delivered for code=${unique_code}`);
    return res.status(200).json({
      success: true,
      alreadyDelivered: true,
      account: existingOrder.accountEmail + ':' + existingOrder.accountPassword,
    });
  }

  // ── 3. Get account from Grok Account sheet ───────────────────────────
  const account = await getNextAvailableAccount(SHEET_NAME, unique_code);
  if (!account) {
    // Out of stock — save pending so customer sees OOS screen when they visit delivery page
    if (!existingOrder) {
      await savePendingOrder({
        uniqueCode: unique_code,
        buyerEmail: email || 'unknown',
        orderId: id_order || '',
        productType: 'grok',
        productName: 'Grok Account',
      });
    }
    console.warn(`[webhook-grok] OOS — saved pending for code=${unique_code}`);
    return res.status(503).json({
      success: false,
      outOfStock: true,
      error: 'Out of stock: Grok Account',
    });
  }

  // ── 4. Delete from sheet + save delivered order ───────────────────────
  await deleteAccountRow(SHEET_NAME, account.rowIndex, account.claimMark);

  await saveOrder({
    uniqueCode:      unique_code,
    buyerEmail:      email || 'unknown',
    accountEmail:    account.email,
    accountPassword: account.password,
    orderId:         id_order || '',
    productType:     'grok',
    productName:     'Grok Account',
  });

  console.log(`[webhook-grok] Delivered Grok Account for order=${id_order} code=${unique_code}`);

  return res.status(200).json({
    success: true,
    account: account.email + ':' + account.password,
  });
};
