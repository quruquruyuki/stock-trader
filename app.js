import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { STRATEGIES, normalizeCfg } from "./engine.js";
import { GRIDS, backtest, sweep } from "./research.js";

const CFG = window.ST_CONFIG;
const sb = createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
const FN = "stock-trader";
const $ = id => document.getElementById(id);

let user = null;
let market = "JP";
let period = 2;
let lastBT = null;       // 直近のバックテスト結果
let bots = [];
let names = {};          // "JP:7203" -> 銘柄名
const barCache = {};     // "JP:7203" -> { from, bars }

/* ---------- util ---------- */
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2600); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const money = (v, m) => v == null || !Number.isFinite(v) ? "—" : m === "US"
  ? (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : (v < 0 ? "-¥" : "¥") + Math.round(Math.abs(v)).toLocaleString("ja-JP");
const price = (v, m) => v == null ? "—" : m === "US" ? v.toFixed(2) : v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
const pct = (v, d = 1) => v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(d) + "%";
const cls = v => v > 0 ? "up" : v < 0 ? "dn" : "";
const fmtD = d => d ? d.replaceAll("-", ".") : "";
const parseSyms = s => [...new Set(String(s).split(/[,\s、，]+/).map(x => x.trim().toUpperCase()).filter(Boolean))].slice(0, 10);
const symLabel = (m, s) => names[`${m}:${s}`] ? `${s} ${names[`${m}:${s}`]}` : s;

async function call(action, body = {}) {
  const { data, error } = await sb.functions.invoke(FN, { body: { action, ...body } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.innerHTML = `<span class="spin"></span>${esc(label || "処理中…")}`; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}
function segInit(id, onPick) {
  $(id).addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    [...$(id).children].forEach(x => x.classList.toggle("on", x === b));
    onPick(b.dataset.v);
  });
}

/* ---------- charts（SVGを手描き） ---------- */
const W = 640, H = 230, PL = 8, PR = 62, PT = 12, PB = 24;
function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= step0) || step0;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}
const shortNum = (v, m) => {
  const a = Math.abs(v);
  if (m === "US") return a >= 1e6 ? (v / 1e6).toFixed(1) + "M" : a >= 1e4 ? (v / 1e3).toFixed(0) + "k" : v.toFixed(a < 10 ? 2 : 0);
  return a >= 1e8 ? (v / 1e8).toFixed(1) + "億" : a >= 1e4 ? (v / 1e4).toFixed(a >= 1e6 ? 0 : 1) + "万" : v.toFixed(0);
};
// series: [{ pts:[{d,v}], color, width }], markers: [{d, v, side}]
function drawChart(svg, series, { markers = [], m = "JP", fmt } = {}) {
  const all = series.flatMap(s => s.pts);
  if (!all.length) { svg.setAttribute("viewBox", `0 0 ${W} 60`); svg.innerHTML = `<text x="${W / 2}" y="34" text-anchor="middle" font-size="13" fill="#7b7f86">データがありません</text>`; return; }
  const dates = [...new Set(all.map(p => p.d))].sort();
  const di = new Map(dates.map((d, i) => [d, i]));
  let lo = Math.min(...all.map(p => p.v)), hi = Math.max(...all.map(p => p.v));
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad;
  const x = d => PL + (dates.length < 2 ? 0 : di.get(d) / (dates.length - 1)) * (W - PL - PR);
  const y = v => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  let g = "";
  for (const t of niceTicks(lo, hi)) {
    g += `<line x1="${PL}" x2="${W - PR}" y1="${y(t)}" y2="${y(t)}" stroke="#e4e2da" stroke-width="1"/>`;
    g += `<text x="${W - PR + 8}" y="${y(t) + 4}" font-size="11" font-family="IBM Plex Mono,monospace" fill="#7b7f86">${shortNum(t, m)}</text>`;
  }
  const yr = d => d.slice(0, 4);
  const step = Math.max(1, Math.floor(dates.length / 5));
  let prevLbl = "";
  for (let i = 0; i < dates.length; i += step) {
    const d = dates[i], lbl = dates.length > 400 ? yr(d) : d.slice(2, 7).replace("-", "/");
    if (lbl === prevLbl) continue; prevLbl = lbl;
    g += `<text x="${x(d)}" y="${H - 6}" font-size="10.5" font-family="IBM Plex Mono,monospace" fill="#9aa0a8" text-anchor="${i === 0 ? "start" : "middle"}">${lbl}</text>`;
  }
  for (const s of series) {
    if (!s.pts.length) continue;
    const path = s.pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    g += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  for (const k of markers) {
    if (!di.has(k.d)) continue;
    const cx = x(k.d), cy = y(k.v);
    g += k.side === "buy"
      ? `<path d="M${cx},${cy + 5} l-5,9 h10z" fill="#0f7a55"/>`
      : `<path d="M${cx},${cy - 5} l-5,-9 h10z" fill="#b8392e"/>`;
  }
  g += `<line class="xh" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="#15181c" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  // タップ・ホバーで値を表示
  const wrap = svg.parentElement;
  let tip = wrap.querySelector(".tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "tip hidden"; wrap.appendChild(tip); }
  const maps = series.map(s => new Map(s.pts.map(p => [p.d, p.v])));
  const show = ev => {
    const r = svg.getBoundingClientRect();
    const fx = (ev.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(dates.length - 1, Math.round((fx - PL) / (W - PL - PR) * (dates.length - 1))));
    const d = dates[i], xx = x(d);
    const xh = svg.querySelector(".xh"); xh.setAttribute("x1", xx); xh.setAttribute("x2", xx); xh.setAttribute("visibility", "visible");
    const vals = series.map((s, k) => maps[k].has(d) ? `<span style="color:${s.tipColor || "#fff"}">${(fmt || (v => money(v, m)))(maps[k].get(d))}</span>` : "").filter(Boolean);
    tip.innerHTML = `${fmtD(d)}　${vals.join("　")}`;
    tip.classList.remove("hidden");
    tip.style.left = Math.min(Math.max(xx / W * r.width, 70), r.width - 70) + "px";
  };
  const hide = () => { tip.classList.add("hidden"); svg.querySelector(".xh")?.setAttribute("visibility", "hidden"); };
  svg.onpointermove = show; svg.onpointerdown = show; svg.onpointerleave = hide;
}
function spark(pts, up) {
  if (pts.length < 2) return "";
  const lo = Math.min(...pts), hi = Math.max(...pts), w = 300, h = 36;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i / (pts.length - 1) * w).toFixed(1)},${(h - 3 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (h - 6)).toFixed(1)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${up ? "#0f7a55" : "#b8392e"}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

/* ---------- バックテスト画面 ---------- */
function setMarket(m) {
  market = m;
  $("btSymbols").placeholder = m === "JP" ? "7203, 6758" : "AAPL, MSFT";
  $("btSymHint").textContent = m === "JP" ? "4桁の銘柄コード（例：7203 トヨタ、6758 ソニーG）" : "ティッカー（例：AAPL アップル、MSFT マイクロソフト、SPY S&P500 ETF）";
  $("btCashLab").textContent = m === "JP" ? "初期資金（円）" : "初期資金（ドル）";
  $("btRgSym").value = m === "JP" ? "1306" : "SPY";
  $("btRgVolSym").value = m === "JP" ? "NKVI" : "VIX";
  $("btFearSym").value = m === "JP" ? "NKVI" : "VIX";
  $("btRgVolTh").value = m === "JP" ? "30" : "25";
  $("btRgHint").textContent = `指数の終値が移動平均以下の日を「弱気」とみなします。初期値は${m === "JP" ? "TOPIX連動ETF（1306）" : "S&P500 ETF（SPY）"}の200日線です。`;
  $("btCash").value = m === "JP" ? "1000000" : "10000";
  $("btLot").innerHTML = m === "JP"
    ? `<option value="100">100株（単元株）</option><option value="1">1株（単元未満株）</option>`
    : `<option value="1">1株</option>`;
}
function renderParams() {
  const st = STRATEGIES[$("btStrategy").value];
  $("btDesc").textContent = st.desc;
  $("btParams").innerHTML = st.params.map(p => `<div><label class="lab" for="bp_${p.key}">${esc(p.label)}</label><input id="bp_${p.key}" class="in num" inputmode="${p.step ? "decimal" : "numeric"}" value="${p.def}"></div>`).join("");
  $("swCard") && $("swCard").classList.toggle("hidden", !Object.keys(GRIDS[$("btStrategy").value] || {}).length);
  $("btParams").classList.toggle("hidden", !st.params.length);
  $("btFearBox").classList.toggle("hidden", !st.needsVol);
}
function readCfg() {
  const strategy = $("btStrategy").value, params = {};
  for (const p of STRATEGIES[strategy].params) params[p.key] = Number($("bp_" + p.key).value);
  const n = id => Number(String($(id).value).replace(/[,\s]/g, ""));
  return normalizeCfg({
    strategy, params, symbols: parseSyms($("btSymbols").value),
    initialCash: n("btCash"), lot: n("btLot"), slPct: n("btSl"), tpPct: n("btTp"),
    feePct: n("btFee"), slipPct: n("btSlip"), maxPosPct: n("btPos"), trendMa: n("btTrend"),
    side: $("btSide").value, borrowPct: n("btBorrow"),
    fearSym: STRATEGIES[strategy].needsVol ? $("btFearSym").value : "", fearLag: market === "JP" && $("btFearSym").value === "VIX",
    regime: { mode: $("btRgMode").value, symbol: $("btRgSym").value, ma: n("btRgMa"), action: $("btRgAct").value,
      rule: $("btRgRule").value, volSym: $("btRgVolSym").value, volTh: n("btRgVolTh"), volLag: market === "JP" && $("btRgVolSym").value === "VIX" },
  });
}
const isoAgo = days => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };

async function getBars(m, symbols, from) {
  const need = symbols.filter(s => { const c = barCache[`${m}:${s}`]; return !c || (c.from && (!from || from < c.from)) || Date.now() - c.at > 30 * 60e3; });
  const errors = {};
  if (need.length) {
    const r = await call("bars", { market: m, symbols: need, from });
    for (const [s, v] of Object.entries(r.symbols || {})) { barCache[`${m}:${s}`] = { from, bars: v.bars, at: Date.now() }; if (v.name) names[`${m}:${s}`] = v.name; }
    Object.assign(errors, r.errors || {});
  }
  const data = {};
  for (const s of symbols) { const c = barCache[`${m}:${s}`]; if (c) data[s] = c.bars; }
  return { data, errors };
}

$("btRun").onclick = async () => {
  const cfg = readCfg();
  $("btErr").textContent = "";
  if (!cfg.symbols.length) { $("btErr").textContent = "銘柄を入れてください"; return; }
  if (cfg.strategy === "sma" && cfg.params.short >= cfg.params.long) { $("btErr").textContent = "移動平均は「短期」を「長期」より小さくしてください"; return; }
  if (cfg.strategy === "macd" && cfg.params.fast >= cfg.params.slow) { $("btErr").textContent = "MACDは「短期EMA」を「長期EMA」より小さくしてください"; return; }
  if (cfg.strategy === "tma" && !(cfg.params.short < cfg.params.mid && cfg.params.mid < cfg.params.long)) { $("btErr").textContent = "移動平均は 短期＜中期＜長期 の順にしてください"; return; }
  if (cfg.strategy === "fear" && cfg.params.sell >= cfg.params.buy) { $("btErr").textContent = "「手じまい」は「仕掛け」より小さくしてください"; return; }
  if (cfg.strategy === "stoch" && cfg.params.buy >= cfg.params.sell) { $("btErr").textContent = "「買い」は「売り」より小さくしてください"; return; }
  const rgSym = cfg.regime.mode === "auto" && cfg.regime.rule !== "vol" ? (cfg.regime.symbol || (market === "JP" ? "1306" : "SPY")) : null;
  const volSym = cfg.regime.mode === "auto" && cfg.regime.rule !== "ma" ? cfg.regime.volSym : null;
  if (rgSym) cfg.regime.symbol = rgSym;
  busy($("btRun"), true, "株価を取得して計算中…");
  try {
    const start = period ? isoAgo(Math.round(period * 365.25)) : null;
    const from = start ? isoAgo(Math.round(period * 365.25) + 600) : null; // シグナルの助走分も取る
    const { data, errors } = await getBars(market, [...new Set([...cfg.symbols, ...(rgSym ? [rgSym] : [])])], from);
    if (rgSym && !data[rgSym]?.length) throw new Error(`相場フィルターの指数 ${rgSym} の株価が取得できませんでした${errors[rgSym] ? "：" + errors[rgSym] : ""}`);
    for (const vs of [...new Set([volSym, cfg.fearSym].filter(Boolean))]) {
      const v = await getBars("IX", [vs], from);
      if (!v.data[vs]?.length) throw new Error(`恐怖指数 ${VOL_NAME[vs]} が取得できませんでした${v.errors[vs] ? "：" + v.errors[vs] : ""}`);
      data["IX:" + vs] = v.data[vs];
    }
    const ok = cfg.symbols.filter(s => data[s]?.length);
    const errText = Object.entries(errors).map(([s, e]) => `${s}：${e}`).join("\n");
    if (!ok.length) throw new Error(errText || "株価が取得できませんでした");
    const res = backtest({ ...cfg, symbols: ok }, data, { from: start });
    if (!res.equity.length) throw new Error("この期間のデータがありません。期間を「全部」にして試してください");
    lastBT = { market, cfg: { ...cfg, symbols: ok }, res, data, period, start, sweepRows: null };
    $("swOut").innerHTML = "";
    renderBT(errText);
    $("btOut").classList.remove("hidden");
    $("btOut").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { $("btErr").textContent = e.message; }
  finally { busy($("btRun"), false); }
};

function renderBT(errText) {
  const { market: m, cfg, res } = lastBT, M = res.metrics, B = res.bench.metrics;
  const first = res.equity[0].d, last = res.equity[res.equity.length - 1].d;
  $("btTitle").innerHTML = `結果 <span class="mu num" style="font-size:12px;font-weight:400">${fmtD(first)}〜${fmtD(last)}</span>`;
  const k = (label, v, sub, c = "") => `<div class="kpi"><div class="k">${label}</div><div class="v ${c}">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  $("btKpis").innerHTML =
    k("最終資産", money(M.final, m), "元本 " + money(cfg.initialCash, m)) +
    k("損益", pct(M.totalPct), "年率 " + pct(M.cagrPct), cls(M.totalPct)) +
    k("最大下落", "-" + M.maxDDPct.toFixed(1) + "%", "最高値からの落ち込み", "dn") +
    k("取引回数", M.trades + "回", M.roundTrips + "往復") +
    k("勝率", M.winPct == null ? "—" : M.winPct.toFixed(0) + "%", "売った取引のうち") +
    k("シャープ", M.sharpe.toFixed(2), "値動きあたりの効率");
  const diff = M.totalPct - B.totalPct;
  $("btCmp").innerHTML = `買って持ち続けた場合は <b class="num ${cls(B.totalPct)}">${pct(B.totalPct)}</b>（最大下落 <span class="num">-${B.maxDDPct.toFixed(1)}%</span>）。`
    + `この戦略は <b class="num ${cls(diff)}">${diff >= 0 ? "上回り" : "下回り"}（${pct(diff)}）</b>`
    + (M.maxDDPct < B.maxDDPct ? `、下落は小さく抑えられています。` : `、下落は同じか大きめです。`);
  drawChart($("btEqChart"), [
    { pts: res.bench.equity.map(e => ({ d: e.d, v: e.equity })), color: "#9aa0a8", width: 1.4, tipColor: "#c9cdd2" },
    { pts: res.equity.map(e => ({ d: e.d, v: e.equity })), color: "#0f5c47", width: 2, tipColor: "#7fe0bd" },
  ], { m });
  $("btSymSeg").innerHTML = cfg.symbols.map((s, i) => `<button data-s="${esc(s)}" class="${i ? "" : "on"}">${esc(symLabel(m, s))}</button>`).join("");
  drawPx(cfg.symbols[0]);
  if (cfg.regime.mode !== "off") $("btCmp").innerHTML += `<br>相場フィルター：期間の <b class="num">${res.bearPct.toFixed(0)}%</b> の日を弱気と判定（${esc(regimeText(cfg))}）。`;
  const notes = [...(errText ? [errText] : []), ...res.notes.filter(n => !n.msg.startsWith("相場フィルター")).slice(-5).map(n => `${fmtD(n.d)} ${n.msg}`)];
  $("btNotes").innerHTML = notes.length ? `<div class="notes">${notes.map(esc).join("<br>")}</div>` : "";
  $("btTradeCount").textContent = `${res.trades.length}件`;
  $("btTrades").innerHTML = tradeTable(res.trades.slice().reverse(), m);
}
function drawPx(sym) {
  const { market: m, res, data } = lastBT, first = res.equity[0].d;
  const bars = data[sym].filter(b => b.d >= first);
  const markers = res.trades.filter(t => t.symbol === sym).map(t => ({ d: t.d, v: t.price, side: t.side }));
  drawChart($("btPxChart"), [{ pts: bars.map(b => ({ d: b.d, v: b.c })), color: "#15181c", width: 1.4 }], { markers, m, fmt: v => price(v, m) });
}
$("btSymSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  [...$("btSymSeg").children].forEach(x => x.classList.toggle("on", x === b));
  drawPx(b.dataset.s);
});
function tradeTable(trades, m) {
  if (!trades.length) return `<tr><td class="empty" colspan="6">取引はまだありません</td></tr>`;
  return `<tr><th>日付</th><th>銘柄</th><th>売買</th><th>株数</th><th>約定値</th><th>損益</th></tr>` + trades.map(t => `<tr>
    <td>${fmtD(t.d).slice(2)}</td><td>${esc(t.symbol)}</td><td class="side-${t.side}" title="${esc(t.reason || "")}">${t.side === "buy" ? "買" : "売"}${t.reason && t.reason !== "買いシグナル" && t.reason !== "売りシグナル" ? `<span class="mu" style="font-size:10px">${esc(t.reason)}</span>` : ""}</td>
    <td>${t.qty.toLocaleString()}</td><td>${price(t.price, m)}</td><td class="${cls(t.pnl)}">${t.pnl == null ? "" : money(t.pnl, m)}</td></tr>`).join("");
}

const paramText = cfg => {
  const ps = (STRATEGIES[cfg.strategy]?.params || []).map(p => `${p.label.replace(/（.*）/, "")} ${cfg.params[p.key]}`).join("・");
  return `${cfg.side === "short" ? "【空売り】" : ""}${STRATEGIES[cfg.strategy]?.label || cfg.strategy}${cfg.fearSym ? "・" + VOL_NAME[cfg.fearSym] : ""}${ps ? "（" + ps + "）" : ""}${cfg.trendMa ? `＋${cfg.trendMa}日線より上のときだけ` : ""}${cfg.regime && cfg.regime.mode !== "off" ? `＋相場フィルター` : ""}`;
};
const VOL_NAME = { VIX: "VIX", NKVI: "日経平均VI" };
const RG_ACT = { nobuy: "新しく買わない", exit: "持ち株も売って待つ", half: "買う量を半分にする" };
const regimeText = cfg => {
  const r = cfg.regime || { mode: "off" };
  if (r.mode === "off") return "使わない";
  const act = `弱気のとき：${RG_ACT[r.action] || RG_ACT.nobuy}`;
  if (r.mode === "bull") return "強気で固定";
  if (r.mode === "bear") return `弱気で固定／${act}`;
  const ma = `${r.symbol} が${r.ma}日線以下`, vol = `${VOL_NAME[r.volSym] || r.volSym} が${r.volTh}超${r.volLag ? "（前日まで）" : ""}`;
  return `${r.rule === "vol" ? vol : r.rule === "either" ? `${ma}、または${vol}` : ma}なら弱気／${act}`;
};
const shortParams = (st, p) => (STRATEGIES[st]?.params || []).map(x => `${x.label.replace(/（.*）/, "").replace(/^買い：|^売り：/, "")}${p[x.key]}`).join(" / ");

/* ---------- 総当たり ---------- */
$("swRun").onclick = async () => {
  if (!lastBT) return;
  const { cfg, data, res, start } = lastBT;
  const dates = res.equity.map(e => e.d);
  if (dates.length < 120) { $("swOut").innerHTML = `<div class="err">期間が短すぎます。もっと長い期間で検証してください</div>`; return; }
  const split = dates[Math.floor(dates.length * 0.7)];
  busy($("swRun"), true, "計算中…");
  await new Promise(r => setTimeout(r, 30));
  try {
    const rows = sweep(cfg, data, { from: start || dates[0], split });
    lastBT.sweepRows = rows; lastBT.split = split;
    renderSweep();
  } catch (e) { $("swOut").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  finally { busy($("swRun"), false); }
};
function renderSweep() {
  const { cfg, sweepRows: rows, split, res } = lastBT;
  if (!rows?.length) { $("swOut").innerHTML = `<div class="empty">結果がありません</div>`; return; }
  const beat = r => r.outS.totalPct > r.benchOut.totalPct;
  const top = rows.slice(0, 15), top5 = rows.slice(0, 5);
  const nBeat = top5.filter(beat).length;
  const bestOut = rows.slice().sort((a, b) => b.outS.totalPct - a.outS.totalPct)[0];
  $("swOut").innerHTML = `
    <div class="swsum">${rows.length}通りを検証。前半 <span class="num">${fmtD(res.equity[0].d)}〜${fmtD(split)}</span>／後半 <span class="num">${fmtD(split)}〜${fmtD(res.equity[res.equity.length - 1].d)}</span><br>
    前半の上位5つのうち、後半も買い持ち（<span class="num ${cls(rows[0].benchOut.totalPct)}">${pct(rows[0].benchOut.totalPct)}</span>）を上回ったのは <b>${nBeat}つ</b>。
    ${nBeat >= 3 ? "前半の良さが後半にもある程度続いています。" : nBeat >= 1 ? "後半で崩れたものも多く、過信は禁物です。" : "前半の上位は後半でふるいませんでした。過去に合わせすぎている可能性が高いです。"}
    <br>後半だけで一番良かったのは <b>${esc(shortParams(cfg.strategy, bestOut.params))}</b>（<span class="num ${cls(bestOut.outS.totalPct)}">${pct(bestOut.outS.totalPct)}</span>）</div>
    <div class="tscroll"><table class="t sw"><tr><th>組み合わせ（前半の成績順）</th><th>前半</th><th>後半</th><th>後半の下落</th></tr>
    ${top.map((r, i) => `<tr class="r" data-i="${i}"><td class="p">${beat(r) ? `<span class="star">★</span>` : ""}${esc(shortParams(cfg.strategy, r.params))}</td>
      <td class="${cls(r.inS.totalPct)}">${pct(r.inS.totalPct)}</td><td class="${cls(r.outS.totalPct)}">${pct(r.outS.totalPct)}</td><td>-${r.outS.maxDDPct.toFixed(1)}%</td></tr>`).join("")}
    </table></div>
    <p class="hint">★は後半も買い持ちを上回ったもの。行をタップすると、その数値をフォームに入れて検証し直します。</p>`;
  $("swOut").querySelectorAll("tr.r").forEach(tr => tr.onclick = () => {
    const p = top[Number(tr.dataset.i)].params;
    for (const [k, v] of Object.entries(p)) { const el = $("bp_" + k); if (el) el.value = v; }
    $("btRun").click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

/* ---------- Notion に保存 ---------- */
$("btNotion").onclick = async () => {
  if (!lastBT) return;
  const { market: m, cfg, res, sweepRows, split } = lastBT, M = res.metrics, B = res.bench.metrics;
  const first = res.equity[0].d, last = res.equity[res.equity.length - 1].d;
  const syms = cfg.symbols.map(s => symLabel(m, s)).join("、");
  const page = {
    title: `バックテスト：${STRATEGIES[cfg.strategy].label}（${cfg.symbols.join("・")}）`,
    genre: "株・投資",
    summary: `${m === "JP" ? "日本株" : "米国株"} ${syms}。${paramText(cfg)}。${fmtD(first)}〜${fmtD(last)}で損益${pct(M.totalPct)}（年率${pct(M.cagrPct)}）、最大下落-${M.maxDDPct.toFixed(1)}%。買って持ち続けた場合は${pct(B.totalPct)}。`,
    sections: [
      { type: "h", text: "設定" },
      { type: "bullets", items: [
        `市場：${m === "JP" ? "日本株" : "米国株"}`, `銘柄：${syms}`, `戦略：${paramText(cfg)}`, `期間：${fmtD(first)}〜${fmtD(last)}`,
        `初期資金：${money(cfg.initialCash, m)}／売買単位：${cfg.lot}株`,
        `相場フィルター：${regimeText(cfg)}`,
        `損切り：${cfg.slPct ? cfg.slPct + "%" : "なし"}／利確：${cfg.tpPct ? cfg.tpPct + "%" : "なし"}／手数料：${cfg.feePct}%／滑り：${cfg.slipPct}%`,
        "約定：終値で判定し翌営業日の始値で約定（株ラボで計算）",
      ] },
      { type: "h", text: "成績" },
      { type: "table", rows: [["", "この戦略", "買って持ち続けた場合"],
        ["最終資産", money(M.final, m), money(B.final, m)], ["損益", pct(M.totalPct), pct(B.totalPct)], ["年率", pct(M.cagrPct), pct(B.cagrPct)],
        ["最大下落", "-" + M.maxDDPct.toFixed(1) + "%", "-" + B.maxDDPct.toFixed(1) + "%"], ["シャープ", M.sharpe.toFixed(2), B.sharpe.toFixed(2)],
        ["取引回数", M.trades + "回", B.trades + "回"], ["勝率", M.winPct == null ? "—" : M.winPct.toFixed(0) + "%", "—"]] },
      { type: "h", text: "直近の取引（20件）" },
      { type: "table", rows: [["日付", "銘柄", "売買", "株数", "約定値", "損益"], ...res.trades.slice(-20).reverse().map(t => [fmtD(t.d), t.symbol, t.side === "buy" ? "買" : "売", String(t.qty), price(t.price, m), t.pnl == null ? "" : money(t.pnl, m)])] },
      ...(sweepRows?.length ? [
        { type: "h", text: `総当たり（前半〜${fmtD(split)}の成績順・上位10）` },
        { type: "table", rows: [["組み合わせ", "前半", "後半", "後半の下落"], ...sweepRows.slice(0, 10).map(r => [shortParams(cfg.strategy, r.params), pct(r.inS.totalPct), pct(r.outS.totalPct), "-" + r.outS.maxDDPct.toFixed(1) + "%"])] },
      ] : []),
    ],
  };
  busy($("btNotion"), true, "保存中…");
  try { const r = await call("notion_save", { page }); toast("Notionに保存しました"); if (r.url) $("btNotion").dataset.url = r.url; }
  catch (e) { toast(e.message); }
  finally { busy($("btNotion"), false); }
};

/* ---------- 通知 ---------- */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
function u8(b64) { const p = "=".repeat((4 - b64.length % 4) % 4); const s = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function pushRefresh() {
  const st = $("pushState");
  if (!pushSupported()) {
    st.textContent = isIOS && !standalone() ? "iPhoneでは、Safariの共有ボタン →「ホーム画面に追加」で追加したアプリから開くと、通知をオンにできます。" : "この端末・ブラウザは通知に対応していません。";
    $("pushOn").classList.add("hidden"); $("pushTest").classList.add("hidden"); $("pushOff").classList.add("hidden"); return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const on = !!sub && Notification.permission === "granted";
  st.innerHTML = on ? `<span class="ok">この端末で通知オン</span>` : Notification.permission === "denied" ? `<span class="ng">通知が拒否されています。端末の設定から株ラボの通知を許可してください。</span>` : "この端末の通知はオフです。";
  $("pushOn").classList.toggle("hidden", on); $("pushTest").classList.toggle("hidden", !on); $("pushOff").classList.toggle("hidden", !on);
}
$("pushOn").onclick = async () => {
  busy($("pushOn"), true, "設定中…");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("通知が許可されませんでした");
    const { key } = await call("push_key");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== key) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(key) });
    await call("push_subscribe", { sub: sub.toJSON(), ua: navigator.userAgent });
    toast("通知をオンにしました");
  } catch (e) { toast(e.message); }
  finally { busy($("pushOn"), false); pushRefresh(); }
};
$("pushTest").onclick = async () => {
  busy($("pushTest"), true, "送信中…");
  try { await call("push_test"); toast("テスト通知を送りました"); } catch (e) { toast(e.message); }
  finally { busy($("pushTest"), false); }
};
$("pushOff").onclick = async () => {
  const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
  if (sub) { try { await call("push_unsubscribe", { endpoint: sub.endpoint }); } catch {} await sub.unsubscribe(); }
  toast("この端末の通知をオフにしました"); pushRefresh();
};

/* ---------- 模擬取引を始める ---------- */
$("btToPaper").onclick = () => {
  if (!lastBT) return;
  const { market: m, cfg } = lastBT;
  $("nbName").value = `${STRATEGIES[cfg.strategy].label}（${cfg.symbols.join("・")}）`.slice(0, 40);
  $("nbCashLab").textContent = m === "JP" ? "仮想の資金（円）" : "仮想の資金（ドル）";
  $("nbCash").value = String(cfg.initialCash);
  $("nbSummary").textContent = `${m === "JP" ? "日本株" : "米国株"}／${paramText(cfg)}／${cfg.symbols.map(s => symLabel(m, s)).join("、")}`
    + (cfg.slPct ? `／損切り${cfg.slPct}%` : "") + (cfg.tpPct ? `／利確${cfg.tpPct}%` : "");
  $("nbErr").textContent = "";
  $("newBot").classList.remove("hidden");
};
$("nbCreate").onclick = async () => {
  const { market: m, cfg } = lastBT;
  const n = id => Number(String($(id).value).replace(/[,\s]/g, ""));
  busy($("nbCreate"), true, "開始中…");
  $("nbErr").textContent = "";
  try {
    const r = await call("create_bot", { market: m, name: $("nbName").value, cfg: { ...cfg, initialCash: n("nbCash"), maxTradesPerDay: n("nbTrades"), maxDailyLossPct: n("nbDaily"), maxDrawdownPct: n("nbDD") } });
    $("newBot").classList.add("hidden");
    toast("模擬取引を始めました");
    await loadBots();
    switchView("vPaper");
    if (r.bot) openBot(r.bot.id);
  } catch (e) { $("nbErr").textContent = e.message; }
  finally { busy($("nbCreate"), false); }
};

/* ---------- 模擬取引の一覧と詳細 ---------- */
async function loadNames(m, syms) {
  const missing = syms.filter(s => !names[`${m}:${s}`]);
  if (!missing.length) return;
  const { data } = await sb.from("st_symbols").select("symbol,name").eq("market", m).in("symbol", missing);
  for (const r of data || []) if (r.name) names[`${m}:${r.symbol}`] = r.name;
}
const botEquity = b => { const s = b.state; let e = s.cash; for (const [k, p] of Object.entries(s.positions || {})) { const c = s.lastClose?.[k] ?? p.avg; e += p.short ? p.qty * (p.avg - c) : p.qty * c; } return e; };
const badge = b => b.active ? `<span class="badge on">● 稼働中</span>` : b.halted_reason ? `<span class="badge halt">安全装置で停止</span>` : `<span class="badge off">停止中</span>`;

async function loadBots() {
  const { data, error } = await sb.from("st_bots").select("*").order("created_at", { ascending: false });
  if (error) { $("botList").innerHTML = `<div class="err">${esc(error.message)}</div>`; return; }
  bots = data || [];
  const ids = bots.map(b => b.id);
  const sparks = {};
  if (ids.length) {
    const { data: eq } = await sb.from("st_equity").select("bot_id,d,equity").in("bot_id", ids).gte("d", isoAgo(120)).order("d").limit(1000);
    for (const r of eq || []) (sparks[r.bot_id] ||= []).push(r.equity);
  }
  if (!bots.length) {
    $("botList").innerHTML = `<div class="card empty">まだ模擬取引のボットはありません。<br>「検証」タブで戦略を試して、<br>「この設定で模擬取引を始める」を押してください。</div>`;
    $("stopAll").classList.add("hidden");
    $("cmpCard").classList.add("hidden");
    return;
  }
  $("stopAll").classList.toggle("hidden", !bots.some(b => b.active));
  loadCompare().catch(e => console.error(e));
  $("botList").innerHTML = bots.map(b => {
    const eq = botEquity(b), init = b.cfg.initialCash, pl = (eq / init - 1) * 100;
    return `<button class="bot" data-id="${b.id}">
      <div class="h"><div><div class="name">${esc(b.name)}</div><div class="sub">${b.market === "JP" ? "日本株" : "米国株"}・${esc(STRATEGIES[b.cfg.strategy]?.label || b.cfg.strategy)}・${b.state.lastDate ? fmtD(b.state.lastDate) + "時点" : ""}</div></div>
      <div><div class="eq">${money(eq, b.market)}</div><div class="pl ${cls(pl)}">${pct(pl, 2)}</div></div></div>
      ${spark(sparks[b.id] || [], pl >= 0)}
      ${badge(b)}
    </button>`;
  }).join("");
}
$("botList").addEventListener("click", e => { const b = e.target.closest(".bot"); if (b) openBot(b.dataset.id); });
$("stopAll").onclick = async () => {
  if (!confirm("稼働中のボットをすべて停止します。よろしいですか？")) return;
  try { await call("stop_all"); toast("すべて停止しました"); loadBots(); } catch (e) { toast(e.message); }
};

/* ---------- ボットの比較 ---------- */
const CMP_COLORS = ["#0f5c47", "#c0392b", "#2c6fbb", "#b7791f", "#7b4bb3", "#15181c", "#1a9c8c", "#d2577a"];
let cmpDays = 90, cmpData = null;
async function loadCompare() {
  if (bots.length < 2) { $("cmpCard").classList.add("hidden"); return; }
  const ids = bots.map(b => b.id), eq = {}, tr = {};
  for (let off = 0; off < 20000; off += 1000) {
    const { data } = await sb.from("st_equity").select("bot_id,d,equity").in("bot_id", ids).order("d").range(off, off + 999);
    for (const r of data || []) (eq[r.bot_id] ||= []).push({ d: r.d, v: r.equity });
    if (!data || data.length < 1000) break;
  }
  for (let off = 0; off < 20000; off += 1000) {
    const { data } = await sb.from("st_trades").select("bot_id").in("bot_id", ids).range(off, off + 999);
    for (const r of data || []) tr[r.bot_id] = (tr[r.bot_id] || 0) + 1;
    if (!data || data.length < 1000) break;
  }
  cmpData = { eq, tr };
  $("cmpCard").classList.remove("hidden");
  renderCompare();
}
function renderCompare() {
  if (!cmpData) return;
  const from = cmpDays ? isoAgo(cmpDays) : "0000";
  const rows = bots.map((b, i) => {
    const pts = (cmpData.eq[b.id] || []).filter(p => p.d >= from);
    if (!pts.length) return { b, color: CMP_COLORS[i % CMP_COLORS.length], pts: [], ret: null, dd: null };
    // 期間の最初の日の直前の資産（なければ元本）を基準にする
    const all = cmpData.eq[b.id], k = all.indexOf(pts[0]), base = k > 0 ? all[k - 1].v : b.cfg.initialCash;
    let peak = base, dd = 0;
    for (const p of pts) { peak = Math.max(peak, p.v); dd = Math.max(dd, (peak - p.v) / peak * 100); }
    return { b, color: CMP_COLORS[i % CMP_COLORS.length], pts: pts.map(p => ({ d: p.d, v: (p.v / base - 1) * 100 })), ret: (pts[pts.length - 1].v / base - 1) * 100, dd, days: pts.length };
  });
  $("cmpLegend").innerHTML = rows.map(r => `<span><i style="background:${r.color}"></i>${esc(r.b.name)}</span>`).join("");
  drawChart($("cmpChart"), rows.filter(r => r.pts.length).map(r => ({ pts: r.pts, color: r.color, width: 1.8, tipColor: "#fff" })), { m: "US", fmt: v => pct(v) });
  const sorted = rows.slice().sort((a, b) => (b.ret ?? -1e9) - (a.ret ?? -1e9));
  $("cmpTable").innerHTML = `<tr><th>ボット</th><th>損益</th><th>最大下落</th><th>取引</th></tr>` + sorted.map(r => `<tr class="r" data-id="${r.b.id}" style="cursor:pointer">
    <td style="font-family:inherit;white-space:normal"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${r.color};margin-right:6px"></i>${esc(r.b.name)}${r.b.active ? "" : `<span class="mu" style="font-size:11px">（停止）</span>`}</td>
    <td class="${cls(r.ret)}">${r.ret == null ? "—" : pct(r.ret, 2)}</td><td>${r.dd == null ? "—" : "-" + r.dd.toFixed(1) + "%"}</td><td>${cmpData.tr[r.b.id] || 0}回</td></tr>`).join("");
  $("cmpTable").querySelectorAll("tr.r").forEach(tr => tr.onclick = () => openBot(tr.dataset.id));
}
segInit("cmpRange", v => { cmpDays = Number(v); renderCompare(); });

let currentBot = null;
async function openBot(id) {
  const b = bots.find(x => x.id === id) || (await sb.from("st_bots").select("*").eq("id", id).single()).data;
  if (!b) return;
  currentBot = b;
  $("bsName").textContent = b.name;
  $("bsBody").innerHTML = `<div class="empty"><span class="spin"></span>読み込み中…</div>`;
  $("botSheet").classList.remove("hidden");
  const m = b.market, cfg = b.cfg, st = b.state;
  const [eqRes, trRes] = await Promise.all([
    (async () => { const out = []; for (let off = 0; ; off += 1000) { const { data } = await sb.from("st_equity").select("d,equity,cash").eq("bot_id", id).order("d").range(off, off + 999); out.push(...(data || [])); if (!data || data.length < 1000) break; } return out; })(),
    sb.from("st_trades").select("*").eq("bot_id", id).order("d", { ascending: false }).order("id", { ascending: false }).limit(300),
  ]);
  await loadNames(m, cfg.symbols);
  const eq = botEquity(b), pl = eq - cfg.initialCash;
  const pos = Object.entries(st.positions || {});
  const realized = (trRes.data || []).reduce((a, t) => a + (t.pnl || 0), 0);
  const ps = STRATEGIES[cfg.strategy]?.params.map(p => `${p.label.replace(/（.*）/, "")} ${cfg.params[p.key]}`).join("・");
  $("bsBody").innerHTML = `
    ${badge(b)}${b.halted_reason ? `<div class="notes">${esc(b.halted_reason)}</div>` : ""}
    <div class="card" style="margin-top:10px">
      <div class="kpis">
        <div class="kpi"><div class="k">評価額</div><div class="v">${money(eq, m)}</div><div class="s">元本 ${money(cfg.initialCash, m)}</div></div>
        <div class="kpi"><div class="k">損益</div><div class="v ${cls(pl)}">${pct(pl / cfg.initialCash * 100, 2)}</div><div class="s ${cls(pl)}">${money(pl, m)}</div></div>
        <div class="kpi"><div class="k">現金</div><div class="v">${money(st.cash, m)}</div><div class="s">確定損益 ${money(realized, m)}</div></div>
      </div>
      <div class="chartwrap"><svg class="chart" id="bsChart"></svg></div>
      ${b.last_message ? `<div class="msg">${esc(b.last_message)}${b.last_run_at ? `\n（最終更新 ${new Date(b.last_run_at).toLocaleString("ja-JP")}）` : ""}</div>` : ""}
    </div>
    <div class="card"><h2>保有株</h2>
      ${pos.length ? `<div class="tscroll"><table class="t"><tr><th>銘柄</th><th>株数</th><th>取得値</th><th>終値</th><th>評価損益</th></tr>${pos.map(([s, p]) => {
        const c = st.lastClose?.[s] ?? p.avg, u = (p.short ? p.avg - c : c - p.avg) * p.qty;
        return `<tr><td>${esc(symLabel(m, s))}${p.short ? `<span class="mu" style="font-size:11px">（空売り）</span>` : ""}</td><td>${p.qty.toLocaleString()}</td><td>${price(p.avg, m)}</td><td>${price(c, m)}</td><td class="${cls(u)}">${money(u, m)}<br><span style="font-size:11px">${pct((p.short ? 1 - c / p.avg : c / p.avg - 1) * 100)}</span></td></tr>`;
      }).join("")}</table></div>` : `<div class="empty">持っている株はありません</div>`}
    </div>
    <div class="card"><h2>次の営業日の注文</h2>
      ${(st.pending || []).length ? `<table class="t"><tr><th>銘柄</th><th>売買</th><th>理由</th></tr>${st.pending.map(o => `<tr><td>${esc(symLabel(m, o.symbol))}</td><td class="side-${o.side}">${/空売り/.test(o.reason) ? "空売り" : /買い戻し/.test(o.reason) || (o.side === "buy" && o.open === false) ? "買い戻し" : o.side === "buy" ? "買い" : "売り"}</td><td style="font-family:inherit">${esc(o.reason)}</td></tr>`).join("")}</table><p class="hint">始値で約定する想定です（模擬）。</p>` : `<div class="empty">注文はありません</div>`}
    </div>
    <div class="card"><h2>取引履歴</h2><div class="tscroll"><table class="t">${tradeTable(trRes.data || [], m)}</table></div></div>
    <div class="card"><h2>相場感（市況）</h2>
      <div class="seg" id="bsRg">${[["off", "使わない"], ["auto", "自動"], ["bull", "強気"], ["bear", "弱気"]].map(([v, l]) => `<button data-v="${v}" class="${(cfg.regime?.mode || "off") === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="hint">${(cfg.regime?.mode || "off") === "off" ? "相場フィルターは使っていません。「自動」は指数で判定、「強気」「弱気」は自分の相場感で固定します。" : `いまの判定：<b class="${st.regimeBear ? "dn" : "up"}">${st.regimeBear == null ? "次の更新で判定" : st.regimeBear ? "弱気" : "強気"}</b>（${esc(regimeText(cfg))}）`}</p>
      ${(cfg.regime?.mode || "off") !== "off" ? `<select id="bsRgAct" class="in" style="margin-top:8px">${Object.entries(RG_ACT).map(([v, l]) => `<option value="${v}" ${cfg.regime.action === v ? "selected" : ""}>弱気のとき：${l}</option>`).join("")}</select>` : ""}
    </div>
    <div class="card"><h2>設定</h2>
      <p class="hint" style="margin:0;line-height:1.8">${m === "JP" ? "日本株" : "米国株"}／${esc(paramText(cfg))}<br>
      銘柄：${cfg.symbols.map(s => esc(symLabel(m, s))).join("、")}<br>
      売買単位 ${cfg.lot}株／損切り ${cfg.slPct || "なし"}${cfg.slPct ? "%" : ""}／利確 ${cfg.tpPct || "なし"}${cfg.tpPct ? "%" : ""}／手数料 ${cfg.feePct}%／滑り ${cfg.slipPct}%<br>
      安全装置：1日${cfg.maxTradesPerDay}回まで・1日${cfg.maxDailyLossPct}%の損失で停止・最高値から${cfg.maxDrawdownPct}%下落で停止<br>
      開始 ${new Date(b.created_at).toLocaleDateString("ja-JP")}</p>
    </div>
    <div class="btns" style="margin-bottom:10px">
      ${b.active ? `<button class="btn ghost" id="bsRun">今すぐ更新</button><button class="btn ghost" id="bsStop">停止</button>` : `<button class="btn acc" id="bsResume">再開する</button>`}
    </div>
    <button class="btn danger" id="bsDelete">このボットを削除</button>`;
  drawChart($("bsChart"), [{ pts: (eqRes || []).map(e => ({ d: e.d, v: e.equity })), color: "#0f5c47", width: 2, tipColor: "#7fe0bd" }], { m });
  const act = async (btn, label, fn) => { busy(btn, true, label); try { await fn(); await loadBots(); await openBot(id); } catch (e) { toast(e.message); busy(btn, false); } };
  $("bsRg").onclick = async e => {
    const btn = e.target.closest("button"); if (!btn || btn.classList.contains("on")) return;
    try { await call("set_regime", { id, regime: { mode: btn.dataset.v } }); toast("相場感を変更しました"); await loadBots(); await openBot(id); } catch (err) { toast(err.message); }
  };
  $("bsRgAct") && ($("bsRgAct").onchange = async e => {
    try { await call("set_regime", { id, regime: { action: e.target.value } }); toast("変更しました"); await loadBots(); await openBot(id); } catch (err) { toast(err.message); }
  });
  $("bsRun") && ($("bsRun").onclick = () => act($("bsRun"), "更新中…", async () => { const r = await call("run_bot", { id }); toast(r.result.processed ? `${r.result.processed}日分を処理しました` : "新しい株価はまだありません"); }));
  $("bsStop") && ($("bsStop").onclick = () => act($("bsStop"), "停止中…", () => call("set_active", { id, active: false })));
  $("bsResume") && ($("bsResume").onclick = () => {
    if (!confirm("再開します。止めていた間の日はさかのぼらず、次の株価から判定を再開します。")) return;
    act($("bsResume"), "再開中…", () => call("set_active", { id, active: true }));
  });
  $("bsDelete").onclick = async () => {
    if (!confirm(`「${b.name}」と取引履歴を削除します。元に戻せません。`)) return;
    const { error } = await sb.from("st_bots").delete().eq("id", id);
    if (error) { toast(error.message); return; }
    $("botSheet").classList.add("hidden"); toast("削除しました"); loadBots();
  };
}
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $(b.dataset.close).classList.add("hidden"));

/* ---------- 市況 ---------- */
// 目安の水準：[平常の上限, 警戒の上限]
const VOL_LEVEL = { VIX: [20, 30], NKVI: [25, 35] };
const VOL_DESC = { VIX: "米国株（S&P500）の今後1か月の値動きの見込み。20未満は平常、30超は強い警戒。", NKVI: "日経平均の今後1か月の値動きの見込み。ふだんは20〜30あたり、30を大きく超えると荒れ模様。" };
async function loadMarket() {
  const from = isoAgo(420), out = [];
  const [ix, us, jp] = await Promise.allSettled([getBars("IX", ["NKVI", "VIX"], from), getBars("US", ["SPY"], isoAgo(700)), getBars("JP", ["1306"], isoAgo(700))]);
  const charts = [];
  if (ix.status === "fulfilled") {
    for (const s of ["NKVI", "VIX"]) {
      const b = ix.value.data[s];
      if (!b?.length) { out.push(`<div class="card"><h2>${VOL_NAME[s]}</h2><div class="err">${esc(ix.value.errors[s] || "取得できませんでした")}</div></div>`); continue; }
      const last = b[b.length - 1], prev = b[b.length - 2] || last, [lo, hi] = VOL_LEVEL[s], ch = last.c - prev.c;
      const lv = last.c < lo ? ["calm", "平常"] : last.c < hi ? ["warn", "警戒"] : ["hot", "強い警戒"];
      const yr = b.slice(-250).map(x => x.c), rank = yr.filter(x => x <= last.c).length / yr.length * 100;
      out.push(`<div class="card"><h2>${VOL_NAME[s]} <span class="mu num" style="font-size:12px;font-weight:400">${fmtD(last.d)}</span></h2>
        <div class="mk"><div><span class="big">${last.c.toFixed(2)}</span> <span class="num ${ch > 0 ? "dn" : "up"}" style="font-size:13px">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}</span></div><span class="lv ${lv[0]}">${lv[1]}</span></div>
        <p class="hint" style="margin:0 0 6px">${VOL_DESC[s]} この1年では下から <b class="num">${rank.toFixed(0)}%</b> の位置。</p>
        <div class="chartwrap"><svg class="chart" id="mk_${s}"></svg></div></div>`);
      charts.push(() => drawChart($("mk_" + s), [{ pts: b.slice(-250).map(x => ({ d: x.d, v: x.c })), color: "#15181c", width: 1.6 }], { m: "US", fmt: v => v.toFixed(2) }));
    }
  } else out.push(`<div class="card"><h2>恐怖指数</h2><div class="err">${esc(ix.reason?.message || "取得できませんでした")}</div></div>`);
  const trend = (res, sym, label) => {
    const b = res.status === "fulfilled" ? res.value.data[sym] : null;
    if (!b?.length) return `<div class="keyrow"><span>${label}</span><span class="mu">取得できません</span></div>`;
    const n = b.length >= 200 ? 200 : b.length >= 100 ? 100 : 0;
    if (!n) return `<div class="keyrow"><span>${label}</span><span class="mu">データ不足</span></div>`;
    const ma = b.slice(-n).reduce((a, x) => a + x.c, 0) / n, last = b[b.length - 1], diff = (last.c / ma - 1) * 100;
    return `<div class="keyrow"><span>${label}<br><span class="mu" style="font-size:12px">${n}日線との差 <span class="num">${pct(diff)}</span>・${fmtD(last.d)}</span></span><span class="${diff > 0 ? "ok" : "ng"}">${diff > 0 ? "強気" : "弱気"}</span></div>`;
  };
  out.push(`<div class="card"><h2>指数のトレンド</h2>${trend(jp, "1306", "日本株（TOPIX連動ETF 1306）")}${trend(us, "SPY", "米国株（S&P500 ETF SPY）")}
    <p class="hint">相場フィルターの「指数の移動平均」と同じ見方です。日本株は無料プランのため約12週間遅れのデータです。</p></div>`);
  $("mktBody").innerHTML = out.join("");
  charts.forEach(f => f());
}

/* ---------- 設定 ---------- */
async function loadStatus() {
  try {
    const s = await call("status");
    const row = (label, ok) => `<div class="keyrow"><span>${label}</span><span class="${ok ? "ok" : "ng"}">${ok ? "接続済み" : "未設定"}</span></div>`;
    $("keyStatus").innerHTML = row("日本株（J-Quants）", s.jquants) + row("米国株（Tiingo）", s.tiingo) + row("Notion", s.notion)
      + (!s.jquants || !s.tiingo ? `<p class="hint">未設定のものは、下の手順でAPIキーを登録してください。登録後すぐに使えます。</p>` : "");
  } catch (e) { $("keyStatus").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---------- 画面切り替え ---------- */
function switchView(v) {
  ["vBT", "vPaper", "vMkt", "vSet"].forEach(x => $(x).classList.toggle("hidden", x !== v));
  [...$("tabs").children].forEach(b => b.classList.toggle("on", b.dataset.v === v));
  if (v === "vPaper") loadBots();
  if (v === "vMkt") loadMarket();
  if (v === "vSet") { loadStatus(); pushRefresh().catch(() => {}); }
  window.scrollTo(0, 0);
}
$("tabs").addEventListener("click", e => { const b = e.target.closest("button"); if (b) switchView(b.dataset.v); });

/* ---------- auth ---------- */
$("authForm").onsubmit = async e => {
  e.preventDefault();
  $("authBtn").disabled = true; $("authMsg").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) $("authMsg").textContent = error.message.includes("Invalid login") ? "メールアドレスかパスワードが違います。" : "エラー：" + error.message;
  $("authBtn").disabled = false;
};
$("logout").onclick = () => sb.auth.signOut();

let authReady = false;
sb.auth.onAuthStateChange((_ev, session) => {
  const u = session?.user ?? null;
  if (authReady && u?.id === user?.id) return;
  authReady = true; user = u;
  $("auth").classList.toggle("hidden", !!user);
  $("app").classList.toggle("hidden", !user);
  $("tabs").classList.toggle("hidden", !user);
  if (user) { $("whoami").textContent = `${user.email} でログイン中`; if (location.hash === "#paper") switchView("vPaper"); }
});

/* ---------- 初期化 ---------- */
$("btStrategy").innerHTML = Object.entries(STRATEGIES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
$("btStrategy").onchange = renderParams;
$("btRgMode").onchange = () => $("btRgBox").classList.toggle("hidden", $("btRgMode").value !== "auto");
$("btRgRule").onchange = () => { const r = $("btRgRule").value; $("btRgMaBox").classList.toggle("hidden", r === "vol"); $("btRgVolBox").classList.toggle("hidden", r === "ma"); };
$("btRgVolSym").onchange = () => { $("btRgVolTh").value = $("btRgVolSym").value === "NKVI" ? "30" : "25"; };
segInit("btMarket", setMarket);
segInit("btPeriod", v => period = Number(v));
setMarket("JP");
renderParams();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
