import { normalizeCfg, runDays, initialState } from "./engine.js";

/* ---------- バックテスト ---------- */
// opts.from（YYYY-MM-DD）より前のデータは、シグナル計算の助走にだけ使う。opts.to までで止める
export function backtest(cfgIn, data, opts = {}) {
  const cfg = normalizeCfg(cfgIn);
  const start = () => {
    const st = initialState(cfg.initialCash);
    if (opts.from) { const d = new Date(opts.from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); st.lastDate = d.toISOString().slice(0, 10); }
    return st;
  };
  const o = { applyHalts: false, toDate: opts.to || null };
  const main = runDays(cfg, start(), data, o);
  const bench = runDays({ ...cfg, strategy: "hold", params: {}, side: "long", slPct: 0, tpPct: 0, maxTradesPerDay: 100, trendMa: 0, sizeMode: "pct", regime: { mode: "off" } }, start(), data, o);
  return { cfg, ...main, bearPct: main.equity.length ? main.bearDays / main.equity.length * 100 : 0, metrics: metrics(main.equity, main.trades, cfg.initialCash), bench: { equity: bench.equity, metrics: metrics(bench.equity, bench.trades, cfg.initialCash) } };
}

export function metrics(equity, trades, initial) {
  if (!equity.length) return null;
  const final = equity[equity.length - 1].equity;
  const days = (Date.parse(equity[equity.length - 1].d) - Date.parse(equity[0].d)) / 864e5;
  const years = Math.max(days / 365.25, 1 / 365.25);
  let peak = -Infinity, maxDD = 0;
  const rets = [];
  for (let i = 0; i < equity.length; i++) {
    const e = equity[i].equity;
    peak = Math.max(peak, e);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - e) / peak);
    if (i > 0 && equity[i - 1].equity > 0) rets.push(e / equity[i - 1].equity - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sells = trades.filter(t => t.pnl != null); // 手じまいした取引（売り、または空売りの買い戻し）
  const wins = sells.filter(t => t.pnl > 0).length;
  return {
    final,
    totalPct: (final / initial - 1) * 100,
    cagrPct: final > 0 ? (Math.pow(final / initial, 1 / years) - 1) * 100 : -100,
    maxDDPct: maxDD * 100,
    sharpe: sd > 0 ? mean / sd * Math.sqrt(252) : 0,
    trades: trades.length,
    roundTrips: sells.length,
    winPct: sells.length ? wins / sells.length * 100 : null,
    fees: trades.reduce((a, t) => a + (t.fee || 0), 0),
  };
}

/* ---------- パラメータの総当たり ---------- */
// 戦略ごとの候補。前半（学習期間）で成績を出し、後半（確認期間）でも通用するかを見る
export const GRIDS = {
  sma: { short: [3, 5, 10, 15, 20, 25], long: [20, 25, 50, 75, 100, 150, 200] },
  rsi: { period: [7, 10, 14, 21], buy: [20, 25, 30, 35], sell: [60, 65, 70, 75, 80] },
  breakout: { entry: [10, 20, 40, 55, 100], exit: [5, 10, 20, 40] },
  boll: { period: [10, 15, 20, 30, 50], k: [1.5, 2, 2.5, 3] },
  macd: { fast: [5, 8, 12, 16], slow: [20, 26, 35, 50], signal: [5, 9, 12] },
  roc: { period: [20, 40, 60, 90, 120, 200], th: [0, 5, 10] },
  stoch: { period: [9, 14, 21], buy: [10, 20, 30], sell: [70, 80, 90] },
  tma: { short: [5, 10, 20], mid: [25, 50, 75], long: [75, 100, 200] },
  dip: { down: [2, 3, 4, 5], exit: [3, 5, 10, 20] },
  tom: { from: [22, 24, 26, 28], to: [2, 3, 5] },
  fear: { buy: [22, 25, 30, 35, 40], sell: [15, 18, 20, 25] },
  fearpeak: { th: [25, 30, 35, 40], drop: [10, 20, 30], sell: [15, 18, 22] },
  ema: { short: [5, 9, 12, 20, 30], long: [21, 26, 50, 100, 200] },
  ichimoku: { tenkan: [7, 9, 12], kijun: [22, 26, 30], senkou: [44, 52, 60] },
  psar: { step: [0.01, 0.02, 0.03], max: [0.1, 0.2, 0.3] },
  supertrend: { period: [7, 10, 14, 20], mult: [2, 2.5, 3, 4] },
  adx: { period: [10, 14, 20], th: [15, 18, 22, 25], box: [10, 20, 40] },
  linreg: { period: [20, 50, 100, 200], k: [1, 1.5, 2, 3] },
  rating: { buy: [0.1, 0.2, 0.3, 0.5], sell: [-0.3, -0.1, 0, 0.1] },
  keltner: { period: [10, 20, 30, 50], mult: [1, 1.5, 2, 2.5] },
  volexp: { period: [10, 14, 20], k: [1.2, 1.5, 2], exit: [5, 10, 20] },
  insidebar: { hold: [3, 5, 10, 20, 40] },
  pivot: { left: [2, 4, 8], right: [1, 2, 4] },
  volume: { period: [10, 20, 50], k: [1.5, 2, 3], exit: [5, 10, 20] },
  vwap: { period: [10, 20, 50, 100, 200] },
  vprofile: { period: [30, 60, 120, 250] },
  uo: { buy: [25, 30, 35, 40], sell: [60, 65, 70, 75] },
  fibo: { look: [40, 60, 120], swing: [8, 15], level: [0, 1, 2], target: [0, 1, 2] },
  candle: { pat: [0, 1, 2, 4, 5, 6, 7, 8], hold: [3, 5, 10, 20] },
  chartpat: { pat: [1, 2, 3, 4], width: [3, 5, 8], tol: [2, 3, 5] },
  hold: {},
};
function combos(grid) {
  let out = [{}];
  for (const [k, vs] of Object.entries(grid)) out = out.flatMap(o => vs.map(v => ({ ...o, [k]: v })));
  return out;
}
function validParams(strategy, p) {
  if (strategy === "sma") return p.short < p.long;
  if (strategy === "rsi") return p.buy < p.sell;
  if (strategy === "macd") return p.fast < p.slow;
  if (strategy === "stoch") return p.buy < p.sell;
  if (strategy === "fear") return p.sell < p.buy;
  if (strategy === "fearpeak") return p.sell < p.th * 0.8;
  if (strategy === "tma") return p.short < p.mid && p.mid < p.long;
  if (strategy === "ema") return p.short < p.long;
  if (strategy === "ichimoku") return p.tenkan < p.kijun && p.kijun < p.senkou;
  if (strategy === "uo") return p.buy < p.sell;
  if (strategy === "rating") return p.sell < p.buy;
  return true;
}
// split（YYYY-MM-DD）までを前半、それより後を後半として、各組み合わせを別々に検証する
export function sweep(cfgIn, data, { from = null, split }) {
  const cfg = normalizeCfg(cfgIn);
  const nextDay = d => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  const rows = [];
  for (const params of combos(GRIDS[cfg.strategy] || {})) {
    if (!validParams(cfg.strategy, params)) continue;
    const c = { ...cfg, params };
    const a = backtest(c, data, { from, to: split });
    const b = backtest(c, data, { from: nextDay(split) });
    if (!a.metrics || !b.metrics) continue;
    rows.push({ params, inS: a.metrics, outS: b.metrics, benchIn: a.bench.metrics, benchOut: b.bench.metrics });
  }
  return rows.sort((x, y) => y.inS.totalPct - x.inS.totalPct);
}
