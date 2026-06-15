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

import { google } from 'googleapis';

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

async function getOrCreateSheet(sheetsApi, sheetId, tabName, headerRow) {
  const sheet = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
  let tabSheetId = sheet.data.sheets?.find(s => s.properties.title === tabName)?.properties.sheetId;

  if (tabSheetId === undefined || tabSheetId === null) {
    const addSheet = await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: { properties: { title: tabName } },
        }],
      },
    });
    tabSheetId = addSheet.data.replies[0].addSheet.properties.sheetId;

    if (headerRow) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headerRow] },
      });
    }
  }

  return tabSheetId;
}

async function appendEntries(sheetsApi, sheetId, entries) {
  await getOrCreateSheet(sheetsApi, sheetId, 'Entries', [
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
    e.severity || '',
    e.quality || '',
    e.notes || '',
    e.createdAt,
  ]);

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Entries!A:K',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

async function appendHypotheses(sheetsApi, sheetId, hypotheses) {
  await getOrCreateSheet(sheetsApi, sheetId, 'Hypotheses', [
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

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Hypotheses!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
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
