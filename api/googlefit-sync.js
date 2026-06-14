// api/googlefit-sync.js
// Fetch Amazfit data from Google Fit and sync to Google Sheet

import { google } from 'googleapis';

export default async function handler(req, res) {
  try {
    const { action } = req.query;

    if (action === 'sync') {
      // Full sync - fetch data and write to Sheet
      const result = await syncGoogleFitToSheet();
      res.status(200).json(result);
    } else if (action === 'test') {
      // Test - just fetch and return data
      const data = await fetchGoogleFitData();
      res.status(200).json(data);
    } else {
      res.status(400).json({ error: 'Invalid action. Use ?action=sync or ?action=test' });
    }

  } catch (error) {
    console.error('Google Fit sync error:', error);
    res.status(500).json({
      error: 'Sync failed',
      details: error.message
    });
  }
}

async function fetchGoogleFitData() {
  const accessToken = process.env.GOOGLE_FIT_ACCESS_TOKEN;
  
  if (!accessToken) {
    throw new Error('GOOGLE_FIT_ACCESS_TOKEN not set. Complete OAuth flow first.');
  }

  // Get today's date range (in milliseconds)
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const startTimeMillis = startOfDay.getTime();
  const endTimeMillis = endOfDay.getTime();

  try {
    // Fetch weight data from Google Fit
    const weightResponse = await fetch(
      'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          aggregateBy: [{
            dataTypeName: 'com.google.weight'
          }],
          bucketByTime: { durationMillis: 86400000 }, // 1 day
          startTimeMillis,
          endTimeMillis
        })
      }
    );

    if (!weightResponse.ok) {
      throw new Error(`Google Fit API error: ${weightResponse.statusText}`);
    }

    const weightData = await weightResponse.json();
    
    // Parse weight data
    let weight = null;
    if (weightData.bucket && weightData.bucket.length > 0) {
      const points = weightData.bucket[0].dataset[0].point;
      if (points && points.length > 0) {
        weight = points[points.length - 1].value[0].fpVal; // kg
      }
    }

    // Fetch body composition (if available in Google Fit)
    // Note: Google Fit may not have full body composition data
    // We'll fetch what's available
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
          bucketByTime: { durationMillis: 86400000 },
          startTimeMillis,
          endTimeMillis
        })
      }
    );

    let bodyFat = null;
    let muscleMass = null;
    let boneMass = null;

    if (bodyResponse.ok) {
      const bodyData = await bodyResponse.json();
      if (bodyData.bucket && bodyData.bucket.length > 0) {
        const bucket = bodyData.bucket[0];
        if (bucket.dataset[0].point.length > 0) {
          bodyFat = bucket.dataset[0].point[bucket.dataset[0].point.length - 1].value[0].fpVal;
        }
        if (bucket.dataset[1] && bucket.dataset[1].point.length > 0) {
          muscleMass = bucket.dataset[1].point[bucket.dataset[1].point.length - 1].value[0].fpVal;
        }
        if (bucket.dataset[2] && bucket.dataset[2].point.length > 0) {
          boneMass = bucket.dataset[2].point[bucket.dataset[2].point.length - 1].value[0].fpVal;
        }
      }
    }

    return {
      date: now.toISOString().split('T')[0],
      weight_kg: weight ? Math.round(weight * 100) / 100 : null,
      bodyfat_percent: bodyFat ? Math.round(bodyFat * 100) / 100 : null,
      muscle_mass_kg: muscleMass ? Math.round(muscleMass * 100) / 100 : null,
      bone_mass_kg: boneMass ? Math.round(boneMass * 100) / 100 : null,
      syncedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('Google Fit fetch error:', error);
    throw error;
  }
}

async function syncGoogleFitToSheet() {
  try {
    const data = await fetchGoogleFitData();
    
    // Append to Google Sheet
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    if (!sheetId) {
      throw new Error('GOOGLE_SHEET_ID not set in environment variables');
    }
    if (!rawKey) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set in environment variables');
    }

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

    // Check if BodyMetrics tab exists
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
    let bodyMetricsSheetId = null;

    for (const sheet of spreadsheet.data.sheets) {
      if (sheet.properties.title === 'BodyMetrics') {
        bodyMetricsSheetId = sheet.properties.sheetId;
        break;
      }
    }

    if (bodyMetricsSheetId === null) {
      // Create BodyMetrics sheet if it doesn't exist
      const createResponse = await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: 'BodyMetrics',
                gridProperties: { rowCount: 1000, columnCount: 10 }
              }
            }
          }]
        }
      });
      bodyMetricsSheetId = createResponse.data.replies[0].addSheet.properties.sheetId;

      // Add headers
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'BodyMetrics!A1:H1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [[
            'Date',
            'Weight(kg)',
            'BodyFat%',
            'BoneMass(kg)',
            'Water%',
            'Muscle%',
            'BMR',
            'SyncedAt'
          ]]
        }
      });
    }

    // Append data
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
          null, // water% not available via public Google Fit API
          data.muscle_mass_kg,
          null, // BMR not available
          new Date().toISOString()
        ]]
      }
    });

    return {
      success: true,
      message: 'Data synced to BodyMetrics sheet',
      data: data
    };

  } catch (error) {
    console.error('Sheet sync error:', error);
    throw error;
  }
}
