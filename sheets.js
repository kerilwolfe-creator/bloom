import { google } from 'googleapis';

// Service account credentials from environment
const serviceAccount = {
  type: 'service_account',
  project_id: 'bloom-499314',
  private_key_id: '9f8ba1424f93f129352d6061c37e3f2a84719cde',
  private_key: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0b37vdCOmYyBQ
41u+kSlF3xc3YEQcNOsHbzuUG6wMez00Cjvf3XJPEjOJZe5DRMVFVXs1Jjco1NxM
WyGxeRHJTct6IC7syhED6ejT7yegt31RZpVTlmWm5iZb/IoiJASi0+QxtwTeJu6H
K8jRk+tsXEzj52hIy/q2ZZ/Ll6ct/VfMfZHj1hM/23P9r12WC8PRVsb1ZsGUGQR+
+GVDft5QybxXuetMabwJfDIrD3dNUU5kisb+lBRUCA2MsR7QxXIG8W9cXrJ8fC5J
k5V9rhlwRYyqo0GCBqgGeg89KjVSONPqfRk+9jxZIAtLQMBHMoi07DnoyrW0VgVJ
+hPMl/wlAgMBAAECggEAIsPhyfrPXKF4SkWIOYdIE8OYek20ydeDWlca/F45j90V
7Yc0Qp2tBuGrpuNKHVFsjf+aoeK3WYlr2dVsQEDixa3U0PbO+8YyMZYZy23mrX91
KKAykNynQNlS1kHqDopwjzvy2YZZLIGFT2uHAaR1xZbiJL5DOFV+/LJHb+eMKV62
NKWGbGTdDICFR+EAhZicevAtybZc8L8GBuq5QxRPgRmxAi6N6cx3JCf+bKRVvLi/
RKiFWYEyFDhZ5G/Dy9+ePYCxiuxkdZ2H1RLhyzi0uqJCWNGNSyPqM06YyQtGls+t
Lb4F9yJea3disbOjplT+1FrV4eAQ6eEKXSr7PcFnSQKBgQDeGT8LkQTGroyACQgC
pMG8IfFE8dJ3pSgcZHBd9k5cQlaBjgQKtJNrGEgckhZ90NjnATONYqeY2iUatu1O
GO39EIjZ/1I3MDbPy+JkbgCiCrOcxtjhP88YPfkETFFG9CpxgUztvuK/qN8ggR6P
vyvee6ZLvhCkFwIIPko8T0ZDDQKBgQDP+jetBbyOJoFu/49t6BEqglcanFFOhzeG
NWi6PY1PDg5OLVlTitwE9EhFKrWRNnnah2WEjMstGE+ffUrwdW/oNzBrZ6SeAZaX
YbcdPd78VtOJrcYGaYiSu8078w0IF8W2vuaiIM8G7CK5+qWJAtScdgJzKuzwiMGg
2N/Lt0S3eQKBgQCxB5KXF5qk+1CGZax63vSFjtCPUeme8IgOSYi/fKptI3tsfNR/
6/tta8de7pr64lNhnjWHRtGsJoVYy+JPU9Ou2VUb3kWcM9QcwbjMsFnUz47nMiCB
OqlJ+2vXnzVRxyFlo9i70GFQv7xKXmEL1yeSiSC+UttUz/oQtAXcGJw6qQKBgDdM
DxuY595fzJBHsMoHJvFHgINZxqB7gT7U2oiSLw0y7ojIs/Rrej5y+Pgy992pP1Lk
JxDMIoVV7m24cYFnqB509hHIl9NPFswfNgG3Xp93Mn1rz7gKvT5OYq4q3G8navFA
5q96y7DKfh020GaScxc6pUIbyq3Vnq32m+JdUw75AoGASbhWRRUofATrg0qeQCKX
gkJp+lXPpIfbkIN6hu0kQCSxHnkC7UH0TJ5kEYzD29CxEB1lgpc0D+aGtR64+tta
XrxxHE9lNmJkmzlu9+ZJlaDQtseT8TTJkVunIM/3oXolyWRBLx5PexvnA8+OMaMj
2eic3d1MYNDP4ZJVjKqauHg=
-----END PRIVATE KEY-----`,
  client_email: 'claude-agent@bloom-499314.iam.gserviceaccount.com',
  client_id: '107483170536403498113',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/claude-agent%40bloom-499314.iam.gserviceaccount.com'
};

const SHEETS_API = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  }),
});

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { action, entries, hypotheses, sheetId } = req.body;

      if (action === 'appendEntries' && entries) {
        await appendEntries(sheetId, entries);
        res.status(200).json({ success: true, message: 'Entries synced' });
      } else if (action === 'appendHypotheses' && hypotheses) {
        await appendHypotheses(sheetId, hypotheses);
        res.status(200).json({ success: true, message: 'Hypotheses synced' });
      } else {
        res.status(400).json({ error: 'Invalid action' });
      }
    } catch (error) {
      console.error('API error:', error);
      res.status(500).json({ error: error.message });
    }
  } else if (req.method === 'GET') {
    try {
      const { action, sheetId } = req.query;

      if (action === 'getLastSync') {
        const lastSync = await getLastSyncTime(sheetId);
        res.status(200).json({ lastSync });
      } else {
        res.status(400).json({ error: 'Invalid action' });
      }
    } catch (error) {
      console.error('API error:', error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}

async function appendEntries(sheetId, entries) {
  // Get or create sheet tabs
  const sheet = await SHEETS_API.spreadsheets.get({
    spreadsheetId: sheetId,
  });

  // Ensure Entries sheet exists
  let entriesSheetId = sheet.data.sheets?.find(s => s.properties.title === 'Entries')?.properties.sheetId;
  
  if (!entriesSheetId) {
    const addSheet = await SHEETS_API.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: 'Entries' },
          },
        }],
      },
    });
    entriesSheetId = addSheet.data.replies[0].addSheet.properties.sheetId;
  }

  // Prepare rows
  const rows = entries.map(e => [
    e.date,
    e.startTime,
    e.endTime || '',
    e.category,
    e.item || '',
    e.dose || e.ounces || e.servings || '',
    JSON.stringify(e.selectedPills || {}),
    e.severity || '',
    e.hours || '',
    e.quality || '',
    e.notes,
    e.createdAt,
  ]);

  // Append to sheet
  await SHEETS_API.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Entries!A:L',
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows },
  });
}

async function appendHypotheses(sheetId, hypotheses) {
  // Ensure Hypotheses sheet exists
  const sheet = await SHEETS_API.spreadsheets.get({
    spreadsheetId: sheetId,
  });

  let hypothesesSheetId = sheet.data.sheets?.find(s => s.properties.title === 'Hypotheses')?.properties.sheetId;
  
  if (!hypothesesSheetId) {
    const addSheet = await SHEETS_API.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: 'Hypotheses' },
          },
        }],
      },
    });
    hypothesesSheetId = addSheet.data.replies[0].addSheet.properties.sheetId;
  }

  // Prepare rows
  const rows = hypotheses.map(h => [
    h.hypothesis,
    h.userConfidence,
    h.source,
    h.notes,
    h.createdAt,
    h.appConfidence || '',
  ]);

  // Append to sheet
  await SHEETS_API.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Hypotheses!A:F',
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows },
  });
}

async function getLastSyncTime(sheetId) {
  try {
    const response = await SHEETS_API.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Entries!A1',
    });
    return response.data.updatedTime;
  } catch {
    return null;
  }
}
