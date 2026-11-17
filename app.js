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

/* ---------- 戦略のくわしい説明 ---------- */
const STRAT_HELP = {
  sma: { how: "直近の終値の平均（移動平均）を短期と長期の2本で見ます。短期が長期を上に抜けたら「上向きに変わった」とみて買い（ゴールデンクロス）、下に抜けたら売ります（デッドクロス）。", good: "上昇や下落が数か月続く、流れのはっきりした相場。大きな上昇に長く乗れます。", weak: "上下を行ったり来たりするもみ合い。買ってすぐ売る「だまし」が続き、小さな負けが積み重なります。", tip: "日数を短くすると反応は早いがだましが増え、長くすると遅いが落ち着きます。定番は 5と25、25と75、50と200。" },
  rsi: { how: "RSIは、直近の値上がり幅と値下がり幅の比から「買われすぎ・売られすぎ」を0〜100で表す指標です。低い（売られすぎ）ところで買い、高い（買われすぎ）ところで売ります。", good: "一定の幅で上下するもみ合い相場、長期では上向きの銘柄の一時的な下げ。", weak: "強い下落が続く相場。売られすぎのまま下がり続け、早く買いすぎます。", tip: "「買い」を30→20に下げると回数は減りますが、より深い下げだけを拾います。損切りか相場フィルターと組み合わせると、下落相場での傷を抑えられます。" },
  breakout: { how: "終値が過去N日の高値を超えたら「新しい上昇が始まった」とみて買い、過去M日の安値を割ったら売ります。有名な「タートル流」の考え方です。", good: "長いもみ合いを抜けて大きく動き出す場面、強い上昇相場。", weak: "高値を少し超えてはすぐ戻る相場。高いところで買って安く売ることになります。", tip: "勝率は低め（3〜4割）でも、たまの大きな勝ちで取り返す戦略です。負けが続いても続けられる量で。買い20日・売り10日が定番。" },
  boll: { how: "移動平均の上下に、値動きの大きさ（標準偏差σ）で幅をつけた帯がボリンジャーバンドです。終値が下の帯を割ったら「下げすぎ」とみて買い、平均線まで戻ったら売ります。", good: "もみ合い相場、急落のあとの戻り。", weak: "悪材料で下げが続くとき。帯に沿って下がり続ける「バンドウォーク」で損が膨らみます。", tip: "倍率を2→2.5や3にすると、めったにない大きな下げだけを拾います。損切りを必ず入れたい戦略です。" },
  macd: { how: "短期と長期の平均（最近の値を重く見るEMA）の差がMACDです。MACDが、その平均である「シグナル線」を上に抜けたら買い、下に抜けたら売ります。勢いの変わり目を見ます。", good: "流れが出始めた初動。移動平均クロスより早く反応します。", weak: "もみ合い。小さな上下で何度も売買してしまいます。", tip: "12・26・9が世界中で使われている標準です。「トレンド条件（200日線より上）」と組み合わせると、下落相場での買いを減らせます。" },
  roc: { how: "N日前の株価と比べて、基準より上がっていれば持ち、下回ったら売ります。「上がっているものは、しばらく上がり続けやすい」という性質（モメンタム）を使います。", good: "強い銘柄がさらに強くなる相場、指数ETFの長期の上昇。", weak: "流れが急に反転する場面。高値で持ったまま下げを受けます。", tip: "比較を60日より120日・200日と長くすると、売買は減って大きな流れだけに乗ります。複数銘柄に入れると、強い銘柄だけを持つ形になります。" },
  stoch: { how: "直近N日の高値と安値の幅の中で、今の終値がどの位置にあるか（%K）を0〜100で見ます。下のほうで買い、上のほうで売ります。RSIより敏感に動きます。", good: "短い周期で上下するもみ合い相場。", weak: "一方向に強く動く相場。下げ続ける途中で何度も買ってしまいます。", tip: "売買回数が多くなりやすいので、手数料と滑りを入れて確かめてください。期間を長くすると落ち着きます。" },
  tma: { how: "短期・中期・長期の3本の移動平均が、上から短期＞中期＞長期の順に並んだとき（パーフェクトオーダー）だけ持ちます。並びが崩れたら売ります。", good: "きれいな上昇が長く続く相場。だましが少なく、持っている間は安心感があります。", weak: "上昇の初動と終わり。入るのも出るのも遅く、短い上昇は取り逃します。", tip: "売買は少なめ。5・25・75が定番です。回数が少なすぎるときは、短い組み合わせ（5・10・25など）に。" },
  dip: { how: "終値がN日続けて下がったら「下げすぎの反発」を狙って買い、短い移動平均を上回ったら売ります。数日で終わる短い売買です。", good: "長期では上向きの銘柄や指数ETFの、一時的な下げ。", weak: "下落相場の入り口。続落がそのまま大きな下げにつながります。", tip: "「トレンド条件（200日線より上）」や相場フィルターと組み合わせるのが基本です。1回の利益は小さいので、手数料と滑りの影響を確かめてください。" },
  tom: { how: "月末から月初の数日だけ持ちます。給料日後の積立や投信の買いが月の変わり目に入りやすい、という経験則（月替わり効果）を使います。", good: "相場全体が落ち着いているとき。指数ETF向きです。", weak: "個別の悪材料や急落。日付だけで買うので、相場の状態は見ていません。", tip: "持つ日数が短いぶん、資金が市場にさらされる時間も短い戦略です。相場フィルターと組み合わせると、荒れた月を避けられます。" },
  fear: { how: "恐怖指数（VIX・日経平均VI）が高い＝みんなが怖がって売っているとき、に買い、落ち着いたら売ります。「総悲観は買い」の考え方です。", good: "急落のあと。過去の米国株では、恐怖指数が高い日のあとの成績は平均より良い傾向でした。", weak: "金融危機のように、恐怖が長く続いて下げ続ける局面。早く入りすぎます。", tip: "機会は年に数回です。指数ETFで使うのが素直。「仕掛け」を上げるほど回数は減り、深い下げだけを拾います。" },
  fearpeak: { how: "恐怖指数が高くなったあと、直近20日の高値から一定の割合だけ下がったのを確かめてから買います。「怖さのピークが過ぎた」のを待つ、慎重な入り方です。", good: "急落からの回復。下げの途中で買ってしまう失敗を減らせます。", weak: "V字で一気に戻る相場。待っている間に、戻りの最初を取り逃します。", tip: "「恐怖指数の逆張り」と結果を比べてみてください。下落を小さくしたいならこちら、戻りを全部取りたいなら逆張り、という使い分けです。" },
  hold: { how: "最初に買って、そのまま持ち続けます。売買はしません。", good: "長期で上がる市場。手数料も手間もかからず、多くの戦略はこれに勝てません。", weak: "長い下落相場。下げをそのまま受けます。", tip: "ほかの戦略の「ものさし」です。結果の画面の「買って持ち続けた場合」と同じものです。" },
};

/* ---------- 相場フィルターの条件 ---------- */
// 条件のひな形。make(市場, 数値) で エンジン用の条件にする。role は初期の使い方（avoid=控える / only=この時だけ）
const tr = (key, cond) => (m, v) => ({ kind: "trend", key: typeof key === "function" ? key(m) : key, ma: v, cond });
const rt = (key, dir, days = 180) => (m, v) => ({ kind: "rate", key, dir, days, th: v });
const dd = op => (m, v) => ({ kind: "dd", key: idxKey(m), op, days: 250, th: v });
const idxName = m => m === "JP" ? "TOPIX（1306）" : "S&P500（SPY）";
const idxKey = m => m === "JP" ? "JP:1306" : "US:SPY", fearKey = m => m === "JP" ? "IX:NKVI" : "IX:VIX";
const RG_PRESETS = {
  idxdown: { group: "株", label: "株価指数が下向き", sub: m => `${m === "JP" ? "TOPIX（1306）" : "S&P500（SPY）"}が移動平均より下`, unit: "移動平均（日）", def: () => 200, byMarket: true, role: "avoid", make: tr(idxKey, "below") },
  idxup: { group: "株", label: "株価指数が上向き", sub: m => `${m === "JP" ? "TOPIX（1306）" : "S&P500（SPY）"}が移動平均より上`, unit: "移動平均（日）", def: () => 200, byMarket: true, role: "only", make: tr(idxKey, "above") },
  fearhigh: { group: "株", label: "恐怖指数が高い", sub: m => `${m === "JP" ? "日経平均VI" : "VIX"}がこの値より上`, unit: "この値を超えたら", def: m => m === "JP" ? 30 : 25, byMarket: true, role: "avoid", make: (m, v) => ({ kind: "level", key: fearKey(m), op: "gt", th: v }) },
  fearlow: { group: "株", label: "恐怖指数が低い", sub: m => `${m === "JP" ? "日経平均VI" : "VIX"}がこの値より下`, unit: "この値を下回ったら", def: m => m === "JP" ? 20 : 15, byMarket: true, role: "only", make: (m, v) => ({ kind: "level", key: fearKey(m), op: "lt", th: v }) },
  correction: { group: "株", label: "調整局面（高値から大きく下落）", sub: m => `${idxName(m)}が直近1年の高値からこの%以上下げている`, unit: "高値からの下落（%）", def: () => 10, role: "avoid", make: dd("gt") },
  nearhigh: { group: "株", label: "高値圏（1年の高値に近い）", sub: m => `${idxName(m)}が直近1年の高値からこの%以内`, unit: "高値からの差（%以内）", def: () => 3, role: "only", make: dd("lt") },
  techup: { group: "株", label: "ハイテク株が強い", sub: () => "ナスダック100 ETF（QQQ）が移動平均より上", unit: "移動平均（日）", def: () => 200, role: "only", make: tr("US:QQQ", "above") },
  smallup: { group: "株", label: "小型株が強い（リスクを取る空気）", sub: () => "米国小型株ETF（IWM）が移動平均より上", unit: "移動平均（日）", def: () => 200, role: "only", make: tr("US:IWM", "above") },
  credit: { group: "株", label: "信用不安（低格付け社債が売られている）", sub: () => "ハイイールド債ETF（HYG）が移動平均より下", unit: "移動平均（日）", def: () => 200, role: "avoid", make: tr("US:HYG", "below") },
  hike: { group: "金利", label: "利上げ局面（米国）", sub: () => "米国の政策金利が半年前より上がっている", unit: "半年の上げ幅（%）", def: () => 0.25, role: "avoid", make: rt("IX:FF", "up") },
  cut: { group: "金利", label: "利下げ局面（米国）", sub: () => "米国の政策金利が半年前より下がっている", unit: "半年の下げ幅（%）", def: () => 0.25, role: "only", make: rt("IX:FF", "down") },
  jhike: { group: "金利", label: "利上げ局面（日本）", sub: () => "日本の短期金利が半年前より上がっている（月次）", unit: "半年の上げ幅（%）", def: () => 0.1, role: "avoid", make: rt("IX:JPR", "up") },
  jcut: { group: "金利", label: "利下げ局面（日本）", sub: () => "日本の短期金利が半年前より下がっている（月次）", unit: "半年の下げ幅（%）", def: () => 0.1, role: "only", make: rt("IX:JPR", "down") },
  y10up: { group: "金利", label: "長期金利が上昇している", sub: () => "米国の10年金利が3か月前より上がっている", unit: "3か月の上げ幅（%）", def: () => 0.5, role: "avoid", make: rt("IX:US10Y", "up", 90) },
  y10down: { group: "金利", label: "長期金利が低下している", sub: () => "米国の10年金利が3か月前より下がっている", unit: "3か月の下げ幅（%）", def: () => 0.5, role: "only", make: rt("IX:US10Y", "down", 90) },
  invert: { group: "景気・物価", label: "逆イールド（景気後退のサイン）", sub: () => "米国の10年金利−2年金利がこの値より下", unit: "この値より下（%）", def: () => 0, zero: true, role: "avoid", make: (m, v) => ({ kind: "level", key: "IX:T10Y2Y", op: "lt", th: v }) },
  unemp: { group: "景気・物価", label: "景気悪化（失業率が上昇）", sub: () => "米国の失業率が1年前より上がっている（月次）", unit: "1年の上げ幅（%）", def: () => 0.5, role: "avoid", make: rt("IX:UNRATE", "up", 365) },
  infup: { group: "景気・物価", label: "インフレ懸念が強まっている", sub: () => "米国の期待インフレ率（10年）が半年前より上がっている", unit: "半年の上げ幅（%）", def: () => 0.2, role: "avoid", make: rt("IX:BEI", "up") },
  infdown: { group: "景気・物価", label: "インフレ懸念が和らいでいる", sub: () => "米国の期待インフレ率（10年）が半年前より下がっている", unit: "半年の下げ幅（%）", def: () => 0.2, role: "only", make: rt("IX:BEI", "down") },
  yenweak: { group: "為替・原油", label: "円安が進んでいる", sub: () => "ドル円が移動平均より上", unit: "移動平均（日）", def: () => 200, role: "only", make: tr("IX:USDJPY", "above") },
  yenstrong: { group: "為替・原油", label: "円高が進んでいる", sub: () => "ドル円が移動平均より下", unit: "移動平均（日）", def: () => 200, role: "avoid", make: tr("IX:USDJPY", "below") },
  oilup: { group: "為替・原油", label: "原油が上がっている", sub: () => "原油（WTI）が移動平均より上", unit: "移動平均（日）", def: () => 200, role: "avoid", make: tr("IX:WTI", "above") },
  oildown: { group: "為替・原油", label: "原油が下がっている", sub: () => "原油（WTI）が移動平均より下", unit: "移動平均（日）", def: () => 200, role: "only", make: tr("IX:WTI", "below") },
  sellmay: { group: "季節", label: "5〜10月（セル・イン・メイ）", sub: () => "株が弱いと言われる時期", def: () => 1, role: "avoid", make: () => ({ kind: "season", m1: 5, m2: 10 }) },
  yearend: { group: "季節", label: "11〜4月（株が強いと言われる時期）", sub: () => "年末から春にかけて", def: () => 1, role: "only", make: () => ({ kind: "season", m1: 11, m2: 4 }) },
  goldup: { group: "金・債券", label: "金が上がっている", sub: () => "金ETF（GLD）が移動平均より上", unit: "移動平均（日）", def: () => 200, role: "avoid", make: tr("US:GLD", "above") },
  golddown: { group: "金・債券", label: "金が下がっている", sub: () => "金ETF（GLD）が移動平均より下", unit: "移動平均（日）", def: () => 200, role: "only", make: tr("US:GLD", "below") },
  bondup: { group: "金・債券", label: "債券が上がっている", sub: () => "米国の長期国債ETF（TLT）が移動平均より上（＝長期金利は低下）", unit: "移動平均（日）", def: () => 200, role: "only", make: tr("US:TLT", "above") },
  bonddown: { group: "金・債券", label: "債券が下がっている", sub: () => "米国の長期国債ETF（TLT）が移動平均より下（＝長期金利は上昇）", unit: "移動平均（日）", def: () => 200, role: "avoid", make: tr("US:TLT", "below") },
};
const RG_MAX = 8;
let rgRows = []; // { preset, role, val, market }
// 日本株で米国のデータを見る条件は、前日までの値で判定する（米国の終値は日本の引け後に出る）
const usTimed = key => !key.startsWith("JP:") && key !== "IX:NKVI" && key !== "IX:JPR";
const rgFilter = (r, m) => { const f = RG_PRESETS[r.preset].make(m, Number(r.val)); return { ...f, role: r.role, lag: !!f.key && m === "JP" && usTimed(f.key) }; };
function renderRg() {
  $("rgList").innerHTML = rgRows.map((r, i) => {
    const P = RG_PRESETS[r.preset];
    return `<div class="rgrow"><div class="t"><span>${esc(P.label)}<small>${esc(P.sub(market))}</small></span><button class="x" data-del="${i}" aria-label="この条件を消す">×</button></div>
      <div class="g"><div><label class="lab" for="rgRole${i}">この条件のとき</label><select class="in" id="rgRole${i}" data-role="${i}"><option value="avoid" ${r.role === "avoid" ? "selected" : ""}>売買を控える</option><option value="only" ${r.role === "only" ? "selected" : ""}>この時だけ売買する</option></select></div>
      ${P.unit ? `<div><label class="lab" for="rgVal${i}">${esc(P.unit)}</label><input class="in num" id="rgVal${i}" data-val="${i}" inputmode="decimal" value="${esc(String(r.val))}"></div>` : ""}</div></div>`;
  }).join("");
  const used = new Set(rgRows.map(r => r.preset)), groups = {};
  for (const [k, P] of Object.entries(RG_PRESETS)) (groups[P.group] ||= []).push(`<option value="${k}" ${used.has(k) ? "disabled" : ""}>${esc(P.label)}</option>`);
  $("rgAdd").innerHTML = `<option value="">＋ 条件を追加する…</option>` + Object.entries(groups).map(([g, o]) => `<optgroup label="${g}">${o.join("")}</optgroup>`).join("");
  $("rgAdd").disabled = rgRows.length >= RG_MAX;
  $("rgActBox").classList.toggle("hidden", !rgRows.length);
  $("rgHint").textContent = !rgRows.length ? "条件を足さなければ、相場フィルターは使いません。条件は組み合わせて使えます（例：利下げ局面の「時だけ」＋恐怖指数が高い時は「控える」）。"
    : `${rgRows.length > 1 ? "条件のどれか1つでも売買しない側に当てはまる日を" : "売買しない側に当てはまる日を"}「弱気」とみなして、上の動きをします。空売りのときは逆で、「弱気」の日だけ仕掛けます。${market === "JP" && rgRows.some(r => rgFilter(r, market).lag) ? "米国のデータを見る条件は、前日までの値で判定します。" : ""}`;
}

/* ---------- バックテスト画面 ---------- */
function setMarket(m) {
  market = m;
  $("btSymbols").placeholder = m === "JP" ? "7203, 6758" : "AAPL, MSFT";
  $("btSymHint").textContent = m === "JP" ? "4桁の銘柄コード（例：7203 トヨタ、6758 ソニーG）" : "ティッカー（例：AAPL アップル、MSFT マイクロソフト、SPY S&P500 ETF）";
  $("btCashLab").textContent = m === "JP" ? "初期資金（円）" : "初期資金（ドル）";
  $("btFearSym").value = m === "JP" ? "NKVI" : "VIX";
  // 市場で変わる条件（株価指数・恐怖指数）は、初期値のままなら新しい市場の初期値に合わせる
  for (const r of rgRows) { const P = RG_PRESETS[r.preset]; if (P.byMarket && r.val === P.def(r.market)) r.val = P.def(m); r.market = m; }
  renderRg();
  $("btCash").value = m === "JP" ? "1000000" : "10000";
  $("btLot").value = m === "JP" ? "100" : "1";
  $("btLotList").innerHTML = (m === "JP" ? [100, 10, 1] : [1, 5, 10]).map(v => `<option value="${v}">`).join("");
  $("btLotHint").textContent = m === "JP" ? "株数をこの単位にそろえます。100＝単元株、1＝単元未満株（S株・かぶミニ）。10 など好きな数も入れられます。" : "株数をこの単位にそろえます。米国株は1株から買えます。";
  renderSize(true);
}
// 1回に買う量の決め方
const SIZE = {
  pct: { lab: "1銘柄に使う上限（%）", def: () => 100, hint: "資産のこの割合までを1銘柄に使います。複数銘柄のときは、銘柄数で等分した額と小さいほうです。資産が増減すると買う量も一緒に変わります。迷ったらこれ。" },
  cash: { lab: m => `1回の金額（${m === "JP" ? "円" : "ドル"}）`, def: m => m === "JP" ? 300000 : 3000, hint: "毎回この金額ぶんだけ買います。勝っても負けても買う量を変えたくないとき、少額で試したいときに。" },
  shares: { lab: "1回の株数", def: () => Number($("btLot").value) || 1, hint: "毎回この株数だけ買います。実際に自分が買う株数に合わせて試したいときに。株価が高い銘柄ほど金額が大きくなる点に注意。" },
  risk: { lab: "1回で負けてよい額（資産の%）", def: () => 1, hint: "損切りにかかったときの損が、資産のこの割合になるように株数を逆算します（例：資産100万円・1%・損切り5%なら、20万円ぶん買う）。損切り幅が広いほど買う量が減ります。「細かい設定」で損切りを入れてください。" },
};
const sizeText = (cfg, m) => cfg.sizeMode === "cash" && cfg.sizeVal ? `1回 ${money(cfg.sizeVal, m)}` : cfg.sizeMode === "shares" && cfg.sizeVal ? `1回 ${cfg.sizeVal}株` : cfg.sizeMode === "risk" && cfg.sizeVal ? `損切り時の損が資産の${cfg.sizeVal}%になる量` : `資産の${cfg.maxPosPct}%まで`;
function renderSize(reset) {
  const S = SIZE[$("btSize").value];
  $("btSizeLab").textContent = typeof S.lab === "function" ? S.lab(market) : S.lab;
  $("btSizeHint").textContent = S.hint;
  if (reset) $("btSizeVal").value = String(S.def(market));
}
function renderParams() {
  const st = STRATEGIES[$("btStrategy").value];
  $("btDesc").textContent = st.desc;
  const H = STRAT_HELP[$("btStrategy").value];
  $("btHelp").innerHTML = H ? `<dl><dt>しくみ</dt><dd>${H.how}</dd><dt>向いている相場</dt><dd>${H.good}</dd><dt>苦手な相場</dt><dd>${H.weak}</dd><dt>使い方のコツ</dt><dd>${H.tip}</dd></dl>` : "";
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
    initialCash: n("btCash"), lot: n("btLot"), sizeMode: $("btSize").value, sizeVal: $("btSize").value === "pct" ? 0 : n("btSizeVal"), slPct: n("btSl"), tpPct: n("btTp"),
    feePct: n("btFee"), slipPct: n("btSlip"), maxPosPct: $("btSize").value === "pct" ? n("btSizeVal") : 100, trendMa: n("btTrend"),
    side: $("btSide").value, borrowPct: n("btBorrow"),
    fearSym: STRATEGIES[strategy].needsVol ? $("btFearSym").value : "", fearLag: market === "JP" && $("btFearSym").value === "VIX",
    regime: { mode: rgRows.length ? "auto" : "off", action: $("btRgAct").value, filters: rgRows.map(r => rgFilter(r, market)) },
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
  if (rgRows.some(r => RG_PRESETS[r.preset].zero ? !Number.isFinite(Number(r.val)) : !(Number(r.val) > 0))) { $("btErr").textContent = "相場フィルターの数値を入れてください"; return; }
  if ($("btSize").value !== "pct" && !(cfg.sizeVal > 0)) { $("btErr").textContent = "「資金と買う量」の数値を入れてください"; return; }
  if (cfg.sizeMode === "risk" && !(cfg.slPct > 0)) { $("btErr").textContent = "「損切り幅から逆算」を使うときは、細かい設定で損切り（%）を入れてください"; return; }
  busy($("btRun"), true, "株価を取得して計算中…");
  try {
    const start = period ? isoAgo(Math.round(period * 365.25)) : null;
    const from = start ? isoAgo(Math.round(period * 365.25) + 600) : null; // シグナルの助走分も取る
    const { data, errors } = await getBars(market, cfg.symbols, from);
    // 相場フィルターの条件と、恐怖指数を使う戦略のデータ。data["US:GLD"] のような名前で足す
    for (const key of new Set([...cfg.regime.filters.map(f => f.key).filter(Boolean), ...(cfg.fearSym ? ["IX:" + cfg.fearSym] : [])])) {
      const [km, ks] = key.split(":"), v = await getBars(km, [ks], from);
      if (!v.data[ks]?.length) throw new Error(`${keyName(key)} のデータが取得できませんでした${v.errors[ks] ? "：" + v.errors[ks] : ""}`);
      data[key] = v.data[ks];
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
const KEY_NAME = { "JP:1306": "TOPIX（1306）", "US:SPY": "S&P500（SPY）", "US:GLD": "金（GLD）", "US:TLT": "米国長期債（TLT）", "IX:VIX": "VIX", "IX:NKVI": "日経平均VI", "IX:FF": "米国の政策金利", "IX:JPR": "日本の短期金利", "US:QQQ": "ナスダック100（QQQ）", "US:IWM": "米国小型株（IWM）", "US:HYG": "ハイイールド債（HYG）", "IX:USDJPY": "ドル円", "IX:US10Y": "米国の10年金利", "IX:T10Y2Y": "米国の長短金利差", "IX:WTI": "原油（WTI）", "IX:BEI": "米国の期待インフレ率", "IX:UNRATE": "米国の失業率" };
const keyName = k => KEY_NAME[k] || String(k).split(":").pop();
const filterText = f => {
  const what = f.kind === "season" ? `${f.m1}〜${f.m2}月`
    : f.kind === "dd" ? `${keyName(f.key)}が高値から${f.th}%${f.op === "gt" ? "以上下落" : "以内"}`
    : f.kind === "trend" ? `${keyName(f.key)}が${f.ma}日線より${f.cond === "above" ? "上" : "下"}`
    : f.kind === "level" ? `${keyName(f.key)}が${f.th}${f.op === "gt" ? "超" : "未満"}`
    : `${keyName(f.key)}が約${Math.round(f.days / 30)}か月で${f.th}%以上${f.dir === "up" ? "上昇" : "低下"}`;
  return `${what}${f.lag ? "（前日まで）" : ""}${f.role === "only" ? "の時だけ売買" : "なら控える"}`;
};
const regimeText = cfg => {
  const r = cfg.regime || { mode: "off" };
  if (r.mode === "off") return "使わない";
  const act = `弱気のとき：${RG_ACT[r.action] || RG_ACT.nobuy}`;
  if (r.mode === "bull") return "強気で固定";
  if (r.mode === "bear") return `弱気で固定／${act}`;
  const fs = r.filters || [];
  return fs.length ? `${fs.map(filterText).join("、")}／${act}` : "条件なし（いつも強気）";
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
        `初期資金：${money(cfg.initialCash, m)}／売買単位：${cfg.lot}株／買う量：${sizeText(cfg, m)}`,
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
      <p class="hint">${(cfg.regime?.mode || "off") === "off" ? "相場フィルターは使っていません。「自動」は検証で決めた条件で判定、「強気」「弱気」は自分の相場感で固定します。" : `いまの判定：<b class="${st.regimeBear ? "dn" : "up"}">${st.regimeBear == null ? "次の更新で判定" : st.regimeBear ? "弱気" : "強気"}</b>（${esc(regimeText(cfg))}）`}</p>
      ${(cfg.regime?.mode || "off") !== "off" ? `<select id="bsRgAct" class="in" style="margin-top:8px">${Object.entries(RG_ACT).map(([v, l]) => `<option value="${v}" ${cfg.regime.action === v ? "selected" : ""}>弱気のとき：${l}</option>`).join("")}</select>` : ""}
    </div>
    <div class="card"><h2>設定</h2>
      <p class="hint" style="margin:0;line-height:1.8">${m === "JP" ? "日本株" : "米国株"}／${esc(paramText(cfg))}<br>
      銘柄：${cfg.symbols.map(s => esc(symLabel(m, s))).join("、")}<br>
      売買単位 ${cfg.lot}株／買う量 ${esc(sizeText(cfg, m))}／損切り ${cfg.slPct || "なし"}${cfg.slPct ? "%" : ""}／利確 ${cfg.tpPct || "なし"}${cfg.tpPct ? "%" : ""}／手数料 ${cfg.feePct}%／滑り ${cfg.slipPct}%<br>
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
  const [ix, us, jp, rate] = await Promise.allSettled([getBars("IX", ["NKVI", "VIX"], from), getBars("US", ["SPY", "GLD", "TLT"], isoAgo(700)), getBars("JP", ["1306"], isoAgo(700)), getBars("IX", ["FF", "JPR"], isoAgo(700))]);
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
    <p class="hint">相場フィルターの「株価指数が上向き・下向き」と同じ見方です。日本株は無料プランのため約12週間遅れのデータです。</p></div>`);
  // 金利の局面（半年前との差）と、金・債券の向き
  const phase = (sym, label, th) => {
    const b = rate.status === "fulfilled" ? rate.value.data[sym] : null;
    if (!b?.length) return `<div class="keyrow"><span>${label}</span><span class="mu">取得できません</span></div>`;
    const last = b[b.length - 1], t = new Date(last.d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - 180);
    const past = b.filter(x => x.d <= t.toISOString().slice(0, 10)).pop();
    if (!past) return `<div class="keyrow"><span>${label}</span><span class="mu">データ不足</span></div>`;
    const diff = last.c - past.c, ph = diff >= th ? "利上げ局面" : diff <= -th ? "利下げ局面" : "据え置き";
    return `<div class="keyrow"><span>${label}<br><span class="mu" style="font-size:12px"><span class="num">${last.c.toFixed(2)}%</span>・半年前から <span class="num">${diff >= 0 ? "+" : ""}${diff.toFixed(2)}</span>・${fmtD(last.d)}</span></span><span>${ph}</span></div>`;
  };
  const dir = (sym, label) => trend(us, sym, label).replace("強気", "上向き").replace("弱気", "下向き");
  out.push(`<div class="card"><h2>金利・金・債券</h2>${phase("FF", "米国の政策金利（FF金利）", 0.25)}${phase("JPR", "日本の短期金利（月次）", 0.1)}${dir("GLD", "金（ETF GLD）")}${dir("TLT", "米国の長期国債（ETF TLT）")}
    <p class="hint">相場フィルターの「利上げ・利下げ局面」「金・債券が上がっている」と同じ見方です。債券が上向きのときは、長期金利が下がっています。</p></div>`);
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
$("btSize").onchange = () => renderSize(true);
$("rgAdd").onchange = e => {
  const k = e.target.value, P = RG_PRESETS[k];
  if (P && rgRows.length < RG_MAX) rgRows.push({ preset: k, role: P.role, val: P.def(market), market });
  renderRg();
};
$("rgList").addEventListener("click", e => { const b = e.target.closest("[data-del]"); if (b) { rgRows.splice(Number(b.dataset.del), 1); renderRg(); } });
$("rgList").addEventListener("input", e => { const t = e.target; if (t.dataset.val != null) rgRows[Number(t.dataset.val)].val = Number(String(t.value).replace(/[,\s]/g, "")) || 0; });
$("rgList").addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.role != null) { rgRows[Number(t.dataset.role)].role = t.value; renderRg(); }
  else if (t.dataset.val != null) rgRows[Number(t.dataset.val)].val = Number(String(t.value).replace(/[,\s]/g, "")) || 0;
});
segInit("btMarket", setMarket);
segInit("btPeriod", v => period = Number(v));
setMarket("JP");
renderParams();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
