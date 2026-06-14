// api/googlefit-sync.js
// Fetch Amazfit data from Google Fit and sync to Google Sheet

import { google } from 'googleapis';

// Vercel servers run in UTC. You're in Central Time, so "today" on the
// server can already be tomorrow for you (e.g. a 9pm Central weigh-in is
// 2-3am UTC the next day). All date labels below are computed in this
// timezone instead of server-local/UTC so dates match what you expect.
const TIMEZONE = process.env.APP_TIMEZONE || 'America/Chicago';

export default async function handler(req, res) {
  try {
    const { action, days } = req.query;

    if (action === 'sync') {
      const result = await syncGoogleFitToSheet(parseInt(days) || 3);
      res.status(200).json(result);
    } else if (action === 'test') {
      const lookbackDays = days ? parseInt(days) : 30;
      const data = await fetchGoogleFitData(lookbackDays);
      res.status(200).json(data);
    } else if (action === 'sources') {
      const sources = await listDataSources();
      res.status(200).json(sources);
    } else {
      res.status(400).json({ error: 'Invalid action. Use ?action=sync, ?action=test, or ?action=sources' });
    }

  } catch (error) {
    console.error('Google Fit sync error:', error);
    res.status(500).json({
      error: 'Sync failed',
      details: error.message
    });
  }
}

// Format a millisecond timestamp as YYYY-MM-DD in TIMEZONE (not UTC, not server-local)
function toLocalDateString(millis) {
  // en-CA locale formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(millis));
}

async function getValidAccessToken() {
  const accessToken = process.env.GOOGLE_FIT_ACCESS_TOKEN;
  const refreshToken = process.env.GOOGLE_FIT_REFRESH_TOKEN;

  if (!accessToken) {
    throw new Error('GOOGLE_FIT_ACCESS_TOKEN not set. Complete OAuth flow first via /api/googlefit-auth');
  }

  const testResponse = await fetch(
    'https://www.googleapis.com/fitness/v1/users/me/dataSources',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (testResponse.ok) {
    return accessToken;
  }

  if (testResponse.status === 401 && refreshToken) {
    const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_FIT_CLIENT_SECRET;

    const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      })
    });

    if (refreshResponse.ok) {
      const refreshData = await refreshResponse.json();
      console.log('Refreshed access token (not persisted - update GOOGLE_FIT_ACCESS_TOKEN manually if syncs keep failing)');
      return refreshData.access_token;
    } else {
      const errText = await refreshResponse.text();
      throw new Error(`Access token expired and refresh failed: ${errText}`);
    }
  }

  const errText = await testResponse.text();
  throw new Error(`Google Fit auth failed (${testResponse.status}): ${errText}`);
}

async function listDataSources() {
  const accessToken = await getValidAccessToken();

  const response = await fetch(
    'https://www.googleapis.com/fitness/v1/users/me/dataSources',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Failed to list data sources: ${response.statusText}`);
  }

  const data = await response.json();

  const simplified = (data.dataSource || []).map(ds => ({
    dataStreamId: ds.dataStreamId,
    dataType: ds.dataType?.name,
    application: ds.application?.packageName || ds.application?.name,
    device: ds.device ? `${ds.device.manufacturer || ''} ${ds.device.model || ''}`.trim() : null
  }));

  return {
    count: simplified.length,
    sources: simplified
  };
}

// Fetches all weight/body points in the lookback window as ONE bucket
// (not day-buckets), then picks the single most recent point overall.
// This avoids UTC-day-bucket boundaries splitting a Central-time day
// across two buckets or mislabeling its date.
async function fetchGoogleFitData(lookbackDays = 1) {
  const accessToken = await getValidAccessToken();

  const endTimeMillis = Date.now();
  const startTimeMillis = endTimeMillis - lookbackDays * 86400000;
  // One bucket covering the whole range
  const bucketDuration = endTimeMillis - startTimeMillis;

  const weightResponse = await fetch(
    'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        aggregateBy: [{ dataTypeName: 'com.google.weight' }],
        bucketByTime: { durationMillis: bucketDuration },
        startTimeMillis,
        endTimeMillis
      })
    }
  );

  if (!weightResponse.ok) {
    throw new Error(`Google Fit API error (weight): ${weightResponse.status} ${weightResponse.statusText}`);
  }

  const weightData = await weightResponse.json();
  const weightPoints = weightData.bucket?.[0]?.dataset?.[0]?.point || [];

  if (weightPoints.length === 0) {
    return {
      found: false,
      message: `No weight data found in Google Fit for the last ${lookbackDays} day(s).`,
      searchedRange: {
        from: toLocalDateString(startTimeMillis),
        to: toLocalDateString(endTimeMillis)
      },
      hint: 'Try ?action=sources to see what data Google Fit actually has, or increase ?days='
    };
  }

  // Most recent point by end time
  const latestPoint = weightPoints.reduce((latest, p) => {
    const pEnd = parseInt(p.endTimeNanos || p.startTimeNanos);
    const lEnd = latest ? parseInt(latest.endTimeNanos || latest.startTimeNanos) : -1;
    return pEnd > lEnd ? p : latest;
  }, null);

  const latestMillis = Math.floor(parseInt(latestPoint.endTimeNanos || latestPoint.startTimeNanos) / 1e6);
  const date = toLocalDateString(latestMillis);
  const weightKg = latestPoint.value?.[0]?.fpVal ?? null;

  // Fetch body composition over the same range, find the point closest to latestMillis
  const bodyResponse = await fetch(
    'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        aggregateBy: [
          { dataTypeName: 'com.google.body.fat.percentage' },
          { dataTypeName: 'com.google.body.muscle.mass' },
          { dataTypeName: 'com.google.body.bone.mass' }
        ],
        bucketByTime: { durationMillis: bucketDuration },
        startTimeMillis,
        endTimeMillis
      })
    }
  );

  let bodyFat = null, muscleMass = null, boneMass = null;
  if (bodyResponse.ok) {
    const bodyData = await bodyResponse.json();
    const bucket = bodyData.bucket?.[0];

    const closestPoint = (points) => {
      if (!points || points.length === 0) return null;
      return points.reduce((closest, p) => {
        const pEnd = parseInt(p.endTimeNanos || p.startTimeNanos);
        const cEnd = closest ? parseInt(closest.endTimeNanos || closest.startTimeNanos) : -Infinity;
        const target = latestMillis * 1e6;
        return Math.abs(pEnd - target) < Math.abs(cEnd - target) ? p : closest;
      }, null);
    };

    const fatPoint = closestPoint(bucket?.dataset?.[0]?.point);
    const musclePoint = closestPoint(bucket?.dataset?.[1]?.point);
    const bonePoint = closestPoint(bucket?.dataset?.[2]?.point);

    if (fatPoint) bodyFat = fatPoint.value?.[0]?.fpVal ?? null;
    if (musclePoint) muscleMass = musclePoint.value?.[0]?.fpVal ?? null;
    if (bonePoint) boneMass = bonePoint.value?.[0]?.fpVal ?? null;
  }

  return {
    found: true,
    date,
    weight_kg: weightKg !== null ? Math.round(weightKg * 100) / 100 : null,
    bodyfat_percent: bodyFat !== null ? Math.round(bodyFat * 100) / 100 : null,
    muscle_mass_kg: muscleMass !== null ? Math.round(muscleMass * 100) / 100 : null,
    bone_mass_kg: boneMass !== null ? Math.round(boneMass * 100) / 100 : null,
    timezone: TIMEZONE,
    syncedAt: new Date().toISOString()
  };
}

async function syncGoogleFitToSheet(lookbackDays = 3) {
  const data = await fetchGoogleFitData(lookbackDays);

  if (!data.found) {
    return { success: false, message: data.message, hint: data.hint };
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!sheetId) throw new Error('GOOGLE_SHEET_ID not set in environment variables');
  if (!rawKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set in environment variables');

  let serviceAccountKey;
  try {
    serviceAccountKey = JSON.parse(rawKey);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ' + e.message);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheetsApi = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
  const bodyMetricsExists = spreadsheet.data.sheets?.some(
    s => s.properties.title === 'BodyMetrics'
  );

  if (!bodyMetricsExists) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: 'BodyMetrics', gridProperties: { rowCount: 1000, columnCount: 10 } }
          }
        }]
      }
    });

    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'BodyMetrics!A1:H1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [['Date', 'Weight(kg)', 'BodyFat%', 'BoneMass(kg)', 'Water%', 'Muscle%', 'BMR', 'SyncedAt']]
      }
    });
  }

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'BodyMetrics!A:H',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        data.date,
        data.weight_kg,
        data.bodyfat_percent,
        data.bone_mass_kg,
        null,
        data.muscle_mass_kg,
        null,
        new Date().toISOString()
      ]]
    }
  });

  return { success: true, message: 'Data synced to BodyMetrics sheet', data };
}
