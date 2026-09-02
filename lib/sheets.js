const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getAuth() {
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT JSON'); }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

/* ─────────────────────────────────────────────────────────────
   PRODUCT SHEET  ("Grok Account")
   Column A only:  Email:Password
   Example row:    acc1@email.com:Pass@123
───────────────────────────────────────────────────────────── */

const SHEET_NAME = 'Grok Account';

/**
 * Build a Set of account strings (email:password) already present in Column C
 * of the Orders sheet, so we never re-deliver the same account.
 */
async function getDeliveredAccountSet(sheets, ordersSheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ordersSheetName}'!C:C`,
    });
    const rows = res.data.values || [];
    const used = new Set();
    for (const row of rows) {
      const cell = (row[0] || '').trim().toLowerCase();
      if (cell && cell.includes(':')) used.add(cell);
    }
    return used;
  } catch {
    return new Set(); // If fetch fails, don't block delivery — just skip duplicate check
  }
}

/**
 * Atomically claim the next available account using optimistic locking
 * + duplicate-account guard.
 *
 * Strategy (serverless-safe, works across multiple Vercel instances):
 *   1. Pre-load all already-delivered accounts from Orders Col C into a Set.
 *   2. Read all rows from the product sheet.
 *   3. Find first row that:
 *      a. Looks like "email:password" (no CLAIMED: prefix)
 *      b. Is NOT already in the delivered-accounts Set
 *   4. Overwrite that cell with "CLAIMED:<uniqueCode>" marker.
 *   5. Wait a short random delay, then re-read the cell.
 *   6. If the cell still has OUR marker → we own it. Return { rowIndex, email, password }.
 *   7. If someone else's marker is there → try the next row.
 *   8. If no rows available → return null (Out of Stock).
 */
async function getNextAvailableAccount(sheetName, uniqueCode) {
  const sheets = await getSheetsClient();
  const sheetTab = sheetName || SHEET_NAME;

  // ── Fetch both sheets in parallel ──
  const [stockRes, deliveredSet] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTab}'!A:A`,
    }),
    getDeliveredAccountSet(sheets, ORDERS_SHEET),
  ]);

  const rows = stockRes.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell) continue;
    if (cell.startsWith('CLAIMED:')) continue;
    if (!cell.includes(':')) continue;

    const colonIdx = cell.indexOf(':');
    const email    = cell.slice(0, colonIdx).trim();
    const password = cell.slice(colonIdx + 1).trim();
    if (!email || !password) continue;

    // ── Duplicate guard: skip if this account was already delivered ──
    const normalized = `${email}:${password}`.toLowerCase();
    if (deliveredSet.has(normalized)) {
      console.warn(`[sheets] Skipping already-delivered account at row ${i + 1}: ${email}`);
      continue;
    }

    // ── Attempt to claim this row ──
    const claimMark = `CLAIMED:${uniqueCode || Date.now()}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetTab}'!A${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[claimMark]] },
      });
    } catch (writeErr) {
      console.warn(`[sheets] Claim write failed row ${i + 1}:`, writeErr.message);
      continue;
    }

    // ── Wait a short random delay, then verify we own it ──
    await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));

    let verifyCell = '';
    try {
      const vRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetTab}'!A${i + 1}`,
      });
      verifyCell = (vRes.data.values?.[0]?.[0] || '').trim();
    } catch (readErr) {
      console.warn(`[sheets] Claim verify read failed row ${i + 1}:`, readErr.message);
      continue;
    }

    if (verifyCell === claimMark) {
      // We own this row — return the original credentials
      return { rowIndex: i + 1, email, password };
    }

    // Another concurrent process claimed this row first — try next
    console.warn(`[sheets] Row ${i + 1} race lost (got: ${verifyCell.slice(0, 40)}), trying next`);
  }

  return null; // Out of stock
}

/**
 * Delete the CLAIMED row from the product sheet after order is fully saved.
 */
async function deleteAccountRow(sheetName, rowIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === (sheetName || SHEET_NAME));
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId:    sheet.properties.sheetId,
            dimension:  'ROWS',
            startIndex: rowIndex - 1,
            endIndex:   rowIndex,
          },
        },
      }],
    },
  });
}





/* ─────────────────────────────────────────────────────────────
   ORDERS SHEET  (tab: "Grok Orders")
   A: UniqueCode | B: BuyerEmail | C: Account (Email:Password)
   D: SoldAt | E: OrderID | F: ProductType | G: ProductName
   H: DeliveryLink
───────────────────────────────────────────────────────────── */

const ORDERS_SHEET = 'Grok Orders';

async function saveOrder({ uniqueCode, buyerEmail, accountEmail, accountPassword, orderId, productType, productName }) {
  const sheets = await getSheetsClient();
  const deliveryLink = `https://grok-delivery.vercel.app/delivery.html?uniquecode=${encodeURIComponent(uniqueCode)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        uniqueCode,
        buyerEmail,
        `${accountEmail}:${accountPassword}`,
        new Date().toISOString(),
        orderId,
        productType,
        productName,
        deliveryLink,
      ]],
    },
  });
}

/**
 * Save a pending order with BLANK column C (no account yet).
 * The seller will manually fill column C when stock is available.
 */
async function savePendingOrder({ uniqueCode, buyerEmail, orderId, productType, productName }) {
  const sheets = await getSheetsClient();
  const deliveryLink = `https://grok-delivery.vercel.app/delivery.html?uniquecode=${encodeURIComponent(uniqueCode)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        uniqueCode,
        buyerEmail,
        '',  // Column C blank — seller fills manually
        new Date().toISOString(),
        orderId,
        productType,
        productName,
        deliveryLink,
      ]],
    },
  });
}

async function findOrderByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!A:G`,
  });

  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      const accountCell = rows[i][2] || '';
      const colonIdx    = accountCell.indexOf(':');
      const accountEmail    = colonIdx >= 0 ? accountCell.slice(0, colonIdx).trim() : accountCell;
      const accountPassword = colonIdx >= 0 ? accountCell.slice(colonIdx + 1).trim() : '';
      return {
        uniqueCode:      rows[i][0] || '',
        buyerEmail:      rows[i][1] || '',
        accountEmail,
        accountPassword,
        soldAt:          rows[i][3] || '',
        orderId:         rows[i][4] || '',
        productType:     rows[i][5] || '',
        productName:     rows[i][6] || 'Grok Account',
        isPending:       !accountCell.includes(':'),  // C blank = pending
      };
    }
  }
  return null;
}

/**
 * Find a recent order by buyer email (within last `windowMs` milliseconds).
 * Used to prevent cross-platform duplicates (Plati + GGSEL same buyer).
 * Returns the most recent matching order or null.
 */
async function findRecentOrderByEmail(buyerEmail, windowMs = 10 * 60 * 1000) {
  if (!buyerEmail || buyerEmail === 'unknown') return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!A:G`,
  });
  const rows = res.data.values || [];
  const now = Date.now();
  const email = buyerEmail.trim().toLowerCase();
  let bestMatch = null;

  for (let i = 0; i < rows.length; i++) {
    const rowEmail = (rows[i][1] || '').trim().toLowerCase();
    if (rowEmail !== email) continue;

    const soldAt = rows[i][3] || '';
    const orderTime = new Date(soldAt).getTime();
    if (isNaN(orderTime)) continue;
    if (now - orderTime > windowMs) continue;

    const accountCell = rows[i][2] || '';
    const colonIdx = accountCell.indexOf(':');
    bestMatch = {
      uniqueCode:      rows[i][0] || '',
      buyerEmail:      rows[i][1] || '',
      accountEmail:    colonIdx >= 0 ? accountCell.slice(0, colonIdx).trim() : accountCell,
      accountPassword: colonIdx >= 0 ? accountCell.slice(colonIdx + 1).trim() : '',
      soldAt,
      orderId:         rows[i][4] || '',
      productType:     rows[i][5] || '',
      productName:     rows[i][6] || 'Grok Account',
      isPending:       !accountCell.includes(':'),
    };
    // Keep scanning — we want the MOST RECENT match
  }
  return bestMatch;
}

/* ─────────────────────────────────────────────────────────────
   STOCK SUMMARY
───────────────────────────────────────────────────────────── */
const PRODUCT_SHEETS = [
  { key: 'grok', name: 'Grok Account', sheetName: 'Grok Account' },
];

async function getSheetStock(sheetName) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A:A`,
    });
    const rows = (res.data.values || []).filter(r => {
      const c = (r[0] || '').trim();
      return c.includes(':');
    });
    return { available: rows.length, total: rows.length };
  } catch {
    return { available: 0, total: 0, error: 'Sheet not found' };
  }
}

async function getAllStock() {
  return Promise.all(
    PRODUCT_SHEETS.map(async p => ({
      key:  p.key,
      name: p.name,
      ...(await getSheetStock(p.sheetName)),
    }))
  );
}

module.exports = {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
  findRecentOrderByEmail,
  getAllStock,
  PRODUCT_SHEETS,
  SHEET_NAME,
  ORDERS_SHEET,
};
