// /api/backfill?secret=XXX&station=ALL&from=2026-01-01&to=2026-10-20
// Uses history/daily which gives calendar-day (midnight-to-midnight) totals.
// We store these under the RAIN-DAY key (8:30am-to-8:30am window label).
// Since most rain falls within a single calendar day, calendar-day ≈ rain-day for backfill.
const L = require('./_lib');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function backfillStationDaily(station, fromStr, toStr) {
  const days = [];
  for (let d = Date.parse(fromStr); d <= Date.parse(toStr); d += 86400000) {
    days.push(new Date(d).toISOString().slice(0, 10));
  }
  const dayResults = {};
  const batchSize = 10;
  for (let i = 0; i < days.length; i += batchSize) {
    const chunk = days.slice(i, i + batchSize);
    await Promise.all(chunk.map(async dayStr => {
      const dCode = dayStr.replace(/-/g, '');
      try {
        const obs = await L.wu('history/daily', station, '&date=' + dCode);
        const p = obs[0]?.metric?.precipTotal;
        // Store under the rain-day key that contains this calendar day.
        // calendar day = midnight IST to midnight IST.
        // rain-day window = 8:30 IST prev day to 8:30 IST this day, labelled by THIS day.
        // For backfill, calendar day is a good proxy — store under the same date key.
        if (p != null && p > 0) dayResults[dayStr] = +p.toFixed(2);
      } catch (e) {}
    }));
    if (i + batchSize < days.length) await sleep(250);
  }

  const cmds = [];
  let totalRain = 0;
  for (const [k, v] of Object.entries(dayResults)) {
    cmds.push(['HSET', 'rain:' + station, k, v.toFixed(2)]);
    totalRain += v;
  }
  if (cmds.length) await L.redis(cmds);
  return { station, daysChecked: days.length, daysWithRain: Object.keys(dayResults).length, totalRain: +totalRain.toFixed(2) };
}

module.exports = async (req, res) => {
  const { station = 'ALL', secret } = req.query;
  if (!process.env.BACKFILL_SECRET || secret !== process.env.BACKFILL_SECRET) {
    return res.status(401).json({ error: 'bad secret' });
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const from = req.query.from || '2026-01-01';
  const to = req.query.to || yesterday;

  const wuStations = L.STATIONS.filter(s => !s.amb).map(s => s.id);
  let targets = station === 'ALL' ? wuStations : station.split(',').map(s => s.trim()).filter(s => wuStations.includes(s));

  if (targets.length === 0) {
    return res.status(400).json({ error: 'no valid WU stations', available: wuStations });
  }

  const results = [];
  for (const st of targets) {
    try {
      results.push(await backfillStationDaily(st, from, to));
    } catch (e) {
      results.push({ station: st, error: e.message });
    }
  }

  res.json({ from, to, stations: results });
};
