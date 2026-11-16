// 売買エンジン（バックテストと模擬取引で共用。ブラウザと Supabase Edge Function の両方で動く）
// 日足ベース：その日の終値でシグナルを判定し、翌営業日の始値で約定する。買いのみ（空売りなし）。

export const STRATEGIES = {
  sma: {
    label: "移動平均クロス",
    desc: "短期の移動平均が長期を上回ったら買い、下回ったら売り。",
    params: [
      { key: "short", label: "短期（日）", def: 5, min: 2, max: 200 },
      { key: "long", label: "長期（日）", def: 25, min: 3, max: 400 },
    ],
  },
  rsi: {
    label: "RSI逆張り",
    desc: "RSIが「買い」の値を下回ったら買い、「売り」の値を上回ったら売り。",
    params: [
      { key: "period", label: "期間（日）", def: 14, min: 2, max: 100 },
      { key: "buy", label: "買い（未満）", def: 30, min: 1, max: 99 },
      { key: "sell", label: "売り（超え）", def: 70, min: 1, max: 99 },
    ],
  },
  breakout: {
    label: "高値ブレイク",
    desc: "終値が過去N日の高値を超えたら買い、過去M日の安値を割ったら売り。",
    params: [
      { key: "entry", label: "買い：高値（日）", def: 20, min: 2, max: 300 },
      { key: "exit", label: "売り：安値（日）", def: 10, min: 2, max: 300 },
    ],
  },
  hold: {
    label: "買って持ち続ける",
    desc: "最初に買って、そのまま持ち続ける（比較用）。",
    params: [],
  },
};

export const DEFAULT_CFG = {
  strategy: "sma",
  params: { short: 5, long: 25 },
  symbols: [],
  initialCash: 1_000_000,
  lot: 100,            // 売買単位（日本株は100株、米国株は1株）
  feePct: 0,           // 手数料（約定金額に対する%）
  slipPct: 0.1,        // スリッページ（想定より不利な値段で約定する分、%）
  slPct: 0,            // 損切り（買値から何%下がったら売るか。0=なし）
  tpPct: 0,            // 利確（買値から何%上がったら売るか。0=なし）
  maxPosPct: 100,      // 1銘柄に使う上限（資産に対する%。銘柄数で等分した値と小さい方を使う）
  maxTradesPerDay: 4,  // 1日の約定回数の上限
  maxDailyLossPct: 5,  // 1日でこれ以上資産が減ったら停止（%）
  maxDrawdownPct: 20,  // 最高値からこれ以上資産が減ったら停止（%）
};

export function normalizeCfg(c) {
  const cfg = { ...DEFAULT_CFG, ...(c || {}) };
  const st = STRATEGIES[cfg.strategy] ? cfg.strategy : "sma";
  const params = {};
  for (const p of STRATEGIES[st].params) {
    const v = Number(cfg.params?.[p.key]);
    params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, Math.round(v))) : p.def;
  }
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    strategy: st,
    params,
    symbols: [...new Set((cfg.symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 10),
    initialCash: num(cfg.initialCash, 1, 1e12, DEFAULT_CFG.initialCash),
    lot: num(cfg.lot, 1, 1000, 1),
    feePct: num(cfg.feePct, 0, 5, 0),
    slipPct: num(cfg.slipPct, 0, 5, 0.1),
    slPct: num(cfg.slPct, 0, 90, 0),
    tpPct: num(cfg.tpPct, 0, 1000, 0),
    maxPosPct: num(cfg.maxPosPct, 1, 100, 100),
    maxTradesPerDay: Math.round(num(cfg.maxTradesPerDay, 1, 100, 4)),
    maxDailyLossPct: num(cfg.maxDailyLossPct, 0, 100, 5),
    maxDrawdownPct: num(cfg.maxDrawdownPct, 0, 100, 20),
  };
}

/* ---------- 指標 ---------- */
function smaArr(a, n) {
  const out = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function rsiArr(c, n) {
  const out = new Array(c.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// 各日の「持ちたいか（1）／持ちたくないか（0）」。その日までのデータだけで判定する
export function signals(bars, strategy, p) {
  const n = bars.length, c = bars.map(b => b.c), out = new Array(n).fill(0);
  if (strategy === "hold") return out.fill(1);
  if (strategy === "sma") {
    const s = smaArr(c, p.short), l = smaArr(c, p.long);
    for (let i = 0; i < n; i++) out[i] = s[i] != null && l[i] != null && s[i] > l[i] ? 1 : 0;
    return out;
  }
  if (strategy === "rsi") {
    const r = rsiArr(c, p.period);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (r[i] != null) { if (!pos && r[i] < p.buy) pos = 1; else if (pos && r[i] > p.sell) pos = 0; }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "breakout") {
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (!pos && i >= p.entry) {
        let hh = -Infinity; for (let k = i - p.entry; k < i; k++) hh = Math.max(hh, bars[k].h);
        if (c[i] > hh) pos = 1;
      } else if (pos && i >= p.exit) {
        let ll = Infinity; for (let k = i - p.exit; k < i; k++) ll = Math.min(ll, bars[k].l);
        if (c[i] < ll) pos = 0;
      }
      out[i] = pos;
    }
    return out;
  }
  return out;
}

/* ---------- 模擬口座 ---------- */
export function initialState(cash) {
  return { cash, positions: {}, pending: [], blocked: {}, lastClose: {}, lastDate: null, prevEquity: cash, peak: cash, halted: false, haltReason: null };
}
const clone = o => JSON.parse(JSON.stringify(o));
function equityOf(st) {
  let e = st.cash;
  for (const [s, p] of Object.entries(st.positions)) e += p.qty * (st.lastClose[s] ?? p.avg);
  return e;
}

// state から始めて、data（{ 銘柄: [{d,o,h,l,c,v}, ...] }）の state.lastDate より後の日を順に処理する
// opts.applyHalts: 安全装置（1日の損失上限・最大下落）で止めるか
export function runDays(cfgIn, stateIn, data, opts = {}) {
  const cfg = normalizeCfg(cfgIn);
  const st = clone(stateIn);
  const trades = [], equity = [], notes = [];
  const syms = cfg.symbols.filter(s => data[s]?.length);
  const idx = {}, sig = {};
  for (const s of syms) {
    idx[s] = new Map(data[s].map((b, i) => [b.d, i]));
    sig[s] = signals(data[s], cfg.strategy, cfg.params);
  }
  const dates = [...new Set(syms.flatMap(s => data[s].map(b => b.d)))]
    .filter(d => (!st.lastDate || d > st.lastDate) && (!opts.toDate || d <= opts.toDate)).sort();
  const slip = cfg.slipPct / 100, fee = cfg.feePct / 100;
  const posPct = Math.min(cfg.maxPosPct / 100, 1 / Math.max(1, syms.length));

  for (const D of dates) {
    const bar = s => { const i = idx[s]?.get(D); return i == null ? null : data[s][i]; };

    // 1) 前日に出した注文を、今日の始値で約定（売りを先に）
    let fills = 0;
    const keep = [];
    const orders = [...st.pending].sort((a, b) => (a.side === "sell" ? 0 : 1) - (b.side === "sell" ? 0 : 1));
    for (const o of orders) {
      const b = bar(o.symbol);
      if (!b || !(b.o > 0)) { keep.push(o); continue; }
      if (fills >= cfg.maxTradesPerDay) { notes.push({ d: D, msg: `${o.symbol}：1日の取引回数の上限（${cfg.maxTradesPerDay}回）のため注文を取り消しました` }); continue; }
      if (o.side === "sell") {
        const p = st.positions[o.symbol];
        if (!p) continue;
        const price = b.o * (1 - slip), value = p.qty * price, f = value * fee;
        st.cash += value - f;
        trades.push({ d: D, symbol: o.symbol, side: "sell", qty: p.qty, price, fee: f, pnl: value - f - p.cost, reason: o.reason });
        delete st.positions[o.symbol];
        fills++;
      } else {
        if (st.positions[o.symbol]) continue;
        const price = b.o * (1 + slip);
        const budget = Math.min(st.cash, equityOf(st) * posPct);
        const qty = Math.floor(budget / (price * (1 + fee)) / cfg.lot) * cfg.lot;
        if (qty <= 0) { notes.push({ d: D, msg: `${o.symbol}：資金が足りず買えませんでした（${cfg.lot}株単位）` }); continue; }
        const cost = qty * price, f = cost * fee;
        st.cash -= cost + f;
        st.positions[o.symbol] = { qty, avg: price, cost: cost + f, entry: D };
        trades.push({ d: D, symbol: o.symbol, side: "buy", qty, price, fee: f, pnl: null, reason: o.reason });
        fills++;
      }
    }
    st.pending = keep;

    // 2) 終値で評価
    for (const s of syms) { const b = bar(s); if (b && b.c > 0) st.lastClose[s] = b.c; }
    const eq = equityOf(st);
    equity.push({ d: D, equity: eq, cash: st.cash });

    // 3) 安全装置
    if (opts.applyHalts && !st.halted) {
      const dayLoss = st.prevEquity > 0 ? (st.prevEquity - eq) / st.prevEquity * 100 : 0;
      st.peak = Math.max(st.peak, eq);
      const dd = st.peak > 0 ? (st.peak - eq) / st.peak * 100 : 0;
      if (cfg.maxDailyLossPct > 0 && dayLoss >= cfg.maxDailyLossPct) { st.halted = true; st.haltReason = `${D}：1日で資産が${dayLoss.toFixed(1)}%減ったため停止`; }
      else if (cfg.maxDrawdownPct > 0 && dd >= cfg.maxDrawdownPct) { st.halted = true; st.haltReason = `${D}：最高値から資産が${dd.toFixed(1)}%減ったため停止`; }
      if (st.halted) { notes.push({ d: D, msg: st.haltReason }); st.pending = []; }
    } else st.peak = Math.max(st.peak, eq);

    // 4) 今日の終値でシグナルを判定し、翌営業日の注文を出す
    if (!st.halted) {
      for (const s of syms) {
        const i = idx[s].get(D);
        if (i == null) continue;
        const want = sig[s][i], c = data[s][i].c, p = st.positions[s];
        const has = side => st.pending.some(o => o.symbol === s && o.side === side);
        if (p) {
          let reason = null;
          if (cfg.slPct > 0 && c <= p.avg * (1 - cfg.slPct / 100)) reason = "損切り";
          else if (cfg.tpPct > 0 && c >= p.avg * (1 + cfg.tpPct / 100)) reason = "利確";
          else if (!want) reason = "売りシグナル";
          if (reason && !has("sell")) {
            st.pending.push({ symbol: s, side: "sell", reason, signalDate: D });
            if (reason !== "売りシグナル") st.blocked[s] = true; // 損切り・利確のあとは、シグナルが一度消えるまで買い直さない
          }
        } else {
          if (st.blocked[s] && !want) delete st.blocked[s];
          if (want && !st.blocked[s] && !has("buy")) st.pending.push({ symbol: s, side: "buy", reason: "買いシグナル", signalDate: D });
        }
      }
    }
    st.prevEquity = eq;
    st.lastDate = D;
  }
  return { state: st, trades, equity, notes };
}

/* ---------- バックテスト ---------- */
// opts.from（YYYY-MM-DD）より前のデータは、シグナル計算の助走にだけ使う
export function backtest(cfgIn, data, opts = {}) {
  const cfg = normalizeCfg(cfgIn);
  const start = () => {
    const st = initialState(cfg.initialCash);
    if (opts.from) { const d = new Date(opts.from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); st.lastDate = d.toISOString().slice(0, 10); }
    return st;
  };
  const main = runDays(cfg, start(), data, { applyHalts: false });
  const bench = runDays({ ...cfg, strategy: "hold", params: {}, slPct: 0, tpPct: 0, maxTradesPerDay: 100 }, start(), data, { applyHalts: false });
  return { cfg, ...main, metrics: metrics(main.equity, main.trades, cfg.initialCash), bench: { equity: bench.equity, metrics: metrics(bench.equity, bench.trades, cfg.initialCash) } };
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
  const sells = trades.filter(t => t.side === "sell");
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
