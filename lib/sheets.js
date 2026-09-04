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
   Column A only:  Email:Password  (also accepts Email;Password)
   Example row:    acc1@email.com:Pass@123
───────────────────────────────────────────────────────────── */

const SHEET_NAME = 'Grok Account';

/**
 * Parse a stock-sheet cell into { email, password }.
 * Accepts both "email:password" and "email;password" formats.
 * Returns null if the cell is clearly malformed (no valid separator,
 * email part missing @, or password empty).
 */
function parseAccountCell(cell) {
  if (!cell || cell.startsWith('CLAIMED:') || cell.startsWith('FORMAT_ERROR:')) return null;

  // Prefer ':' as separator; fall back to ';'
  let sepIdx = -1;
  let sep = null;

  // Find the FIRST ':' that comes AFTER the '@' sign (to avoid splitting on the literal
  // colon inside a URL-like string but not inside email domain which has none).
  // Simple heuristic: find '@', then look for ':' or ';' after it.
  const atIdx = cell.indexOf('@');
  if (atIdx >= 0) {
    // Find separator after '@'
    const colonAfterAt = cell.indexOf(':', atIdx + 1);
    const semiAfterAt  = cell.indexOf(';', atIdx + 1);

    if (colonAfterAt >= 0 && (semiAfterAt < 0 || colonAfterAt <= semiAfterAt)) {
      sepIdx = colonAfterAt; sep = ':';
    } else if (semiAfterAt >= 0) {
      sepIdx = semiAfterAt; sep = ';';
    }
  } else {
    // No '@' in cell — try simple split on first ':' or ';'
    const c = cell.indexOf(':');
    const s = cell.indexOf(';');
    if (c >= 0 && (s < 0 || c <= s)) { sepIdx = c; sep = ':'; }
    else if (s >= 0)                  { sepIdx = s; sep = ';'; }
  }

  if (sepIdx < 0 || !sep) return null; // No separator found

  const email    = cell.slice(0, sepIdx).trim();
  const password = cell.slice(sepIdx + 1).trim();

  if (!email || !password) return null;          // Empty email or password
  if (!email.includes('@')) return null;          // Email must contain @

  return { email, password };
}



/**
 * Build a Set of account strings (email:password) already present in Column C
 * of the Orders sheet, so we never re-deliver the same account.
 * Skips CLAIMED: rows in the orders sheet.
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
      if (cell && cell.includes(':') && !cell.startsWith('claimed:')) used.add(cell);
    }
    return used;
  } catch {
    return new Set();
  }
}

/**
 * Remove stale CLAIMED: markers (older than 2 min) from the stock sheet.
 * Called on every delivery attempt so the sheet stays clean automatically.
 * A CLAIMED marker uses Date.now() as fallback, so we can detect age.
 */
async function cleanupClaimedRows(sheets, sheetTab, sheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTab}'!A:A`,
    });
    const rows = res.data.values || [];
    const staleIndices = [];
    const TWO_MIN = 2 * 60 * 1000;

    for (let i = 0; i < rows.length; i++) {
      const cell = (rows[i][0] || '').trim();
      if (!cell.startsWith('CLAIMED:')) continue;
      const rest = cell.slice('CLAIMED:'.length);
      // Timestamp-based marker (fallback when uniqueCode not provided)
      const ts = parseInt(rest, 10);
      if (!isNaN(ts) && Date.now() - ts > TWO_MIN) {
        staleIndices.push(i);
      }
    }

    if (staleIndices.length === 0) return;

    // Delete stale rows in reverse order so indices don't shift
    for (let j = staleIndices.length - 1; j >= 0; j--) {
      const idx = staleIndices[j];
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
              },
            }],
          },
        });
        console.log(`[sheets] Cleaned stale CLAIMED row ${idx + 1}`);
      } catch (e) {
        console.warn(`[sheets] Cleanup delete row ${idx + 1} failed:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[sheets] cleanupClaimedRows failed:', e.message);
  }
}

/**
 * Atomically claim the next available account using optimistic locking
 * + duplicate-account guard.
 *
 * Returns { email, password, claimMark } on success, or null if out of stock.
 * The caller MUST pass claimMark to deleteClaimedRow() after saving the order.
 * (deleteClaimedRow finds the row BY CONTENT, avoiding the row-index-shift bug.)
 */
async function getNextAvailableAccount(sheetName, uniqueCode) {
  const sheets = await getSheetsClient();
  const sheetTab = sheetName || SHEET_NAME;

  // Get sheet metadata (needed for cleanup + delete)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetTab);
  if (!sheetMeta) throw new Error(`Sheet "${sheetTab}" not found`);
  const sheetId = sheetMeta.properties.sheetId;

  // Run cleanup of stale CLAIMED rows in background (don't await)
  cleanupClaimedRows(sheets, sheetTab, sheetId).catch(() => {});

  // Fetch stock + delivered accounts in parallel
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
    if (cell.startsWith('FORMAT_ERROR:')) continue; // Already flagged, skip

    // Parse and validate the cell — handles both ':' and ';' separators
    const parsed = parseAccountCell(cell);
    if (!parsed) {
      // Malformed row: write FORMAT_ERROR marker so seller can see and fix it
      // Do NOT overwrite if it already looks like a valid format attempt
      const hasAnySeparator = cell.includes(':') || cell.includes(';');
      if (hasAnySeparator || cell.includes('@')) {
        console.warn(`[sheets] FORMAT_ERROR at row ${i + 1}: "${cell.slice(0, 60)}"`);
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${sheetTab}'!A${i + 1}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[`FORMAT_ERROR: ${cell}`]] },
          });
        } catch (e) {
          console.warn(`[sheets] Could not write FORMAT_ERROR to row ${i + 1}:`, e.message);
        }
      }
      continue;
    }

    const { email, password } = parsed;


    // Duplicate guard
    const normalized = `${email}:${password}`.toLowerCase();
    if (deliveredSet.has(normalized)) {
      console.warn(`[sheets] Skipping already-delivered account at row ${i + 1}: ${email}`);
      continue;
    }

    // Attempt to claim this row
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

    // Wait and verify ownership
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
      // We own this row — return credentials + claimMark for deletion
      return { email, password, claimMark, _sheetTab: sheetTab, _sheetId: sheetId };
    }

    console.warn(`[sheets] Row ${i + 1} race lost (got: ${verifyCell.slice(0, 40)}), trying next`);
  }

  return null; // Out of stock
}

/**
 * Delete the row identified by its CLAIMED marker (NOT by row index).
 * This is safe even when concurrent processes shift row indices.
 */
async function deleteClaimedRow(sheetTab, sheetId, claimMark) {
  const sheets = await getSheetsClient();

  // Find the row by its exact claim marker content
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetTab}'!A:A`,
  });
  const rows = res.data.values || [];
  let targetIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === claimMark) { targetIdx = i; break; }
  }
  if (targetIdx === -1) {
    console.warn(`[sheets] deleteClaimedRow: marker not found (may already be deleted): ${claimMark}`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: targetIdx, endIndex: targetIdx + 1 },
        },
      }],
    },
  });
}

/**
 * Legacy alias kept for compatibility with webhook.js / verify.js
 * that still call deleteAccountRow(sheetName, rowIndex).
 * Internally delegates to deleteClaimedRow using the claimMark if available.
 * If claimMark is not provided, falls back to index-based delete (legacy).
 */
async function deleteAccountRow(sheetName, rowIndex, claimMark) {
  const sheets = await getSheetsClient();
  const sheetTab = sheetName || SHEET_NAME;

  if (claimMark) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetTab);
    if (sheetMeta) {
      return deleteClaimedRow(sheetTab, sheetMeta.properties.sheetId, claimMark);
    }
  }

  // Legacy fallback: index-based delete (may be off by 1 under concurrent load)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetTab);
  if (!sheetMeta) throw new Error(`Sheet "${sheetTab}" not found`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetMeta.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1,
            endIndex: rowIndex,
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
      return parseAccountCell(c) !== null; // Only count valid, parseable accounts
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
  deleteClaimedRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
  findRecentOrderByEmail,
  getAllStock,
  PRODUCT_SHEETS,
  SHEET_NAME,
  ORDERS_SHEET,
};
