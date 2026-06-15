// api/sheets.js
// Syncs Bloom entries and hypotheses to Google Sheets.
//
// SECURITY: Credentials come ONLY from environment variables.
// Set GOOGLE_SERVICE_ACCOUNT_KEY in Vercel to the FULL JSON content of your
// service account key file (the whole {...} block).
// Set GOOGLE_SHEET_ID to your spreadsheet ID.
//
// Never hardcode private keys in source files - this repo may be public
// or could become public, and committed secrets stay in git history forever
// even if removed later.
//
// ROW-WRITING STRATEGY:
// Previously used spreadsheets.values.append(), which asks Google Sheets to
// auto-detect "the table" within a range and append after it. When a row has
// gaps (empty cells in the middle of A:K, which Bloom rows always do, since
// most fields are blank for most categories), that auto-detection can get
// confused about which columns the table occupies, and starts writing new
// rows in the wrong columns entirely (observed: row 1 in A:K, later rows
// shifted to start at K).
//
// Fix: explicitly find the true last used row (by reading a wide range,
// A:Z, so it accounts for any stray/misaligned legacy data too) and write
// new rows to an exact A{n}:X{n} range via values.update. No auto-detection,
// no surprises.
//
// Also: headers are now written whenever row 1 is empty, regardless of
// whether the tab itself is new - so pre-existing-but-empty-header tabs get
// fixed on the next sync.

import { google } from 'googleapis';
import { requireAuth } from './_lib/auth.js';

function getServiceAccountCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is not set');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ' + err.message);
  }
}

function getSheetsApi() {
  const credentials = getServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  try {
    const sheetsApi = getSheetsApi();
    const defaultSheetId = process.env.GOOGLE_SHEET_ID;

    if (req.method === 'POST') {
      const { action, entries, hypotheses, sheetId } = req.body || {};
      const targetSheetId = sheetId || defaultSheetId;

      if (!targetSheetId) {
        return res.status(400).json({ error: 'No sheetId provided and GOOGLE_SHEET_ID not set' });
      }

      if (action === 'appendEntries' && entries) {
        await appendEntries(sheetsApi, targetSheetId, entries);
        return res.status(200).json({ success: true, message: 'Entries synced' });
      } else if (action === 'appendHypotheses' && hypotheses) {
        await appendHypotheses(sheetsApi, targetSheetId, hypotheses);
        return res.status(200).json({ success: true, message: 'Hypotheses synced' });
      } else {
        return res.status(400).json({ error: 'Invalid action. Expected appendEntries or appendHypotheses with matching data.' });
      }

    } else if (req.method === 'GET') {
      const { action, sheetId } = req.query;
      const targetSheetId = sheetId || defaultSheetId;

      if (action === 'getLastSync') {
        const lastSync = await getLastSyncTime(sheetsApi, targetSheetId);
        return res.status(200).json({ lastSync });
      } else if (action === 'ping') {
        // Quick health check that credentials + sheet access work
        const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: targetSheetId });
        return res.status(200).json({
          success: true,
          title: meta.data.properties?.title,
          tabs: meta.data.sheets?.map(s => s.properties.title)
        });
      } else {
        return res.status(400).json({ error: 'Invalid action. Use ?action=getLastSync or ?action=ping' });
      }

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Sheets API error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// Convert a 1-based column number to its letter (1 -> A, 11 -> K, 27 -> AA)
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Ensures the tab exists, and ensures row 1 has the given header - written
// whenever A1 is empty, regardless of whether the tab is brand new or was
// already there with no header (covers both cases).
async function ensureTabAndHeader(sheetsApi, sheetId, tabName, headerRow) {
  const sheet = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
  const tabExists = (sheet.data.sheets || []).some(s => s.properties.title === tabName);

  if (!tabExists) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
  }

  const a1 = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!A1`,
  });
  const hasHeader = !!(a1.data.values && a1.data.values[0] && a1.data.values[0][0]);

  if (!hasHeader) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] },
    });
  }
}

// Writes `rows` starting at the true next empty row, determined by reading
// a wide range (A:Z) so any stray/misaligned legacy data in far-right
// columns is accounted for too. Targets an exact A{n}:X{n} range - no
// reliance on append()'s table auto-detection.
async function writeRowsAfterLastUsed(sheetsApi, sheetId, tabName, rows) {
  const existing = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!A:Z`,
  });
  const usedRows = existing.data.values ? existing.data.values.length : 0;
  const startRow = usedRows + 1;
  const endRow = startRow + rows.length - 1;
  const numCols = rows[0].length;
  const endCol = columnLetter(numCols);

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A${startRow}:${endCol}${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

async function appendEntries(sheetsApi, sheetId, entries) {
  await ensureTabAndHeader(sheetsApi, sheetId, 'Entries', [
    'Date', 'StartTime', 'EndTime', 'Category', 'Item', 'Detail', 'Pills', 'Severity', 'Quality', 'Notes', 'CreatedAt'
  ]);

  const rows = entries.map(e => [
    e.date,
    e.startTime,
    e.endTime || '',
    e.category,
    e.item || '',
    e.detail || '',
    JSON.stringify(e.selectedPills || {}),
    e.severity ?? '',
    e.quality ?? '',
    e.notes || '',
    e.createdAt,
  ]);

  await writeRowsAfterLastUsed(sheetsApi, sheetId, 'Entries', rows);
}

async function appendHypotheses(sheetsApi, sheetId, hypotheses) {
  await ensureTabAndHeader(sheetsApi, sheetId, 'Hypotheses', [
    'Hypothesis', 'UserConfidence', 'Sources', 'Notes', 'CreatedAt', 'AppConfidence'
  ]);

  const rows = hypotheses.map(h => [
    h.hypothesis,
    h.userConfidence,
    Array.isArray(h.sources) ? h.sources.join(', ') : (h.source || ''),
    h.notes || '',
    h.createdAt,
    h.appConfidence || '',
  ]);

  await writeRowsAfterLastUsed(sheetsApi, sheetId, 'Hypotheses', rows);
}

async function getLastSyncTime(sheetsApi, sheetId) {
  try {
    const response = await sheetsApi.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'properties.title,sheets.properties'
    });
    return response.data.properties?.title ? new Date().toISOString() : null;
  } catch {
    return null;
  }
}
