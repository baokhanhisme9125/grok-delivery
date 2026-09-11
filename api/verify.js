/**
 * /api/verify?uniquecode=XXX&email=YYY
 * Grok account delivery via Plati.market (Digiseller API)
 *
 * Race-condition safe: CLAIMED marker + double-check + post-save dedup
 */
const { verifyUniqueCode } = require('../lib/plati');
const {
  getNextAvailableAccount, deleteAccountRow, saveOrder,
  savePendingOrder, findOrderByCode, findAllOrdersByCode,
  deleteOrderRow, isAccountAlreadyDelivered, SHEET_NAME,
} = require('../lib/sheets');

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
    success: false, outOfStock: true, isPending: true,
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

  // Auto-correct swapped fields
  if (code.includes('@') && /^[0-9A-Fa-f]{16}$/i.test(emailParam)) {
    const tmp = code; code = emailParam; emailParam = tmp;
  }

  if (!code || code.length < 5) {
    return res.status(400).json({ success: false, error: 'Missing or invalid unique code.' });
  }

  try {
    /* ── 1. Idempotency check ──────────────────────────────────────── */
    const existing = await findOrderByCode(code);
    if (existing) {
      if (emailParam && existing.buyerEmail && existing.buyerEmail !== 'unknown') {
        if (emailParam !== existing.buyerEmail.toLowerCase()) {
          return res.status(403).json({ success: false, error: 'Email does not match. / Email не совпадает.' });
        }
      }
      if (existing.isPending) return pendingResponse(res, existing);
      return alreadyDeliveredResponse(res, existing);
    }

    /* ── 2. Verify via Digiseller (includes product whitelist + refund + unknown buyer check) ── */
    let platiInfo;
    try {
      platiInfo = await verifyUniqueCode(code);
    } catch (err) {
      // STRICT: if Digiseller rejects the code for ANY reason, block it.
      // No more "save pending for unverified codes" — that's the unknown buyer hole.
      return res.status(400).json({ success: false, error: err.message });
    }

    /* ── 3. Email check ────────────────────────────────────────────── */
    const buyerEmail = (platiInfo.buyer || '').toLowerCase();
    if (emailParam && buyerEmail && buyerEmail !== 'unknown') {
      if (emailParam !== buyerEmail) {
        return res.status(403).json({ success: false, error: 'Email does not match. / Email не совпадает.' });
      }
    }

    /* ── 4. Claim account atomically via CLAIMED: marker ────────── */
    const account = await getNextAvailableAccount(SHEET_NAME, code);
    if (!account) {
      const pendingCheck = await findOrderByCode(code);
      if (pendingCheck) return pendingResponse(res, pendingCheck);

      await savePendingOrder({
        uniqueCode: code,
        buyerEmail: platiInfo.buyer || emailParam || 'unknown',
        orderId: platiInfo.orderId,
        productType: 'grok',
        productName: 'Grok Account',
      });
      console.log(`[verify] OOS — saved pending order for code=${code}`);
      return res.status(503).json({
        success: false, outOfStock: true, isPending: true,
        productName: 'Grok Account', orderId: platiInfo.orderId || null,
        error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
      });
    }

    /* ── 5. Double-check Orders BEFORE saving (cross-instance race) ── */
    const raceCheck = await findOrderByCode(code);
    if (raceCheck && !raceCheck.isPending) {
      console.warn(`[verify] Race detected for code=${code} — releasing claimed account`);
      try {
        await deleteAccountRow(SHEET_NAME, null, account.claimMark);
      } catch (e) { console.warn('[verify] Could not revert:', e.message); }
      return alreadyDeliveredResponse(res, raceCheck);
    }

    /* ── 5b. FRESH duplicate account check (prevent same account → 2 buyers) ── */
    const accountDup = await isAccountAlreadyDelivered(account.email, account.password);
    if (accountDup) {
      console.warn(`[verify] DUPLICATE ACCOUNT BLOCKED: ${account.email} already delivered to another buyer. Reverting claim for code=${code}`);
      // Don't deliver — revert the claim so account row is cleaned up
      // The claimed row will be auto-reverted by cleanupClaimedRows from Column B backup
      return res.status(500).json({
        success: false,
        error: 'Server error — account conflict detected. Please try again.',
      });
    }

    /* ── 6. Delete claimed row + save order ──────────────────────── */
    await deleteAccountRow(SHEET_NAME, null, account.claimMark);
    await saveOrder({
      uniqueCode: code,
      buyerEmail: platiInfo.buyer || emailParam || 'unknown',
      accountEmail: account.email,
      accountPassword: account.password,
      orderId: platiInfo.orderId,
      productType: 'grok',
      productName: 'Grok Account',
    });

    /* ── 7. Post-save duplicate detection ────────────────────────── */
    try {
      const allOrders = await findAllOrdersByCode(code);
      if (allOrders.length > 1) {
        console.warn(`[verify] DUPLICATE: ${allOrders.length} orders for code=${code}. Cleaning...`);
        for (let i = 1; i < allOrders.length; i++) {
          await deleteOrderRow(allOrders[i].rowIndex);
        }
      }
    } catch (e) { console.warn('[verify] Dedup error:', e.message); }

    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: {
        uniqueCode: code,
        buyerEmail: platiInfo.buyer || emailParam || 'unknown',
        soldAt: new Date().toISOString(),
        productType: 'grok',
        productName: 'Grok Account',
        orderId: platiInfo.orderId,
      },
    });
  } catch (err) {
    console.error('[verify] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
};
