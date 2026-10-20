// /api/backfill?secret=XXX&station=ALL&preset=nem
// /api/backfill?secret=XXX&station=IPONDI5&from=2026-01-01&to=2026-10-19
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
        if (p != null) dayResults[dayStr] = +p.toFixed(2);
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
  return { station, daysChecked: days.length, daysRecorded: Object.keys(dayResults).length, totalRain: +totalRain.toFixed(2) };
}

module.exports = async (req, res) => {
  const { station = 'ALL', preset, secret, mode = 'daily' } = req.query;
  if (!process.env.BACKFILL_SECRET || secret !== process.env.BACKFILL_SECRET) {
    return res.status(401).json({ error: 'bad secret' });
  }

  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  let from = req.query.from;
  let to = req.query.to || yesterday;

  if (preset === 'nem') {
    from = from || '2026-10-01';
  } else if (preset === 'yearly') {
    from = from || '2026-01-01';
  } else if (!from) {
    from = '2026-10-01';
  }

  const wuStations = L.STATIONS.filter(s => !s.amb).map(s => s.id);
  let targetStations = [];
  if (station === 'ALL') {
    targetStations = wuStations;
  } else {
    targetStations = station.split(',').map(s => s.trim()).filter(s => wuStations.includes(s));
  }

  if (targetStations.length === 0) {
    return res.status(400).json({ error: 'no valid WU stations specified', available: wuStations });
  }

  const results = [];
  for (const st of targetStations) {
    try {
      const r = await backfillStationDaily(st, from, to);
      results.push(r);
    } catch (e) {
      results.push({ station: st, error: e.message });
    }
  }

  res.json({ from, to, preset: preset || null, stations: results });
};
