// api/oura-expanded.js
// Complete Oura Ring data fetching - uses the correct Oura v2 "usercollection"
// endpoints (the previous version used /v2/usersession, which is for
// meditation/breathing sessions, NOT sleep - that was the root cause of
// sleep data never appearing).

const OURA_TOKEN = process.env.OURA_TOKEN;
const OURA_API = 'https://api.ouraring.com/v2/usercollection';

// Vercel servers run in UTC; the person using this app is in Central Time.
// Oura's "day" field for a sleep period is the date the person woke up,
// determined by the ring itself (already in the wearer's local time), so we
// query a small window around the requested date and pick the most recent
// entry to avoid off-by-one issues from server/client timezone differences.
const TIMEZONE = process.env.APP_TIMEZONE || 'America/Chicago';

export default async function handler(req, res) {
  try {
    if (!OURA_TOKEN) {
      return res.status(500).json({ error: 'OURA_TOKEN not set in environment variables' });
    }

    const { action, date } = req.query;
    const targetDate = date || toLocalDateString(Date.now());

    if (action === 'all') {
      const [sleep, readiness, dailySleepScore, activity] = await Promise.all([
        fetchLatestSleepPeriod(targetDate),
        fetchLatest('daily_readiness', targetDate),
        fetchLatest('daily_sleep', targetDate),
        fetchLatest('daily_activity', targetDate),
      ]);

      res.status(200).json({
        date: targetDate,
        sleep: sleep ? {
          ...sleep,
          score: dailySleepScore?.score ?? null,
        } : (dailySleepScore ? { score: dailySleepScore.score, day: dailySleepScore.day } : null),
        readiness: readiness ? {
          readinessScore: readiness.score ?? null,
          restingHR: readiness.contributors?.resting_heart_rate ?? null,
          sleepBalance: readiness.contributors?.previous_night ?? null,
          activityBalance: readiness.contributors?.activity_balance ?? null,
          temperatureDeviation: readiness.temperature_deviation ?? null,
          day: readiness.day,
        } : null,
        activity: activity ? {
          score: activity.score ?? null,
          steps: activity.steps ?? null,
          activeCalories: activity.active_calories ?? null,
          day: activity.day,
        } : null,
        syncedAt: new Date().toISOString(),
      });
    } else if (action === 'sleep') {
      const sleep = await fetchLatestSleepPeriod(targetDate);
      res.status(200).json(sleep);
    } else if (action === 'readiness') {
      const readiness = await fetchLatest('daily_readiness', targetDate);
      res.status(200).json(readiness);
    } else if (action === 'raw') {
      // Debug helper: returns raw responses from each endpoint for a date range
      const start = req.query.start || targetDate;
      const end = req.query.end || targetDate;
      const [sleep, dailySleep, readiness, activity] = await Promise.all([
        ouraFetch(`/sleep?start_date=${start}&end_date=${end}`),
        ouraFetch(`/daily_sleep?start_date=${start}&end_date=${end}`),
        ouraFetch(`/daily_readiness?start_date=${start}&end_date=${end}`),
        ouraFetch(`/daily_activity?start_date=${start}&end_date=${end}`),
      ]);
      res.status(200).json({ sleep, dailySleep, readiness, activity });
    } else {
      res.status(400).json({ error: 'Invalid action. Use ?action=all, sleep, readiness, or raw' });
    }
  } catch (error) {
    console.error('Oura API error:', error);
    res.status(500).json({ error: error.message });
  }
}

function toLocalDateString(millis) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(millis));
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function ouraFetch(path) {
  const response = await fetch(`${OURA_API}${path}`, {
    headers: { 'Authorization': `Bearer ${OURA_TOKEN}` }
  });
  if (!response.ok) {
    throw new Error(`Oura API error (${path}): ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Fetch the most recent record from a daily_* endpoint within a small window
// ending at targetDate (looks back 2 days to handle timezone edge cases).
async function fetchLatest(endpoint, targetDate) {
  const start = addDays(targetDate, -2);
  const end = addDays(targetDate, 1);
  const data = await ouraFetch(`/${endpoint}?start_date=${start}&end_date=${end}`);
  const items = data.data || [];
  if (items.length === 0) return null;
  // Most recent by "day"
  return items.reduce((latest, item) => (!latest || item.day > latest.day) ? item : latest, null);
}

// Fetch the most recent sleep PERIOD (from /sleep, has duration/deep/rem/etc.)
async function fetchLatestSleepPeriod(targetDate) {
  const start = addDays(targetDate, -2);
  const end = addDays(targetDate, 1);
  const data = await ouraFetch(`/sleep?start_date=${start}&end_date=${end}`);
  const items = (data.data || []).filter(i => i.type === 'long_sleep' || i.type === 'sleep' || !i.type);
  const list = items.length ? items : (data.data || []);
  if (list.length === 0) return null;

  const latest = list.reduce((best, item) => {
    if (!best) return item;
    return (item.bedtime_end || '') > (best.bedtime_end || '') ? item : best;
  }, null);

  if (!latest) return null;

  const totalSeconds = latest.total_sleep_duration || 0;
  return {
    day: latest.day,
    hours: Math.round((totalSeconds / 3600) * 10) / 10,
    efficiency: latest.efficiency ? latest.efficiency / 100 : null,
    deepSleepMinutes: latest.deep_sleep_duration ? Math.round(latest.deep_sleep_duration / 60) : null,
    remSleepMinutes: latest.rem_sleep_duration ? Math.round(latest.rem_sleep_duration / 60) : null,
    lightSleepMinutes: latest.light_sleep_duration ? Math.round(latest.light_sleep_duration / 60) : null,
    lowestHeartRate: latest.lowest_heart_rate ?? null,
    averageHeartRate: latest.average_heart_rate ?? null,
    latencyMinutes: latest.latency ? Math.round(latest.latency / 60) : null,
  };
}
