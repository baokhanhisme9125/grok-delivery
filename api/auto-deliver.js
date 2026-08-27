/**
 * /api/auto-deliver
 * Scans recent Digiseller sales for unverified unique codes and auto-delivers accounts.
 * 
 * Usage: GET /api/auto-deliver?secret=YOUR_API_KEY
 * - Fetches recent sales (last 7 days) from Digiseller API
 * - Checks which unique codes haven't been delivered yet
 * - Auto-delivers accounts for undelivered codes
 * - Writes results to Google Sheet "Grok Orders" tab
 */
const { getToken } = require('../lib/plati');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
  SHEET_NAME,
} = require('../lib/sheets');

const fetch = require('node-fetch');
const DIGI_API = 'https://api.digiseller.com/api';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Simple auth: require secret key to prevent abuse
  const secret = req.query.secret || '';
  const expectedSecret = process.env.DIGISELLER_API_KEY || '';
  if (!secret || secret !== expectedSecret) {
    return res.status(403).json({ success: false, error: 'Unauthorized. Provide ?secret=YOUR_API_KEY' });
  }

  const sellerId = process.env.PLATI_SELLER_ID || '';
  const daysBack = parseInt(req.query.days || '7', 10);

  try {
    const token = await getToken();

    // Fetch recent sales from Digiseller (POST required)
    const dateStart = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
    const dateEnd = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const salesRes = await fetch(`${DIGI_API}/seller-sells/v2?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        product_ids: [],
        date_start: dateStart,
        date_finish: dateEnd,
        returned: 0,
        page: 1,
        rows: 100,
      }),
      timeout: 30000,
    });
    const salesData = await salesRes.json();

    // Debug: try different response field names
    const sales = salesData.rows || salesData.content || salesData.sales || salesData.list || [];
    
    if (!Array.isArray(sales) || sales.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No sales data found',
        debug: {
          keys: Object.keys(salesData),
          cnt: salesData.cnt,
          pages: salesData.pages,
          retval: salesData.retval,
          retdesc: salesData.retdesc,
        },
        rawResponse: JSON.stringify(salesData).slice(0, 2000),
      });
    }

    const results = [];
    let delivered = 0;
    let skipped = 0;
    let errors = 0;
    let outOfStock = false;

    // Debug: show first sale structure
    const sampleSale = sales[0] ? {
      keys: Object.keys(sales[0]),
      data: sales[0],
    } : null;

    for (const sale of sales) {
      const uniqueCode = sale.product_entry || '';
      const orderId = String(sale.invoice_id || '');
      const buyerEmail = sale.email || '';

      if (!uniqueCode) {
        skipped++;
        results.push({ orderId, status: 'skipped', reason: 'no unique code' });
        continue;
      }

      // Check if already delivered
      const existing = await findOrderByCode(uniqueCode);
      if (existing) {
        skipped++;
        results.push({ orderId, uniqueCode: uniqueCode.slice(0, 8) + '...', status: 'already_delivered' });
        continue;
      }

      // Check stock
      if (outOfStock) {
        errors++;
        results.push({ orderId, uniqueCode: uniqueCode.slice(0, 8) + '...', status: 'out_of_stock' });
        continue;
      }

      // Get next available account
      const account = await getNextAvailableAccount(SHEET_NAME);
      if (!account) {
        outOfStock = true;
        errors++;
        results.push({ orderId, uniqueCode: uniqueCode.slice(0, 8) + '...', status: 'out_of_stock' });
        continue;
      }

      // Deliver
      try {
        await deleteAccountRow(SHEET_NAME, account.rowIndex);
        await saveOrder({
          uniqueCode,
          buyerEmail: buyerEmail || 'unknown',
          accountEmail: account.email,
          accountPassword: account.password,
          orderId,
          productType: 'grok',
          productName: 'Grok Account',
        });

        delivered++;
        results.push({
          orderId,
          uniqueCode: uniqueCode.slice(0, 8) + '...',
          buyer: buyerEmail,
          account: account.email,
          status: 'delivered',
        });

        // Small delay to avoid race conditions with Google Sheets
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        errors++;
        results.push({ orderId, uniqueCode: uniqueCode.slice(0, 8) + '...', status: 'error', error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      sampleSale,
      summary: {
        totalSales: sales.length,
        delivered,
        skipped,
        errors,
        dateRange: `${dateStart} → ${dateEnd}`,
      },
      results,
    });

  } catch (err) {
    console.error('[auto-deliver] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
