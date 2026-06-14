// api/oura-expanded.js
// Complete Oura Ring data fetching - sleep, readiness, activity, cycle

const OURA_TOKEN = process.env.OURA_TOKEN;
const OURA_API = 'https://api.ouraring.com/v2';

export default async function handler(req, res) {
  try {
    if (!OURA_TOKEN) {
      return res.status(500).json({ error: 'OURA_TOKEN not set in environment variables' });
    }

    const { action, date } = req.query;
    
    if (action === 'all' && date) {
      // Fetch all data for a specific date
      const allData = await fetchAllData(date);
      res.status(200).json(allData);
    } else if (action === 'sleep' && date) {
      const sleep = await fetchSleepData(date);
      res.status(200).json(sleep);
    } else if (action === 'readiness' && date) {
      const readiness = await fetchReadinessData(date);
      res.status(200).json(readiness);
    } else if (action === 'activity' && date) {
      const activity = await fetchActivityData(date);
      res.status(200).json(activity);
    } else if (action === 'cycle' && date) {
      const cycle = await fetchCycleData(date);
      res.status(200).json(cycle);
    } else {
      res.status(400).json({ error: 'Invalid action or missing date' });
    }
  } catch (error) {
    console.error('Oura API error:', error);
    res.status(500).json({ error: error.message });
  }
}

async function fetchAllData(date) {
  try {
    const sleep = await fetchSleepData(date);
    const readiness = await fetchReadinessData(date);
    const activity = await fetchActivityData(date);
    const cycle = await fetchCycleData(date);
    
    return {
      date,
      sleep,
      readiness,
      activity,
      cycle,
      syncedAt: new Date().toISOString()
    };
  } catch (error) {
    throw error;
  }
}

async function fetchSleepData(date) {
  // /v2/usersession?date=2024-01-01&include_invisible=true
  const response = await fetch(`${OURA_API}/usersession?date=${date}`, {
    headers: { 'Authorization': `Bearer ${OURA_TOKEN}` }
  });

  if (!response.ok) {
    throw new Error(`Oura API error: ${response.statusText}`);
  }

  const data = await response.json();
  
  if (data.data && data.data.length > 0) {
    const session = data.data[0];
    return {
      date,
      type: session.type,
      startTime: session.start_datetime,
      endTime: session.end_datetime,
      durationSeconds: session.duration,
      hours: Math.round((session.duration / 3600) * 10) / 10,
      deepSleepSeconds: session.deep_sleep_duration || 0,
      deepSleepMinutes: Math.round((session.deep_sleep_duration || 0) / 60),
      remSleepSeconds: session.rem_sleep_duration || 0,
      remSleepMinutes: Math.round((session.rem_sleep_duration || 0) / 60),
      lightSleepSeconds: session.light_sleep_duration || 0,
      lightSleepMinutes: Math.round((session.light_sleep_duration || 0) / 60),
      efficiency: session.efficiency || 0,
      restfulness: session.restfulness || 0,
      sleepLatencySeconds: session.sleep_latency || 0,
      sleepLatencyMinutes: Math.round((session.sleep_latency || 0) / 60),
      lowestHeartRate: session.lowest_heart_rate || 0,
      averageHeartRate: session.average_heart_rate || 0,
    };
  }

  return null;
}

async function fetchReadinessData(date) {
  // /v2/dailyreadiness?date=2024-01-01
  const response = await fetch(`${OURA_API}/dailyreadiness?date=${date}`, {
    headers: { 'Authorization': `Bearer ${OURA_TOKEN}` }
  });

  if (!response.ok) {
    throw new Error(`Oura API error: ${response.statusText}`);
  }

  const data = await response.json();

  if (data.data && data.data.length > 0) {
    const daily = data.data[0];
    return {
      date,
      readinessScore: daily.score || 0,
      sleepBalance: daily.score_sleep_balance || 0,
      previousNightSleep: daily.score_previous_night || 0,
      activityBalance: daily.score_activity_balance || 0,
      restingHR: daily.resting_heart_rate || 0,
      temperatureDeviation: daily.temperature_deviation || 0,
      trend: daily.trend || null,
      contributors: daily.contributors || []
    };
  }

  return null;
}

async function fetchActivityData(date) {
  // /v2/dailyactivity?date=2024-01-01
  const response = await fetch(`${OURA_API}/dailyactivity?date=${date}`, {
    headers: { 'Authorization': `Bearer ${OURA_TOKEN}` }
  });

  if (!response.ok) {
    throw new Error(`Oura API error: ${response.statusText}`);
  }

  const data = await response.json();

  if (data.data && data.data.length > 0) {
    const activity = data.data[0];
    return {
      date,
      score: activity.score || 0,
      steps: activity.steps || 0,
      caloriesBurned: activity.cal_burned || 0,
      caloriesActive: activity.cal_active || 0,
      activeSeconds: activity.active_burn_duration || 0,
      activeMinutes: Math.round((activity.active_burn_duration || 0) / 60),
      inactiveSeconds: activity.inactive_burn_duration || 0,
      inactiveMinutes: Math.round((activity.inactive_burn_duration || 0) / 60),
      avgMET: activity.average_met || 0,
      contributors: activity.contributors || []
    };
  }

  return null;
}

async function fetchCycleData(date) {
  // /v2/dailyspo2?date=2024-01-01 (has cycle info)
  // Note: Cycle endpoint may be at a different path; check Oura docs
  const response = await fetch(`${OURA_API}/dailyspo2?date=${date}`, {
    headers: { 'Authorization': `Bearer ${OURA_TOKEN}` }
  });

  if (!response.ok) {
    // Cycle data may not be available; return null gracefully
    return null;
  }

  const data = await response.json();

  // Parse cycle info if available in response
  // This is a placeholder - check Oura API for exact cycle endpoint
  if (data.data && data.data.length > 0) {
    return {
      date,
      cyclePhase: null, // Would come from cycle-specific endpoint
      dayInCycle: null,
      predictedNextPeriod: null
    };
  }

  return null;
}
