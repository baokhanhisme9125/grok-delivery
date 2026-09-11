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
 * Revert stale CLAIMED rows from Column B backup.
 * If a CLAIMED row has backup in Column B and is older than 5 min → restore it.
 * If no backup → log warning (account was lost by old code).
 */
async function cleanupClaimedRows(sheets, sheetTab, sheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTab}'!A:B`,
    });
    const rows = res.data.values || [];
    const STALE_MS = 5 * 60 * 1000;

    for (let i = 0; i < rows.length; i++) {
      const cell = (rows[i][0] || '').trim();
      if (!cell.startsWith('CLAIMED:')) continue;
      const backup = (rows[i][1] || '').trim();
      const rest = cell.slice('CLAIMED:'.length);
      const ts = parseInt(rest, 10);
      // Only auto-revert timestamp-based markers (old code). UniqueCode markers are handled by verify.
      if (!isNaN(ts) && ts > 1700000000000 && Date.now() - ts > STALE_MS) {
        if (backup) {
          console.warn(`[sheets] Reverting stale CLAIMED row ${i + 1} from backup`);
          try {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${sheetTab}'!A${i + 1}:B${i + 1}`,
              valueInputOption: 'RAW',
              requestBody: { values: [[backup, '']] },
            });
          } catch (e) { console.warn(`[sheets] Revert row ${i + 1} failed:`, e.message); }
        } else {
          console.warn(`[sheets] Stale CLAIMED row ${i + 1} has NO backup — account may be lost`);
        }
      }
    }
  } catch (e) {
    console.warn('[sheets] cleanupClaimedRows failed:', e.message);
  }
}

/**
 * Atomically claim the next available account using optimistic locking.
 * Backs up original account to Column B before claiming.
 * Returns { email, password, claimMark } on success, or null if out of stock.
 */
async function getNextAvailableAccount(sheetName, uniqueCode) {
  if (!uniqueCode) throw new Error('[sheets] uniqueCode is required for claiming');
  const sheets = await getSheetsClient();
  const sheetTab = sheetName || SHEET_NAME;

  // Get sheet metadata
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetTab);
  if (!sheetMeta) throw new Error(`Sheet "${sheetTab}" not found`);
  const sheetId = sheetMeta.properties.sheetId;

  // Run cleanup of stale CLAIMED rows in background
  cleanupClaimedRows(sheets, sheetTab, sheetId).catch(() => {});

  // Fetch stock (A:B for backup) + delivered accounts
  const [stockRes, deliveredSet] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTab}'!A:B`,
    }),
    getDeliveredAccountSet(sheets, ORDERS_SHEET),
  ]);

  const rows = stockRes.data.values || [];

  // Guard: if this uniqueCode is already claimed
  const alreadyClaimed = rows.some(r => (r[0] || '').trim() === `CLAIMED:${uniqueCode}`);
  if (alreadyClaimed) {
    console.log(`[sheets] CLAIMED:${uniqueCode} already exists — waiting...`);
    await new Promise(r => setTimeout(r, 800));
    return null;
  }

  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell) continue;
    if (cell.startsWith('CLAIMED:')) continue;
    if (cell.startsWith('FORMAT_ERROR:')) continue;

    const parsed = parseAccountCell(cell);
    if (!parsed) {
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

    // ── Backup to Column B, then claim Column A ──
    const claimMark = `CLAIMED:${uniqueCode}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetTab}'!A${i + 1}:B${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[claimMark, cell]] },  // A=CLAIMED, B=original backup
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
      return { email, password, claimMark, _sheetTab: sheetTab, _sheetId: sheetId };
    }

    console.warn(`[sheets] Row ${i + 1} race lost (got: ${verifyCell.slice(0, 40)}), trying next`);
  }

  return null; // Out of stock
}

/**
 * Delete ALL rows identified by their CLAIMED marker (NOT by row index).
 * Handles the case where the same code accidentally claimed multiple rows
 * (webhook + verify race condition), leaving duplicate CLAIMED markers.
 */
async function deleteClaimedRow(sheetTab, sheetId, claimMark) {
  const sheets = await getSheetsClient();

  // Scan for ALL rows with this marker (may be >1 if webhook+verify raced)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetTab}'!A:A`,
  });
  const rows = res.data.values || [];
  const targetIndices = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === claimMark) targetIndices.push(i);
  }

  if (targetIndices.length === 0) {
    console.warn(`[sheets] deleteClaimedRow: marker not found: ${claimMark}`);
    return;
  }
  if (targetIndices.length > 1) {
    console.warn(`[sheets] deleteClaimedRow: found ${targetIndices.length} rows with marker ${claimMark} — deleting all`);
  }

  // Delete in REVERSE order so indices don't shift during deletion
  for (let j = targetIndices.length - 1; j >= 0; j--) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: targetIndices[j], endIndex: targetIndices[j] + 1 },
            },
          }],
        },
      });
    } catch (e) {
      console.warn(`[sheets] deleteClaimedRow: failed to delete index ${targetIndices[j]}:`, e.message);
    }
  }
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

async function findAllOrdersByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!A:G`,
  });
  const rows = res.data.values || [];
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      const accountCell = rows[i][2] || '';
      const colonIdx    = accountCell.indexOf(':');
      matches.push({
        rowIndex:        i + 1,
        uniqueCode:      rows[i][0] || '',
        buyerEmail:      rows[i][1] || '',
        accountEmail:    colonIdx >= 0 ? accountCell.slice(0, colonIdx).trim() : accountCell,
        accountPassword: colonIdx >= 0 ? accountCell.slice(colonIdx + 1).trim() : '',
        soldAt:          rows[i][3] || '',
        orderId:         rows[i][4] || '',
        productType:     rows[i][5] || '',
        productName:     rows[i][6] || 'Grok Account',
        isPending:       !accountCell.includes(':'),
      });
    }
  }
  return matches;
}

async function deleteOrderRow(rowIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === ORDERS_SHEET);
  if (!sheet) throw new Error('Orders sheet not found');
  const sheetId = sheet.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }],
    },
  });
}

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
      return parseAccountCell(c) !== null;
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

/**
 * FRESH check: is this exact account (email:password) already in Orders Column C?
 * Call this RIGHT BEFORE saveOrder to prevent duplicate account delivery.
 */
async function isAccountAlreadyDelivered(accountEmail, accountPassword) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ORDERS_SHEET}'!C:C`,
    });
    const rows = res.data.values || [];
    const needle = `${accountEmail}:${accountPassword}`.toLowerCase().trim();
    for (const row of rows) {
      const cell = (row[0] || '').trim().toLowerCase();
      if (cell === needle) return true;
      // Also check with space around colon
      if (cell.replace(/\s*:\s*/, ':') === needle) return true;
    }
  } catch (e) {
    console.warn('[sheets] isAccountAlreadyDelivered check failed:', e.message);
  }
  return false;
}

module.exports = {
  getNextAvailableAccount,
  deleteAccountRow,
  deleteClaimedRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
  findAllOrdersByCode,
  deleteOrderRow,
  findRecentOrderByEmail,
  isAccountAlreadyDelivered,
  getAllStock,
  PRODUCT_SHEETS,
  SHEET_NAME,
  ORDERS_SHEET,
};
