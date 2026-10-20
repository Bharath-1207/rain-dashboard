// /api/backfill?station=IPONDI5&from=2026-10-01&to=2026-10-20&secret=XXX  (max ~31 days per call)
const L = require('./_lib');
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = async (req, res) => {
  const { station, from, to, secret } = req.query;
  if (!process.env.BACKFILL_SECRET || secret !== process.env.BACKFILL_SECRET) return res.status(401).json({ error: 'bad secret' });
  if (!L.STATIONS.find(s => s.id === station && !s.amb)) return res.status(400).json({ error: 'unknown WU station' });
  const days = [];
  for (let d = Date.parse(from) - 86400000; d <= Date.parse(to); d += 86400000) days.push(new Date(d).toISOString().slice(0, 10).replace(/-/g, ''));
  let all = [];
  for (let i = 0; i < days.length; i += 5) {
    const rs = await Promise.all(days.slice(i, i + 5).map(d => L.wu('history/hourly', station, '&date=' + d).catch(() => [])));
    rs.forEach(r => all.push(...L.toPts(r)));
    await sleep(1500); // WU limit: 30 calls/min
  }
  all.sort((a, b) => a.t - b.t);
  const d = L.toDays(L.incs(all));
  await L.writeDays(station, d, all[0]?.t ?? Infinity, from, to);
  res.json({ station, from, to, readings: all.length, days: Object.keys(d).length });
};
