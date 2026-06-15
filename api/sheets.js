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
      } else if (action === 'getEntries') {
        const entries = await getEntries(sheetsApi, targetSheetId);
        return res.status(200).json({ entries });
      } else if (action === 'getHypotheses') {
        const hypotheses = await getHypotheses(sheetsApi, targetSheetId);
        return res.status(200).json({ hypotheses });
      } else {
        return res.status(400).json({ error: 'Invalid action. Use ?action=getLastSync, ping, getEntries, or getHypotheses' });
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

// Ensures the tab exists, and ensures row 1 exactly matches headerRow.
// Previously this only wrote a header when A1 was completely empty - which
// meant adding a new column (like EntryId, below) to an existing tab's
// schema would never update its header row. Now it rewrites row 1 whenever
// it doesn't match, which is harmless (it's our own managed header) and
// keeps tabs created before a schema change in sync automatically.
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
    range: `${tabName}!A1:${columnLetter(headerRow.length)}1`,
  });
  const currentHeader = (a1.data.values && a1.data.values[0]) || [];
  const matches = headerRow.length === currentHeader.length &&
    headerRow.every((h, i) => h === currentHeader[i]);

  if (!matches) {
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
    'Date', 'StartTime', 'EndTime', 'Category', 'Item', 'Detail', 'Pills', 'Severity', 'Quality', 'Notes', 'CreatedAt', 'EntryId'
  ]);

  // EntryId (the app's local id for this entry) is appended as the last
  // column. Editing an entry re-appends a new row with the SAME EntryId -
  // getEntries() below uses this to find the latest version of each entry
  // (last row with a given EntryId wins) when reading the sheet back.
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
    e.id,
  ]);

  await writeRowsAfterLastUsed(sheetsApi, sheetId, 'Entries', rows);
}

async function appendHypotheses(sheetsApi, sheetId, hypotheses) {
  await ensureTabAndHeader(sheetsApi, sheetId, 'Hypotheses', [
    'Hypothesis', 'UserConfidence', 'Sources', 'Notes', 'CreatedAt', 'AppConfidence', 'EntryId'
  ]);

  // Same EntryId convention as Entries - see appendEntries for details.
  const rows = hypotheses.map(h => [
    h.hypothesis,
    h.userConfidence,
    Array.isArray(h.sources) ? h.sources.join(', ') : (h.source || ''),
    h.notes || '',
    h.createdAt,
    h.appConfidence || '',
    h.id,
  ]);

  await writeRowsAfterLastUsed(sheetsApi, sheetId, 'Hypotheses', rows);
}

// Reads the Entries tab back into entry objects matching the app's local
// schema. Since the sheet is append-only and edits append a new row with
// the same EntryId, this de-duplicates by EntryId - the LAST row with a
// given EntryId (i.e. the most recent edit) wins. Rows without an EntryId
// (written before this column existed) are skipped, since they can't be
// matched back to a local entry reliably.
async function getEntries(sheetsApi, sheetId) {
  const tabExists = await tabExistsCheck(sheetsApi, sheetId, 'Entries');
  if (!tabExists) return [];

  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A2:L',
  });
  const rows = resp.data.values || [];

  const map = new Map();
  for (const row of rows) {
    const [date, startTime, endTime, category, item, detail, pills, severity, quality, notes, createdAt, entryId] = row;
    if (!entryId) continue;

    // Tombstone: a later row with category '__deleted__' means this entry
    // was deleted after its last real sync. Remove it from the result
    // rather than treating '__deleted__' as a real category.
    if (category === '__deleted__') {
      map.delete(entryId);
      continue;
    }

    let selectedPills = {};
    try { selectedPills = pills ? JSON.parse(pills) : {}; } catch { selectedPills = {}; }

    map.set(entryId, {
      id: isNaN(Number(entryId)) ? entryId : Number(entryId),
      date,
      startTime,
      endTime: endTime || null,
      category,
      item: item || '',
      detail: detail || '',
      selectedPills,
      severity: severity || '',
      quality: quality || '',
      notes: notes || '',
      createdAt,
    });
  }

  return Array.from(map.values());
}

// Same de-duplication strategy as getEntries, for the Hypotheses tab.
async function getHypotheses(sheetsApi, sheetId) {
  const tabExists = await tabExistsCheck(sheetsApi, sheetId, 'Hypotheses');
  if (!tabExists) return [];

  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Hypotheses!A2:G',
  });
  const rows = resp.data.values || [];

  const map = new Map();
  for (const row of rows) {
    const [hypothesis, userConfidence, sources, notes, createdAt, appConfidence, entryId] = row;
    if (!entryId) continue;

    // Tombstone - see getEntries for explanation.
    if (hypothesis === '__deleted__') {
      map.delete(entryId);
      continue;
    }

    map.set(entryId, {
      id: isNaN(Number(entryId)) ? entryId : Number(entryId),
      hypothesis,
      userConfidence: Number(userConfidence) || 0,
      sources: sources ? sources.split(',').map(s => s.trim()).filter(Boolean) : [],
      notes: notes || '',
      createdAt,
      appConfidence: appConfidence || '',
    });
  }

  return Array.from(map.values());
}

async function tabExistsCheck(sheetsApi, sheetId, tabName) {
  const sheet = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
  return (sheet.data.sheets || []).some(s => s.properties.title === tabName);
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
