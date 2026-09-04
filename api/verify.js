/**
 * /api/verify?uniquecode=XXX&email=YYY
 * Grok account delivery via Plati.market (Digiseller API)
 *
 * Out-of-stock flow:
 *   1. No account available → save pending order (column C blank) → return OOS
 *   2. Seller fills column C manually
 *   3. Customer refreshes → finds pending order with C filled → delivers account
 */
const { verifyUniqueCode } = require('../lib/plati');
const {
  getNextAvailableAccount, deleteAccountRow, saveOrder,
  savePendingOrder, findOrderByCode, SHEET_NAME,
} = require('../lib/sheets');

const _pending = new Map();
const PENDING_TTL = 30_000;

/* ── Global delivery mutex ── */
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

function pendingResponse(res, order) {
  return res.status(503).json({
    success: false,
    outOfStock: true,
    isPending: true,
    productName: order.productName || 'Grok Account',
    orderId: order.orderId || null,
    error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let code       = (req.query.uniquecode || '').trim();
  let emailParam = (req.query.email      || '').trim().toLowerCase();

  // ── Auto-correct swapped fields ──────────────────────────────────────
  if (code.includes('@') && /^[0-9A-Fa-f]{16}$/i.test(emailParam)) {
    console.log(`[verify] Detected swapped fields — auto-correcting.`);
    const tmp = code; code = emailParam; emailParam = tmp;
  }

  if (!code || code.length < 5) {
    return res.status(400).json({ success: false, error: 'Missing or invalid unique code.' });
  }

  try {
    cleanPending();
    if (_pending.has(code)) {
      await new Promise(r => setTimeout(r, 3000));
      const existing = await findOrderByCode(code);
      if (existing && !existing.isPending) return alreadyDeliveredResponse(res, existing);
      if (existing && existing.isPending) return pendingResponse(res, existing);
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
      // If pending (C blank) → seller hasn't filled account yet → return OOS
      if (existing.isPending) {
        return pendingResponse(res, existing);
      }
      return alreadyDeliveredResponse(res, existing);
    }

    // Verify via Digiseller
    let platiInfo;
    try {
      platiInfo = await verifyUniqueCode(code);
    } catch (err) {
      // If Digiseller says "не найден unique_code" (retval:2) for a valid-looking 16-char hex code,
      // it means the code was already verified/consumed on Digiseller side (e.g. auto-verification)
      // but we never recorded it. Save a pending order so seller can manually deliver.
      const looksLikePlatiCode = /^[0-9A-Fa-f]{16}$/.test(code);
      const isNotFound = err.message && (err.message.includes('не найден') || err.message.includes('unique_code'));
      if (looksLikePlatiCode && isNotFound) {
        console.warn(`[verify] Digiseller retval:2 for code=${code} email=${emailParam} — saving pending for manual delivery`);
        const releaseLockPending = await acquireDeliveryLock();
        try {
          // Double-check it wasn't saved while waiting for lock
          const raceExisting = await findOrderByCode(code);
          if (raceExisting) {
            releaseLockPending();
            if (raceExisting.isPending) return pendingResponse(res, raceExisting);
            return alreadyDeliveredResponse(res, raceExisting);
          }
          await savePendingOrder({
            uniqueCode: code,
            buyerEmail: emailParam || 'unknown',
            orderId: '',
            productType: 'grok',
            productName: 'Grok Account',
          });
          releaseLockPending();
        } catch (pendingErr) {
          releaseLockPending();
          console.error('[verify] Failed to save pending for unverified code:', pendingErr.message);
        }
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: 'Grok Account', orderId: null,
          error: 'Your order was received. Please wait — an account will be delivered to this page shortly.',
        });
      }
      return res.status(400).json({ success: false, error: err.message });
    }

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
      // Re-check idempotency inside lock
      const raceCheck = await findOrderByCode(code);
      if (raceCheck && !raceCheck.isPending) {
        releaseLock();
        return alreadyDeliveredResponse(res, raceCheck);
      }
      if (raceCheck && raceCheck.isPending) {
        releaseLock();
        return pendingResponse(res, raceCheck);
      }

      // Get account (passes uniqueCode for optimistic lock claim marker)
      account = await getNextAvailableAccount(SHEET_NAME, code);
      if (!account) {
        // ── OUT OF STOCK: save pending order (C blank) ──
        await savePendingOrder({
          uniqueCode: code,
          buyerEmail: platiInfo.buyer || emailParam || 'unknown',
          orderId: platiInfo.orderId,
          productType: 'grok',
          productName: 'Grok Account',
        });
        releaseLock();
        console.log(`[verify] OOS — saved pending order for code=${code}`);
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: 'Grok Account', orderId: platiInfo.orderId || null,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }

      // Deliver atomically — delete row + save order inside lock
      await deleteAccountRow(SHEET_NAME, account.rowIndex, account.claimMark);
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
