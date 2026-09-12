/**
 * lib/plati.js  — Digiseller API for Grok accounts
 * Single product: Grok Account (no variant detection needed)
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

const DIGI_API = 'https://api.digiseller.com/api';

let _cachedToken  = null;
let _tokenExpiry  = 0;

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const baseDelay = 500;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeout || 20000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`[plati] fetch attempt ${attempt}/${maxRetries} failed (${err.message})`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 120_000) return _cachedToken;

  const sellerId = parseInt(process.env.PLATI_SELLER_ID || process.env.DIGISELLER_SELLER_ID || '0', 10);
  const apiKey   = process.env.DIGISELLER_API_KEY || process.env.PLATI_SECRET_KEY || '';

  if (!sellerId || !apiKey) {
    throw new Error('Missing PLATI_SELLER_ID or DIGISELLER_API_KEY in environment variables.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign      = crypto.createHash('sha256').update(`${apiKey}${timestamp}`).digest('hex');

  try {
    const res  = await fetchWithRetry(`${DIGI_API}/apilogin`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ seller_id: sellerId, timestamp, sign }),
      timeout: 20000,
    });
    const data = await res.json();

    if (data.retval !== 0 || !data.token) {
      throw new Error(`Digiseller login failed: ${data.retdesc || data.desc || JSON.stringify(data)}`);
    }

    _cachedToken = data.token;
    _tokenExpiry = data.valid_thru ? new Date(data.valid_thru).getTime() : Date.now() + 23 * 3600_000;
    return _cachedToken;
  } catch (err) {
    if (_cachedToken) {
      console.warn('[plati] Token refresh failed, using stale cache:', err.message);
      return _cachedToken;
    }
    throw err;
  }
}

async function verifyUniqueCode(uniqueCode) {
  const token = await getToken();

  const ucRes  = await fetchWithRetry(`${DIGI_API}/purchases/unique-code/${uniqueCode}?token=${token}`, {
    headers: { 'Accept': 'application/json' },
    timeout: 20000,
  });
  const ucData = await ucRes.json();

  if (ucData.retval !== 0) {
    throw new Error(ucData.retdesc || ucData.desc || 'Invalid or unrecognised unique code.');
  }

  /* ── Product whitelist check (MANDATORY) ────────────────────────────
   * ALLOWED_GOODS_IDS must be set. If empty → block ALL to prevent abuse.
   */
  const allowedIds = (process.env.ALLOWED_GOODS_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const goodsId = String(ucData.id_goods || '');
  console.log(`[plati] code=${uniqueCode} goods_id=${goodsId} allowed=[${allowedIds.join(',')}]`);
  if (allowedIds.length === 0) {
    console.error('[plati] BLOCKED: ALLOWED_GOODS_IDS env var is not configured!');
    throw new Error('Service configuration error. Please contact the seller.');
  }
  if (!allowedIds.includes(goodsId)) {
    console.warn(`[plati] BLOCKED: code=${uniqueCode} belongs to goods_id=${goodsId}, not in allowed list [${allowedIds.join(',')}]`);
    throw new Error('This code does not belong to a valid Grok product. / Этот код не относится к продукту Grok.');
  }

  /* ── Refund check ─────────────────────────────────────────────────── */
  if (ucData.date_refund && ucData.date_refund.trim() !== '') {
    console.warn(`[plati] REFUNDED order detected: code=${uniqueCode} inv=${ucData.inv}`);
    throw new Error('This order has been refunded. Delivery is not available. / Этот заказ был возвращён. Доставка невозможна.');
  }

  /* ── Unknown buyer guard ──────────────────────────────────────────── */
  const buyerEmail = String(ucData.email || '').trim().toLowerCase();
  if (!buyerEmail || buyerEmail === 'unknown') {
    console.warn(`[plati] Unknown buyer for code=${uniqueCode} — possible refund/cancel`);
    throw new Error('Unable to verify buyer. The order may have been refunded or cancelled. / Невозможно подтвердить покупателя.');
  }

  return {
    orderId:     String(ucData.inv       || ''),
    goodsId:     goodsId,
    buyer:       buyerEmail,
    amount:      String(ucData.amount    || ''),
    currency:    String(ucData.type_curr || 'USD'),
    goodsName:   String(ucData.name_invoice || ''),
    datePay:     String(ucData.date_pay  || new Date().toISOString()),
    productType: 'grok',
    productName: 'Grok Account',
    sheetName:   'Grok Account',
  };
}

module.exports = { verifyUniqueCode, getToken };
