/**
 * /api/verify?uniquecode=XXX&email=YYY
 * Grok account delivery via Plati.market (Digiseller API)
 */
const { verifyUniqueCode } = require('../lib/plati');
const { getNextAvailableAccount, deleteAccountRow, saveOrder, findOrderByCode, SHEET_NAME } = require('../lib/sheets');

const _pending = new Map();
const PENDING_TTL = 30_000;

/* ── Global delivery mutex ────────────────────────────────────
   Prevents two DIFFERENT orders from grabbing the same account.
   Only one delivery can allocate an account at a time.
─────────────────────────────────────────────────────────────── */
let _deliveryLock = Promise.resolve();
function acquireDeliveryLock() {
  let release;
  const prev = _deliveryLock;
  _deliveryLock = new Promise(r => { release = r; });
  return prev.then(() => release);
}

function cleanPending() {
  const now = Date.now();
  for (const [k, t] of _pending) { if (now - t > PENDING_TTL) _pending.delete(k); }
}

function alreadyDeliveredResponse(res, order) {
  return res.status(200).json({
    success: true,
    alreadyDelivered: true,
    account: { email: order.accountEmail, password: order.accountPassword },
    order: {
      uniqueCode: order.uniqueCode, buyerEmail: order.buyerEmail,
      soldAt: order.soldAt, productType: order.productType,
      productName: order.productName, orderId: order.orderId,
    },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const code       = (req.query.uniquecode || '').trim();
  const emailParam = (req.query.email      || '').trim().toLowerCase();

  if (!code || code.length < 5) {
    return res.status(400).json({ success: false, error: 'Missing or invalid unique code.' });
  }

  try {
    cleanPending();
    if (_pending.has(code)) {
      await new Promise(r => setTimeout(r, 3000));
      const existing = await findOrderByCode(code);
      if (existing) return alreadyDeliveredResponse(res, existing);
      return res.status(429).json({ success: false, error: 'Order is being processed. Please wait.' });
    }
    _pending.set(code, Date.now());

    // Idempotency check
    const existing = await findOrderByCode(code);
    if (existing) {
      if (emailParam && existing.buyerEmail && existing.buyerEmail !== 'unknown') {
        if (emailParam !== existing.buyerEmail.toLowerCase()) {
          return res.status(403).json({ success: false, error: 'Email does not match. / Email не совпадает.' });
        }
      }
      return alreadyDeliveredResponse(res, existing);
    }

    // Verify via Digiseller
    let platiInfo;
    try { platiInfo = await verifyUniqueCode(code); }
    catch (err) { return res.status(400).json({ success: false, error: err.message }); }

    // Email check
    const buyerEmail = (platiInfo.buyer || '').toLowerCase();
    if (emailParam && buyerEmail && buyerEmail !== 'unknown') {
      if (emailParam !== buyerEmail) {
        return res.status(403).json({ success: false, error: 'Email does not match. / Email не совпадает.' });
      }
    }

    /* ── ATOMIC: acquire lock → get account → delete → save → release ── */
    const releaseLock = await acquireDeliveryLock();
    let account;
    try {
      // Re-check idempotency inside lock (another request may have just delivered)
      const raceCheck = await findOrderByCode(code);
      if (raceCheck) {
        releaseLock();
        return alreadyDeliveredResponse(res, raceCheck);
      }

      // Get account
      account = await getNextAvailableAccount(SHEET_NAME);
      if (!account) {
        releaseLock();
        return res.status(503).json({ success: false, outOfStock: true, productName: 'Grok Account', orderId: platiInfo.orderId || null, error: 'Out of stock. Contact support.' });
      }

      // Deliver atomically — delete row + save order inside lock
      await deleteAccountRow(SHEET_NAME, account.rowIndex);
      await saveOrder({
        uniqueCode: code,
        buyerEmail: platiInfo.buyer || emailParam || 'unknown',
        accountEmail: account.email,
        accountPassword: account.password,
        orderId: platiInfo.orderId,
        productType: 'grok',
        productName: 'Grok Account',
      });

      releaseLock();
    } catch (lockErr) {
      releaseLock();
      throw lockErr;
    }

    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: {
        uniqueCode: code, buyerEmail: platiInfo.buyer || emailParam || 'unknown',
        soldAt: new Date().toISOString(), productType: 'grok',
        productName: 'Grok Account', orderId: platiInfo.orderId,
      },
    });
  } catch (err) {
    console.error('[verify] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  } finally {
    _pending.delete(code);
  }
};
