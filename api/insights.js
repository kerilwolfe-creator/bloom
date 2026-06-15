// api/insights.js
// Reads recent Entries + your Ideas (Hypotheses) from the Google Sheet,
// sends them to Claude, and returns a combined list of:
//   - your existing ideas, with an AI confidence score (0-100) and
//     possibly refined wording based on the evidence in your logs
//   - new patterns Claude noticed that you haven't logged as an Idea
// Sorted by AI confidence descending (done on the frontend, but the API
// also sorts as a convenience).
//
// Requires env vars: GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_KEY, ANTHROPIC_API_KEY

import { google } from 'googleapis';
import { requireAuth } from './_lib/auth.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_ENTRY_ROWS = 250; // cap how much log data we send, keeps prompt small/fast

// This function reads from Google Sheets, calls the Claude API (which can
// take 10-20+ seconds for this kind of analysis), and writes a log entry -
// all in one request. Vercel's default serverless timeout is 10 seconds,
// which isn't enough; on timeout Vercel returns an HTML error page instead
// of JSON, which the frontend can't parse (shows as "couldn't reach the AI
// Insights service"). Hobby plans allow up to 60s via this export.
export const maxDuration = 60;

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'ANTHROPIC_API_KEY not set',
        message: 'Add your Claude API key (from console.anthropic.com) as ANTHROPIC_API_KEY in Vercel env vars to enable AI Insights.'
      });
    }

    const sheetId = (req.query.sheetId || req.body?.sheetId) || process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      return res.status(400).json({ error: 'No sheetId provided and GOOGLE_SHEET_ID not set' });
    }

    const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!rawKey) {
      return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_KEY not set' });
    }
    let credentials;
    try {
      credentials = JSON.parse(rawKey);
    } catch (e) {
      return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ' + e.message });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheetsApi = google.sheets({ version: 'v4', auth });

    const { entries, hypotheses } = await readSheetData(sheetsApi, sheetId);

    if (entries.length === 0) {
      return res.status(200).json({
        generatedAt: new Date().toISOString(),
        insights: [],
        message: 'No logged entries yet - log some data first, then check back for insights.'
      });
    }

    const prompt = buildPrompt(entries, hypotheses);

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error('Claude API error:', errText);
      return res.status(500).json({ error: 'Claude API error', details: errText });
    }

    const claudeData = await claudeResponse.json();
    const textBlock = (claudeData.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(500).json({ error: 'Unexpected Claude response shape', raw: claudeData });
    }

    let parsed;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse Claude JSON:', textBlock.text);
      return res.status(500).json({ error: 'Could not parse AI response as JSON', raw: textBlock.text });
    }

    const insights = (parsed.insights || []).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    // Best-effort: log this run to an Insights_Log tab (non-fatal if it fails)
    try {
      await logRun(sheetsApi, sheetId, entries.length, hypotheses.length, insights.length);
    } catch (e) {
      console.warn('Insights_Log write failed (non-fatal):', e.message);
    }

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      entriesAnalyzed: entries.length,
      ideasReviewed: hypotheses.length,
      insights,
    });

  } catch (error) {
    console.error('Insights error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function readSheetData(sheetsApi, sheetId) {
  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
  const tabNames = new Set((spreadsheet.data.sheets || []).map(s => s.properties.title));

  let entries = [];
  if (tabNames.has('Entries')) {
    // A2:L - includes the EntryId column (L). Rows WITH an EntryId are
    // de-duplicated (latest edit wins, '__deleted__' tombstones drop the
    // entry). Rows WITHOUT an EntryId are legacy data written before this
    // column existed - included as-is, since dropping them would make all
    // pre-existing logged data invisible to the AI.
    const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Entries!A2:L' });
    const rows = resp.data.values || [];

    const byId = new Map();
    const legacy = [];
    rows.forEach(r => {
      const [date, startTime, endTime, category, item, detail, pills, severity, quality, notes, createdAt, entryId] = r;
      if (!date && !category && !entryId) return; // skip blank rows

      const entryObj = { date, startTime, endTime, category, item, detail, pills, severity, quality, notes };

      if (!entryId) { legacy.push(entryObj); return; }
      if (category === '__deleted__') { byId.delete(entryId); return; }
      byId.set(entryId, entryObj);
    });

    entries = [...legacy, ...Array.from(byId.values())].slice(-MAX_ENTRY_ROWS);
  }

  let hypotheses = [];
  if (tabNames.has('Hypotheses')) {
    // A2:G - includes EntryId (G). Same legacy-row handling as Entries.
    const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Hypotheses!A2:G' });
    const rows = resp.data.values || [];

    const byId = new Map();
    const legacy = [];
    rows.forEach(r => {
      const [hypothesis, userConfidence, sources, notes, createdAt, appConfidence, entryId] = r;
      if (!hypothesis && !entryId) return; // skip blank rows

      const hypObj = { hypothesis, userConfidence, sources, notes, createdAt };

      if (!entryId) { legacy.push(hypObj); return; }
      if (hypothesis === '__deleted__') { byId.delete(entryId); return; }
      byId.set(entryId, hypObj);
    });

    hypotheses = [...legacy, ...Array.from(byId.values())];
  }

  return { entries, hypotheses };
}

function buildPrompt(entries, hypotheses) {
  const entryLines = entries.map(e => {
    const parts = [e.date, e.startTime, e.category];
    if (e.item) parts.push(e.item);
    if (e.detail) parts.push('(' + e.detail + ')');
    if (e.severity) parts.push('severity ' + e.severity + '/10');
    if (e.quality) parts.push('quality ' + e.quality + '/10');
    if (e.pills && e.pills !== '{}') parts.push(e.pills);
    if (e.notes) parts.push('- ' + e.notes);
    return parts.join(' | ');
  }).join('\n');

  const ideaLines = hypotheses.map(h =>
    `- "${h.hypothesis}" (your confidence: ${h.userConfidence}/5, sources: ${h.sources}${h.notes ? ', notes: ' + h.notes : ''})`
  ).join('\n') || '(none yet)';

  return `You are a careful health-data analyst helping someone understand patterns in their personal health journal. Be evidence-based, conservative with confidence scores, and never give medical advice or diagnoses - only describe correlations you observe in the data.

LOGGED ENTRIES (most recent ${entries.length}, format: date | time | category | item | detail | notes):
${entryLines}

THE PERSON'S OWN IDEAS/HYPOTHESES:
${ideaLines}

Your task:
1. For EACH of the person's own ideas above, assess how well the logged data supports it. Assign an "confidence" score from 0-100 based on the strength of evidence (0 = data contradicts it or no relevant data, 100 = very strong consistent pattern). If you think the hypothesis could be worded more precisely based on what you see in the data, provide a refined version in "text" (otherwise just repeat their original wording). Set "type" to "refined_idea" and include their original "userConfidence" (1-5).
2. Separately, identify up to 4 NEW patterns or correlations in the data that the person has NOT already captured as an idea. For each, set "type" to "new_suggestion", write a clear one-sentence hypothesis in "text", and assign a "confidence" score (0-100) based on how strong/consistent the pattern is.
3. For every item, include a brief "evidence" string (1-2 sentences) citing specific examples from the log (dates/categories) that support your assessment.
4. If there isn't enough data to say anything meaningful yet, it's fine to return low confidence scores and note that more logging is needed in "evidence".

Respond with ONLY valid JSON, no markdown formatting, no code fences, no preamble. Use exactly this shape:
{
  "insights": [
    {
      "text": "string",
      "confidence": 0,
      "type": "refined_idea" or "new_suggestion",
      "userConfidence": number or null,
      "evidence": "string"
    }
  ]
}`;
}

async function logRun(sheetsApi, sheetId, entryCount, ideaCount, insightCount) {
  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
  const exists = (spreadsheet.data.sheets || []).some(s => s.properties.title === 'Insights_Log');

  if (!exists) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Insights_Log' } } }] },
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Insights_Log!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [['Timestamp', 'EntriesAnalyzed', 'IdeasReviewed', 'InsightsGenerated']] },
    });
  }

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Insights_Log!A:D',
    valueInputOption: 'RAW',
    requestBody: { values: [[new Date().toISOString(), entryCount, ideaCount, insightCount]] },
  });
}
