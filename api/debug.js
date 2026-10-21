const L = require('./_lib');

module.exports = async (req, res) => {
  if (req.query.secret !== 'rain2026xyz') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { station, action } = req.query;

  if (action === 'del' && station) {
    await L.redis([['DEL', 'rain:' + station]]);
    return res.json({ deleted: station });
  }

  if (action === 'delall') {
    const cmds = L.STATIONS.map(s => ['DEL', 'rain:' + s.id]);
    await L.redis(cmds);
    return res.json({ deletedAll: true });
  }

  if (action === 'load') {
    const hist = require('./historical-2026.json');
    const logs = {};
    for (const [st, info] of Object.entries(hist)) {
      const cmds = [['DEL', 'rain:' + st]];
      for (const [day, val] of Object.entries(info.daysWithRain)) {
        if (val > 0) cmds.push(['HSET', 'rain:' + st, day, val.toFixed(2)]);
      }
      await L.redis(cmds);
      logs[st] = { loadedDays: cmds.length - 1, totalRain: info.yearTotal };
    }
    return res.json({ loaded: logs });
  }

  const results = {};
  for (const s of L.STATIONS) {
    try {
      const raw = (await L.redis([['HGETALL', 'rain:' + s.id]]))[0] || {};
      const h = {};
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i += 2) h[raw[i]] = +raw[i + 1];
      } else {
        for (const [k, v] of Object.entries(raw)) h[k] = +v;
      }
      results[s.id] = h;
    } catch (e) {
      results[s.id] = { error: e.message };
    }
  }

  res.json({ results });
};
