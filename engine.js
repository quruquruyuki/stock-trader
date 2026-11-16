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
  boll: {
    label: "ボリンジャー逆張り",
    desc: "終値がボリンジャーバンドの下限（平均−σ×倍率）を割ったら買い、平均線まで戻ったら売り。",
    params: [
      { key: "period", label: "期間（日）", def: 20, min: 5, max: 200 },
      { key: "k", label: "倍率（σ）", def: 2, min: 0.5, max: 4, step: 0.1 },
    ],
  },
  macd: {
    label: "MACDクロス",
    desc: "MACD（短期EMA−長期EMA）がシグナル線を上回ったら買い、下回ったら売り。",
    params: [
      { key: "fast", label: "短期EMA", def: 12, min: 2, max: 100 },
      { key: "slow", label: "長期EMA", def: 26, min: 3, max: 300 },
      { key: "signal", label: "シグナル", def: 9, min: 2, max: 100 },
    ],
  },
  roc: {
    label: "モメンタム（騰落率）",
    desc: "N日前と比べた上昇率が基準を超えていたら持つ、下回ったら売る。上がっているものに乗る順張り。",
    params: [
      { key: "period", label: "比較（日前）", def: 60, min: 5, max: 300 },
      { key: "th", label: "基準（%）", def: 0, min: -20, max: 50, step: 0.5 },
    ],
  },
  stoch: {
    label: "ストキャスティクス逆張り",
    desc: "直近N日の値幅の中で終値が下のほう（%Kが「買い」未満）なら買い、上のほう（「売り」超え）で売り。",
    params: [
      { key: "period", label: "期間（日）", def: 14, min: 3, max: 100 },
      { key: "buy", label: "買い（未満）", def: 20, min: 1, max: 99 },
      { key: "sell", label: "売り（超え）", def: 80, min: 1, max: 99 },
    ],
  },
  tma: {
    label: "3本の移動平均（パーフェクトオーダー）",
    desc: "短期＞中期＞長期の順に並んだら買い、並びが崩れたら売り。だましが少ない代わりに売買は遅め。",
    params: [
      { key: "short", label: "短期（日）", def: 5, min: 2, max: 100 },
      { key: "mid", label: "中期（日）", def: 25, min: 3, max: 200 },
      { key: "long", label: "長期（日）", def: 75, min: 5, max: 400 },
    ],
  },
  dip: {
    label: "連続下落の押し目買い",
    desc: "終値がN日続けて下がったら買い、終値がM日移動平均を上回ったら売り。短期の反発を狙う。",
    params: [
      { key: "down", label: "連続下落（日）", def: 3, min: 2, max: 10 },
      { key: "exit", label: "売り：移動平均（日）", def: 5, min: 2, max: 50 },
    ],
  },
  tom: {
    label: "月末・月初だけ持つ",
    desc: "毎月「開始日」以降から翌月「終了日」までだけ持つ。月の変わり目は上がりやすいという経験則。",
    params: [
      { key: "from", label: "開始日（日）", def: 25, min: 15, max: 31 },
      { key: "to", label: "終了日（日）", def: 3, min: 1, max: 10 },
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
  trendMa: 0,          // トレンド条件：終値がこの日数の移動平均より上のときだけ持つ（0=使わない）
  // 相場フィルター（市況）。mode: off=使わない / auto=指数で判定 / bull=強気で固定 / bear=弱気で固定
  // auto は「指数（symbol）の終値が ma 日移動平均以下」のとき弱気。action は弱気のときの動き:
  //   nobuy=新しく買わない / exit=持ち株も売って待つ / half=買う量を半分にする
  // rule は弱気の判定方法: ma=指数の移動平均 / vol=恐怖指数（volSym が volTh を超えたら弱気）/ either=どちらかが弱気なら弱気
  // volSym: VIX（米国）/ NKVI（日経平均VI）。volLag: 日本株で VIX を使うとき、前日までの値で判定する
  regime: { mode: "off", symbol: "", ma: 200, action: "nobuy", rule: "ma", volSym: "", volTh: 25, volLag: false },
};

export function normalizeCfg(c) {
  const cfg = { ...DEFAULT_CFG, ...(c || {}) };
  const st = STRATEGIES[cfg.strategy] ? cfg.strategy : "sma";
  const params = {};
  for (const p of STRATEGIES[st].params) {
    const v = Number(cfg.params?.[p.key]);
    const step = p.step || 1;
    params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, Math.round(v / step) * step)) : p.def;
    if (p.step) params[p.key] = Number(params[p.key].toFixed(4));
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
    trendMa: Math.round(num(cfg.trendMa, 0, 400, 0)),
    regime: {
      mode: ["auto", "bull", "bear"].includes(cfg.regime?.mode) ? cfg.regime.mode : "off",
      symbol: String(cfg.regime?.symbol ?? "").trim().toUpperCase().slice(0, 10),
      ma: Math.round(num(cfg.regime?.ma, 5, 400, 200)),
      action: ["exit", "half"].includes(cfg.regime?.action) ? cfg.regime.action : "nobuy",
      rule: ["vol", "either"].includes(cfg.regime?.rule) ? cfg.regime.rule : "ma",
      volSym: ["VIX", "NKVI"].includes(cfg.regime?.volSym) ? cfg.regime.volSym : "",
      volTh: num(cfg.regime?.volTh, 5, 100, 25),
      volLag: !!cfg.regime?.volLag,
    },
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

function emaArr(a, n) {
  const out = new Array(a.length).fill(null), k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < a.length; i++) {
    if (i === n - 1) { let s = 0; for (let j = 0; j < n; j++) s += a[j]; e = s / n; }
    else if (i >= n) e = a[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// 各日の「持ちたいか（1）／持ちたくないか（0）」。その日までのデータだけで判定する
// cfg.trendMa があれば、終値がその移動平均より上のときだけ持つ
export function signals(bars, strategy, p, trendMa = 0) {
  const raw = rawSignals(bars, strategy, p);
  if (!trendMa) return raw;
  const t = smaArr(bars.map(b => b.c), trendMa);
  return raw.map((v, i) => v && t[i] != null && bars[i].c > t[i] ? 1 : 0);
}

function rawSignals(bars, strategy, p) {
  const n = bars.length, c = bars.map(b => b.c), out = new Array(n).fill(0);
  if (strategy === "hold") return out.fill(1);
  if (strategy === "boll") {
    const m = smaArr(c, p.period);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (m[i] != null) {
        let v = 0; for (let k = i - p.period + 1; k <= i; k++) v += (c[k] - m[i]) ** 2;
        const lower = m[i] - p.k * Math.sqrt(v / p.period);
        if (!pos && c[i] < lower) pos = 1; else if (pos && c[i] >= m[i]) pos = 0;
      }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "roc") {
    for (let i = p.period; i < n; i++) out[i] = c[i - p.period] > 0 && (c[i] / c[i - p.period] - 1) * 100 > p.th ? 1 : 0;
    return out;
  }
  if (strategy === "stoch") {
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (i >= p.period - 1) {
        let hh = -Infinity, ll = Infinity;
        for (let k = i - p.period + 1; k <= i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
        const kv = hh > ll ? (c[i] - ll) / (hh - ll) * 100 : 50;
        if (!pos && kv < p.buy) pos = 1; else if (pos && kv > p.sell) pos = 0;
      }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "tma") {
    const a = smaArr(c, p.short), b = smaArr(c, p.mid), l = smaArr(c, p.long);
    for (let i = 0; i < n; i++) out[i] = l[i] != null && a[i] > b[i] && b[i] > l[i] ? 1 : 0;
    return out;
  }
  if (strategy === "dip") {
    const m = smaArr(c, p.exit);
    let pos = 0, downs = 0;
    for (let i = 1; i < n; i++) {
      downs = c[i] < c[i - 1] ? downs + 1 : 0;
      if (!pos && downs >= p.down) pos = 1; else if (pos && m[i] != null && c[i] > m[i]) pos = 0;
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "tom") {
    for (let i = 0; i < n; i++) { const day = Number(bars[i].d.slice(8, 10)); out[i] = day >= p.from || day <= p.to ? 1 : 0; }
    return out;
  }
  if (strategy === "macd") {
    const f = emaArr(c, p.fast), sl = emaArr(c, p.slow);
    const macd = c.map((_, i) => f[i] != null && sl[i] != null ? f[i] - sl[i] : null);
    const start = macd.findIndex(v => v != null);
    const sig = new Array(n).fill(null);
    if (start >= 0) { const e = emaArr(macd.slice(start), p.signal); for (let i = 0; i < e.length; i++) sig[start + i] = e[i]; }
    for (let i = 0; i < n; i++) out[i] = macd[i] != null && sig[i] != null && macd[i] > sig[i] ? 1 : 0;
    return out;
  }
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
  return { cash, positions: {}, pending: [], blocked: {}, lastClose: {}, lastDate: null, prevEquity: cash, peak: cash, halted: false, haltReason: null, regimeBear: null };
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
    sig[s] = signals(data[s], cfg.strategy, cfg.params, cfg.trendMa);
  }
  const dates = [...new Set(syms.flatMap(s => data[s].map(b => b.d)))]
    .filter(d => (!st.lastDate || d > st.lastDate) && (!opts.toDate || d <= opts.toDate)).sort();
  // 相場フィルター：その日が「弱気」かどうか
  const rg = cfg.regime;
  let bearOn = () => rg.mode === "bear";
  if (rg.mode === "auto") {
    // その日までに分かっている最後の値で判定する（strict なら前日まで）
    const lookup = (bars, test, strict) => { let ip = -1; return D => { while (ip + 1 < bars.length && (strict ? bars[ip + 1].d < D : bars[ip + 1].d <= D)) ip++; return ip >= 0 && test(ip); }; };
    let maBear = () => false, volBear = () => false;
    const ib = data[rg.symbol], vb = data["IX:" + rg.volSym];
    if (rg.rule !== "vol" && ib?.length) { const ima = smaArr(ib.map(b => b.c), rg.ma); maBear = lookup(ib, i => ima[i] != null && ib[i].c <= ima[i], false); }
    if (rg.rule !== "ma" && vb?.length) volBear = lookup(vb, i => vb[i].c > rg.volTh, rg.volLag);
    bearOn = D => { const a = maBear(D), b = volBear(D); return a || b; };
  }
  let bearDays = 0;
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
        const budget = Math.min(st.cash, equityOf(st) * posPct * (o.scale || 1));
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
    const bear = rg.mode !== "off" && bearOn(D);
    if (bear) bearDays++;
    if (rg.mode !== "off" && bear !== st.regimeBear) {
      if (st.regimeBear != null) notes.push({ d: D, msg: `相場フィルター：${bear ? "弱気" : "強気"}に変わりました` });
      st.regimeBear = bear;
    }
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
          else if (bear && rg.action === "exit") reason = "相場フィルター";
          else if (!want) reason = "売りシグナル";
          if (reason && !has("sell")) {
            st.pending.push({ symbol: s, side: "sell", reason, signalDate: D });
            if (reason === "損切り" || reason === "利確") st.blocked[s] = true; // 損切り・利確のあとは、シグナルが一度消えるまで買い直さない
          }
        } else {
          if (st.blocked[s] && !want) delete st.blocked[s];
          const stopBuy = bear && rg.action !== "half";
          if (want && !stopBuy && !st.blocked[s] && !has("buy")) st.pending.push({ symbol: s, side: "buy", reason: "買いシグナル", signalDate: D, ...(bear ? { scale: 0.5 } : {}) });
        }
      }
    }
    st.prevEquity = eq;
    st.lastDate = D;
  }
  return { state: st, trades, equity, notes, bearDays };
}

