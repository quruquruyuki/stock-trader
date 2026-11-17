import { normalizeCfg, runDays, initialState, exitTax } from "./engine.js";

/* ---------- バックテスト ---------- */
// opts.from（YYYY-MM-DD）より前のデータは、シグナル計算の助走にだけ使う。opts.to までで止める
export function backtest(cfgIn, data, opts = {}) {
  const cfg = normalizeCfg(cfgIn);
  const start = () => {
    const st = initialState(cfg.initialCash);
    if (opts.from) { const d = new Date(opts.from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); st.lastDate = d.toISOString().slice(0, 10); }
    return st;
  };
  const o = { applyHalts: false, toDate: opts.to || null, sig: opts.sig, bearMap: opts.bearMap };
  // 最後の日に全部売ったとして、税金を引いた資産で評価する（買い持ちも同じ）
  const settle = r => {
    const tax = exitTax(cfg, r.state);
    if (tax && r.equity.length) { const L = r.equity.length - 1; r.equity = [...r.equity.slice(0, L), { ...r.equity[L], equity: r.equity[L].equity - tax }]; }
    r.taxTotal = (r.state.taxTotal || 0) + tax;
    return r;
  };
  const main = settle(runDays(cfg, start(), data, o));
  const out = { cfg, ...main, bearPct: main.equity.length ? main.bearDays / main.equity.length * 100 : 0, metrics: metrics(main.equity, main.trades, cfg.initialCash) };
  if (opts.noBench) return out;
  // 比べる相手は、レバレッジなしで買って持ち続けた場合（税金は同じ口座の条件で）
  // opts.benchSym があれば、その銘柄（指数ETFなど）を持ち続けた場合と比べる
  const bsyms = opts.benchSym && data[opts.benchSym]?.length ? [opts.benchSym] : cfg.symbols;
  const bench = settle(runDays({ ...cfg, symbols: bsyms, strategy: "hold", params: {}, side: "long", slPct: 0, tpPct: 0, maxTradesPerDay: 100, trendMa: 0, sizeMode: "pct", maxPosPct: 100, lot: bsyms === cfg.symbols ? cfg.lot : 1, lev: 1, regime: { mode: "off" } }, start(), data, { applyHalts: false, toDate: opts.to || null }));
  return { ...out, bench: { equity: bench.equity, taxTotal: bench.taxTotal, metrics: metrics(bench.equity, bench.trades, cfg.initialCash) } };
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

// 資産の推移の一部分（from〜to）だけで成績を出す。始まりは from の前日の資産
export function partMetrics(equity, trades, from, to) {
  const i0 = equity.findIndex(e => e.d >= from);
  if (i0 < 0) return null;
  let i1 = equity.length - 1; while (i1 >= i0 && equity[i1].d > to) i1--;
  if (i1 <= i0) return null;
  const base = i0 > 0 ? equity[i0 - 1].equity : equity[i0].equity;
  return metrics(equity.slice(i0, i1 + 1), trades.filter(t => t.d >= from && t.d <= to), base);
}

/* ---------- 期間を区切る ---------- */
// 日付の並びを、年ごと（4年以上）・半年ごと（1.5年以上）・四半期ごとに区切る。短すぎる端の区間は隣とまとめる
export function segmentize(dates) {
  if (!dates.length) return { unit: "", segs: [] };
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 864e5 / 365.25;
  const unit = years >= 4 ? "year" : years >= 1.5 ? "half" : "quarter";
  const keyOf = d => {
    const y = d.slice(2, 4), m = Number(d.slice(5, 7));
    return unit === "year" ? `'${y}` : unit === "half" ? `'${y}${m <= 6 ? "前" : "後"}` : `'${y}Q${Math.ceil(m / 3)}`;
  };
  const segs = [];
  dates.forEach((d, i) => {
    const k = keyOf(d), last = segs[segs.length - 1];
    if (last && last.label === k) last.i1 = i; else segs.push({ label: k, i0: i, i1: i });
  });
  const len = s => s.i1 - s.i0 + 1, minLen = { year: 100, half: 50, quarter: 25 }[unit];
  if (segs.length > 2 && len(segs[0]) < minLen) { segs[1].i0 = segs[0].i0; segs[1].label = segs[0].label + "-" + segs[1].label.slice(1); segs.shift(); }
  if (segs.length > 2 && len(segs[segs.length - 1]) < minLen) { const z = segs.pop(); segs[segs.length - 1].i1 = z.i1; segs[segs.length - 1].label += "〜"; }
  for (const g of segs) { g.from = dates[g.i0]; g.to = dates[g.i1]; }
  return { unit, segs };
}
// 区間ごとの損益（%）。区間の始まりは、ひとつ前の区間の最後の資産（最初は元本）
// 日付で区間を合わせるので、比べる相手と日付の並びが少しちがっても使える
export function segReturns(equity, segs, initial) {
  const lastAtOrBefore = d => { let lo = 0, hi = equity.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (equity[m].d <= d) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  return segs.map(g => {
    const j0 = lastAtOrBefore(g.from) , i1 = lastAtOrBefore(g.to);
    const b0 = j0 >= 0 && equity[j0].d < g.from ? j0 : j0 - 1; // 区間の始まりより前の最後の日
    const base = b0 >= 0 ? equity[b0].equity : initial, end = i1 >= 0 ? equity[i1].equity : null;
    return base > 0 && end != null && i1 >= 0 && equity[i1].d >= g.from ? (end / base - 1) * 100 : null;
  });
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
  rotation: { period: [63, 126, 189, 252], top: [1, 2, 3], th: [0, 2], rebal: [0, 1] },
  hold: {},
};
export function combos(grid) {
  let out = [{}];
  for (const [k, vs] of Object.entries(grid)) out = out.flatMap(o => vs.map(v => ({ ...o, [k]: v })));
  return out;
}
export function validParams(strategy, p) {
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
