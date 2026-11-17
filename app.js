import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { STRATEGIES, STRATEGY_GROUPS, normalizeCfg, regimeMap, precomputeSignals } from "./engine.js";
import { GRIDS, backtest, sweep, segmentize, segReturns } from "./research.js";

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
  if (on) { if (!btn.disabled) btn.dataset.label = btn.textContent; btn.innerHTML = `<span class="spin"></span>${esc(label || "処理中…")}`; btn.disabled = true; }
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
  stoch: { how: "直近N日の高値と安値の幅の中で、今の終値がどの位置にあるか（%K）を0〜100で見ます。下のほうで買い、上のほうで売ります。RSIより敏感に動きます。平滑を3にすると、3日平均でならした「スロー・ストキャスティクス」になります。", good: "短い周期で上下するもみ合い相場。", weak: "一方向に強く動く相場。下げ続ける途中で何度も買ってしまいます。", tip: "売買回数が多くなりやすいので、手数料と滑りを入れて確かめてください。期間を長くすると落ち着きます。" },
  tma: { how: "短期・中期・長期の3本の移動平均が、上から短期＞中期＞長期の順に並んだとき（パーフェクトオーダー）だけ持ちます。並びが崩れたら売ります。", good: "きれいな上昇が長く続く相場。だましが少なく、持っている間は安心感があります。", weak: "上昇の初動と終わり。入るのも出るのも遅く、短い上昇は取り逃します。", tip: "売買は少なめ。5・25・75が定番です。回数が少なすぎるときは、短い組み合わせ（5・10・25など）に。" },
  dip: { how: "終値がN日続けて下がったら「下げすぎの反発」を狙って買い、短い移動平均を上回ったら売ります。数日で終わる短い売買です。", good: "長期では上向きの銘柄や指数ETFの、一時的な下げ。", weak: "下落相場の入り口。続落がそのまま大きな下げにつながります。", tip: "「トレンド条件（200日線より上）」や相場フィルターと組み合わせるのが基本です。1回の利益は小さいので、手数料と滑りの影響を確かめてください。" },
  tom: { how: "月末から月初の数日だけ持ちます。給料日後の積立や投信の買いが月の変わり目に入りやすい、という経験則（月替わり効果）を使います。", good: "相場全体が落ち着いているとき。指数ETF向きです。", weak: "個別の悪材料や急落。日付だけで買うので、相場の状態は見ていません。", tip: "持つ日数が短いぶん、資金が市場にさらされる時間も短い戦略です。相場フィルターと組み合わせると、荒れた月を避けられます。" },
  fear: { how: "恐怖指数（VIX・日経平均VI）が高い＝みんなが怖がって売っているとき、に買い、落ち着いたら売ります。「総悲観は買い」の考え方です。", good: "急落のあと。過去の米国株では、恐怖指数が高い日のあとの成績は平均より良い傾向でした。", weak: "金融危機のように、恐怖が長く続いて下げ続ける局面。早く入りすぎます。", tip: "機会は年に数回です。指数ETFで使うのが素直。「仕掛け」を上げるほど回数は減り、深い下げだけを拾います。" },
  fearpeak: { how: "恐怖指数が高くなったあと、直近20日の高値から一定の割合だけ下がったのを確かめてから買います。「怖さのピークが過ぎた」のを待つ、慎重な入り方です。", good: "急落からの回復。下げの途中で買ってしまう失敗を減らせます。", weak: "V字で一気に戻る相場。待っている間に、戻りの最初を取り逃します。", tip: "「恐怖指数の逆張り」と結果を比べてみてください。下落を小さくしたいならこちら、戻りを全部取りたいなら逆張り、という使い分けです。" },
  ema: { how: "直近の値ほど重く見る移動平均（EMA）を2本使い、短期が長期を上に抜けたら買い、下に抜けたら売ります。", good: "流れのはっきりした相場。普通の移動平均クロスより早く乗れます。", weak: "もみ合い。反応が早いぶん、だましも増えます。", tip: "12と26、20と50、50と200が定番。移動平均クロスと同じ日数で比べると、早さと安定のちがいが分かります。" },
  ichimoku: { how: "一目均衡表の「三役好転」（転換線＞基準線、終値が雲の上、遅行線が26日前の終値より上）がそろったら買い、終値が雲の中に入ったら売ります。雲は過去の高値・安値から作る、支えと抵抗の帯です。", good: "日本株の中長期の上昇相場。条件が多いぶん、強い上昇だけを選べます。", weak: "雲が薄いところでの上下や、急な反転。入るのも出るのも遅めです。", tip: "9・26・52が標準です。日足で使われることが多く、相場フィルターで「指数が三役好転のときだけ」にする使い方も人気です。" },
  psar: { how: "株価の下（上昇中）か上（下降中）に点を打ち、上昇が続くほど点が株価に近づきます。株価が点を割ったら売り。いわば自動で上がっていく損切り線です。", good: "一方向に勢いよく動く相場。利益を伸ばしつつ、反転したらすぐ降ります。", weak: "もみ合い。点がすぐ割られて、売買が増えます。", tip: "加速の幅を小さくすると、点の追いかけがゆっくりになり、長く持てます。ほかの戦略の「出口」として考えるのも有効です。" },
  supertrend: { how: "高値と安値の中心から、ATR（ふだんの値幅）の何倍か上と下に線を引きます。終値が上の線を超えたら上昇トレンドとして買い、下の線を割ったら売ります。", good: "数か月続くトレンド。線が値動きの荒さに合わせて広がるので、ノイズで振り落とされにくいです。", weak: "方向感のないもみ合い。", tip: "倍率を大きくすると、持つ期間が長く、売買が少なくなります。10日・3倍が標準です。" },
  adx: { how: "ADXは「トレンドの強さ」を0〜100で表す指標です。ADXが低い＝もみ合いで力をためている状態から、直近の高値を上抜けた瞬間に買います。直近の安値を割ったら売り。", good: "長いもみ合いから大きく動き出す銘柄。", weak: "もみ合いのまま上下に抜けたり戻ったりする相場。", tip: "「もみ合い」の値を上げると条件がゆるくなり、回数が増えます。Rob Booker の「ADXブレイクアウト」をもとにしています。" },
  linreg: { how: "直近N日の終値に一番よく合う直線（回帰線）を引きます。線が右肩上がりで、終値が線より上なら買い。線のまわりのばらつき（σ）の下の帯を割るか、線が下向きになったら売ります。", good: "なだらかに上がり続ける相場。", weak: "急な上げ下げ。直線では追いつけません。", tip: "期間を長くすると、大きな流れだけを見ます。下の帯の倍率を大きくすると、押し目で振り落とされにくくなります。" },
  rating: { how: "TradingViewの「テクニカル評価」と同じ考え方で、移動平均12本（終値が上なら買い）と、RSI・ストキャス・MACD・モメンタム・ADX・アルティメット・オシレーターの判定を数え、−1（強い売り）〜+1（強い買い）の点数にします。", good: "いろいろな指標の意見がそろう、はっきりした上昇相場。", weak: "急な反転。多数決なので、変わり目には遅れます。", tip: "「買い」を0.5にすると「強い買い」のときだけ入ります。1つの指標に頼らないので、まず試す土台として便利です。" },
  keltner: { how: "EMAの上下に、ATR（ふだんの値幅）の何倍かの帯を引きます（ケルトナーチャネル）。終値が上の帯を超えるほど強く上がったら買い、EMAまで戻ったら売ります。", good: "勢いのある上昇の始まり。", weak: "一度上に抜けてすぐ戻る相場。", tip: "ボリンジャーバンドと似ていますが、こちらは「抜けたら乗る」順張りです。倍率を下げると早く入れます。" },
  volexp: { how: "その日の値幅（高値−安値）が、ふだんの値幅（ATR）の何倍にも広がり、しかも高値近くで引けた陽線を「本気の買い」とみて買います。終値が短い移動平均を割ったら売り。", good: "材料が出て動き出した銘柄、急落からの力強い反発。", weak: "値幅が広がっても続かない相場。", tip: "倍率を上げると、めったにない大きな動きだけを拾います。" },
  insidebar: { how: "前日の高値・安値が前々日の範囲にすっぽり収まった足（インサイドバー＝はらみ足）は、力をためているサインとされます。そのあと前々日の高値を上抜けたら買い。前々日の安値を割るか、決めた日数たったら売ります。", good: "上昇トレンドの途中の小休止。", weak: "上抜けてすぐ戻る相場。", tip: "損切りの位置がはっきりしているので、「損切り幅から逆算」の買い方と相性が良いです。" },
  pivot: { how: "左右の何本かの足より高い足を「山」、低い足を「谷」とします。直近の山を上抜けたら買い、直近の谷を割ったら売ります。右側の足が確定するまで山・谷は分からないので、その日数だけ遅れて判定します。", good: "高値・安値を切り上げていく上昇相場（ダウ理論の上昇）。", weak: "山と谷が入りまじるもみ合い。", tip: "左右の本数を増やすと、大きな山・谷だけを見るようになります。" },
  volume: { how: "出来高がふだんの何倍にも膨らんだ陽線を「大口が買った」とみて買います。終値が短い移動平均を割ったら売り。", good: "材料やニュースで注目された銘柄の初動。", weak: "出来高を伴って天井をつける場面（大量の売り抜け）。", tip: "日本株は約12週間遅れのデータなので、模擬取引ではニュースより遅れて反応します。米国株での検証が向いています。" },
  vwap: { how: "直近N日の「出来高で重みをつけた平均価格（VWAP）」は、その期間に買った人の平均的な値段です。終値がそれより上なら、買った人の多くが利益で余裕がある、として持ちます。", good: "出来高を伴う上昇相場。", weak: "出来高が少ない銘柄。平均がぶれます。", tip: "移動平均（終値だけの平均）と結果を比べてみてください。差が大きい銘柄ほど、出来高の情報が効いています。" },
  vprofile: { how: "直近N日について「どの価格帯でどれだけ売買されたか（価格帯別出来高）」を集計します。出来高の7割が集まる帯（バリューエリア）の上端を上抜けたら、しこりを抜けたとみて買い。一番売買が多かった価格（POC）を割ったら売ります。", good: "長くもみ合ったあとの上放れ。", weak: "出来高が少ない銘柄、上抜けてすぐ戻る相場。", tip: "期間を長くすると、より大きな「しこり」を基準にします。60日（約3か月）か250日（約1年）がおすすめです。" },
  uo: { how: "アルティメット・オシレーターは、7日・14日・28日の3つの期間で「終値が値幅のどのあたりで引けたか」をまとめた指標です。低い（売られすぎ）ところで買い、高いところで売ります。期間を混ぜるので、RSIよりだましが少ないとされます。", good: "一定の幅で上下するもみ合い、上昇トレンドの押し目。", weak: "強い下落が続く相場。", tip: "値が30を下回ることはまれなので、初期値は35にしています。回数が少ないときは40に上げてみてください。" },
  fibo: { how: "直近N日の上昇（安値→高値）に対して、フィボナッチの比率（38.2%・50%・61.8%）だけ下げた水準を自動で求めます。その水準まで押して、陽線で戻したら買い。目標（前の高値など）に届くか、元の安値を割るか、60日たったら売ります。", good: "上昇トレンドの途中の押し目。", weak: "下落への転換。押し目のつもりがそのまま下げ続けます。", tip: "61.8%は深い押し目、38.2%は浅い押し目です。描画ツールのフィボナッチ・リトレースメントを自動で引いている、と考えてください。" },
  candle: { how: "ローソク足の形（包み足、ハンマー、明けの明星、赤三兵など）を自動で見つけ、出た翌日の始値で入ります。反対向きのパターンが出るか、決めた日数たったら手じまいます。反転を示す形は、その前に下げている（10日線より下）ときだけ数えます。", good: "下げたあとの反発、上げたあとの反落の「変わり目」。", weak: "形だけで中身のない動き。1本や2本の足は偶然でもよく出ます。", tip: "1つの形だけだと回数が少ないので、まず「すべて」で試し、そのあと形ごとに比べるのがおすすめです。「（空売り向け）」の形は、細かい設定で「空売り」にして使います。" },
  chartpat: { how: "左右の足より高い「山」と低い「谷」を自動で見つけ、ダブルボトムや逆三尊などの形ができたかを調べます。形ができたあと、ネックライン（形の中の山や谷の線）を抜けたら入ります。形の高さぶん進んだら利確、形の端を逆に抜けたら損切りです。", good: "底打ちや天井打ちの場面。教科書どおりの形がはっきり出る銘柄。", weak: "形ができても抜けずに崩れる相場。判定は機械的なので、人の目で見る形とずれることがあります。", tip: "山・谷の幅を大きくすると、数か月単位の大きな形だけを見ます。高さのずれ（%）を大きくすると、ゆるい形も数えます。" },
  rotation: { how: "入れた銘柄（たとえば米国株SPY・長期債TLT・金GLD）の直近N日の上昇率を比べ、上位だけを持ちます。月に1回（または週に1回・毎日）入れかえます。上昇率が「基準」以下なら、どれも持たずに現金で待ちます（デュアル・モメンタムと呼ばれる考え方）。", good: "株が大きく下げる時期に、債券や金が上がっている場面（2008年など）。株の大きな下げを避けやすくなります。", weak: "株も債券も同時に下がる時期（2022年など）や、強いものが頻繁に入れかわる相場。", tip: "銘柄は2つ以上入れてください。下のボタンで代表的な組み合わせを入れられます。比べる期間は6か月（126日）〜1年（252日）が定番です。" },
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
  ichiup: { group: "指数のテクニカル", label: "指数が一目均衡表で強気", sub: m => `${idxName(m)}が三役好転してから、雲に入るまで`, def: () => 1, role: "only", make: m => ({ kind: "sig", key: idxKey(m), strat: "ichimoku", params: {}, cond: "on" }) },
  stup: { group: "指数のテクニカル", label: "指数のスーパートレンドが上向き", sub: m => `${idxName(m)}のスーパートレンド（10日・3倍）`, def: () => 1, role: "only", make: m => ({ kind: "sig", key: idxKey(m), strat: "supertrend", params: {}, cond: "on" }) },
  sarup: { group: "指数のテクニカル", label: "指数のパラボリックSARが上向き", sub: m => `${idxName(m)}の株価がSARより上`, def: () => 1, role: "only", make: m => ({ kind: "sig", key: idxKey(m), strat: "psar", params: {}, cond: "on" }) },
  gcross: { group: "指数のテクニカル", label: "指数がゴールデンクロス中", sub: m => `${idxName(m)}の50日線が200日線より上`, def: () => 1, role: "only", make: m => ({ kind: "sig", key: idxKey(m), strat: "sma", params: { short: 50, long: 200 }, cond: "on" }) },
  macdup: { group: "指数のテクニカル", label: "指数のMACDが上向き", sub: m => `${idxName(m)}のMACDがシグナルより上`, def: () => 1, role: "only", make: m => ({ kind: "sig", key: idxKey(m), strat: "macd", params: {}, cond: "on" }) },
  ratebuy: { group: "指数のテクニカル", label: "指数のテクニカル評価が買い", sub: m => `${idxName(m)}の総合点がこの値より上`, unit: "総合点（−1〜1）", def: () => 0.1, zero: true, role: "only", make: (m, v) => ({ kind: "sig", key: idxKey(m), strat: "rating", params: { buy: v, sell: v }, cond: "on" }) },
  notrend: { group: "指数のテクニカル", label: "トレンドが弱い（もみ合い）", sub: m => `${idxName(m)}のADX（14日）がこの値より下`, unit: "ADXがこの値未満", def: () => 20, role: "avoid", make: (m, v) => ({ kind: "osc", key: idxKey(m), osc: "adx", n: 14, op: "lt", th: v }) },
  hot: { group: "指数のテクニカル", label: "過熱（指数のRSIが高い）", sub: m => `${idxName(m)}のRSI（14日）がこの値より上`, unit: "RSIがこの値超", def: () => 70, role: "avoid", make: (m, v) => ({ kind: "osc", key: idxKey(m), osc: "rsi", n: 14, op: "gt", th: v }) },
  cold: { group: "指数のテクニカル", label: "売られすぎ（指数のRSIが低い）", sub: m => `${idxName(m)}のRSI（14日）がこの値より下`, unit: "RSIがこの値未満", def: () => 35, role: "only", make: (m, v) => ({ kind: "osc", key: idxKey(m), osc: "rsi", n: 14, op: "lt", th: v }) },
  wild: { group: "指数のテクニカル", label: "値動きが荒い（ATRが大きい）", sub: m => `${idxName(m)}の1日の値幅（ATR14日）が株価のこの%より大きい`, unit: "ATRが株価の%超", def: () => 2, role: "avoid", make: (m, v) => ({ kind: "osc", key: idxKey(m), osc: "atrp", n: 14, op: "gt", th: v }) },
  bearpat: { group: "指数のテクニカル", label: "指数に天井の形（ダブルトップ・三尊）", sub: m => `${idxName(m)}で弱気のチャートパターンが完成し、ネックラインを割ったあと`, def: () => 1, role: "avoid", make: m => ({ kind: "sig", key: idxKey(m), strat: "chartpat", params: { pat: 5 }, cond: "on" }) },
  bullpat: { group: "指数のテクニカル", label: "指数に底の形（ダブルボトム・逆三尊）", sub: m => `${idxName(m)}で強気のチャートパターンが完成し、ネックラインを抜けたあと`, def: () => 1, role: "only", make: m => ({ kind: "sig", key: idxKey(m), strat: "chartpat", params: { pat: 0 }, cond: "on" }) },
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
// 口座とレバレッジの注意書き
function renderAcct() {
  const lev = Number($("btLev").value) || 1, nisa = $("btAcct").value === "nisa", short = $("btSide").value === "short";
  $("btLevBox").classList.toggle("hidden", lev <= 1);
  const t = [];
  if ($("btAcct").value === "tokutei") t.push("利益が出た手じまいのたびに20.315%を引き、同じ年の損失とは相殺します。買い持ちも最後の日に売った前提で同じく税金を引いて比べます。");
  if (nisa && (lev > 1 || short)) t.push("NISAでは空売りはできず、レバレッジ型ETFも成長投資枠の対象外です。この組み合わせは特定口座で考えてください。");
  if (lev > 1) t.push(`指数の${lev}倍で毎日動くETF（米国株ならSPYに対するSSOなど）を想定して計算します。下落も${lev}倍になり、上下を繰り返すと目減りします。`);
  $("btAcctHint").textContent = t.join(" ");
}
// 資産の乗り換えのときの銘柄の組み合わせ例
const ROT_PRESETS = { US: [["株・債券・金", "SPY, TLT, GLD"], ["米国株・ハイテク・債券・金", "SPY, QQQ, TLT, GLD"], ["米国・先進国・新興国・債券・金", "SPY, EFA, EEM, TLT, GLD"]], JP: [["日本株・国内債券・金", "1306, 2510, 1328"], ["日本株・外国株・外国債券・金", "1306, 1550, 2511, 1328"]] };
function renderRotPre() {
  const on = !!STRATEGIES[$("btStrategy").value]?.multi;
  $("btRotPre").classList.toggle("hidden", !on);
  $("btRotPre").innerHTML = on ? ROT_PRESETS[market].map(([l, v]) => `<button data-v="${esc(v)}">${esc(l)}</button>`).join("") : "";
}
function renderSize(reset) {
  const S = SIZE[$("btSize").value];
  $("btSizeLab").textContent = typeof S.lab === "function" ? S.lab(market) : S.lab;
  $("btSizeHint").textContent = S.hint;
  if (reset) $("btSizeVal").value = String(S.def(market));
}
function renderParams() {
  const st = STRATEGIES[$("btStrategy").value];
  $("btDesc").textContent = st.desc;
  renderRotPre();
  const H = STRAT_HELP[$("btStrategy").value];
  $("btHelp").innerHTML = H ? `<dl><dt>しくみ</dt><dd>${H.how}</dd><dt>向いている相場</dt><dd>${H.good}</dd><dt>苦手な相場</dt><dd>${H.weak}</dd><dt>使い方のコツ</dt><dd>${H.tip}</dd></dl>` : "";
  $("btParams").innerHTML = st.params.map(p => p.options
    ? `<div class="wide"><label class="lab" for="bp_${p.key}">${esc(p.label)}</label><select id="bp_${p.key}" class="in">${p.options.map((o, i) => `<option value="${i}" ${i === p.def ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`
    : `<div><label class="lab" for="bp_${p.key}">${esc(p.label)}</label><input id="bp_${p.key}" class="in num" inputmode="${p.step ? "decimal" : "numeric"}" value="${p.def}"></div>`).join("");
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
    taxPct: { tokutei: 20.315, nisa: 0, none: 0 }[$("btAcct").value] ?? 0, lev: Number($("btLev").value) || 1, levCostPct: n("btLevCost"),
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
    await addBench(market, data, from);
    const res = backtest({ ...cfg, symbols: ok }, data, { from: start, benchSym: benchKey(market) });
    if (!res.equity.length) throw new Error("この期間のデータがありません。期間を「全部」にして試してください");
    lastBT = { market, cfg: { ...cfg, symbols: ok }, res, data, period, start, sweepRows: null, bname: benchName(market) };
    $("swOut").innerHTML = "";
    renderBT(errText);
    saveForm(); addHist(lastBT);
    $("btOut").classList.remove("hidden");
    $("btOut").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { $("btErr").textContent = e.message; }
  finally { busy($("btRun"), false); }
};

/* ---------- フォームの保存・呼び出し・クリア ---------- */
const FORM_IDS = ["btBench", "btAcct", "btLev", "btLevCost", "btSymbols", "btStrategy", "btFearSym", "btRgAct", "btCash", "btLot", "btSize", "btSizeVal", "btSl", "btTp", "btSide", "btBorrow", "btTrend", "btFee", "btSlip"];
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* 保存できなくても動く */ } } };
function getForm() {
  const f = { market, period, params: {}, rg: rgRows.map(r => ({ preset: r.preset, role: r.role, val: r.val })) };
  for (const id of FORM_IDS) f[id] = $(id).value;
  for (const p of STRATEGIES[$("btStrategy").value].params) f.params[p.key] = $("bp_" + p.key).value;
  return f;
}
function setForm(f) {
  const seg = (id, v) => [...$(id).children].forEach(x => x.classList.toggle("on", x.dataset.v === String(v)));
  const m = f.market === "US" ? "US" : "JP";
  rgRows = [];
  seg("btMarket", m); setMarket(m);
  if ([0, 1, 2, 5, 10].includes(Number(f.period))) { period = Number(f.period); seg("btPeriod", period); }
  if (STRATEGIES[f.btStrategy]) $("btStrategy").value = f.btStrategy;
  renderParams();
  for (const [k, v] of Object.entries(f.params || {})) { const el = $("bp_" + k); if (el) el.value = v; }
  if (SIZE[f.btSize]) { $("btSize").value = f.btSize; renderSize(false); }
  for (const id of FORM_IDS) if (id !== "btStrategy" && id !== "btSize" && f[id] != null && f[id] !== "") $(id).value = f[id];
  $("btSymbols").value = f.btSymbols || "";
  rgRows = (f.rg || []).filter(r => RG_PRESETS[r.preset]).slice(0, RG_MAX).map(r => ({ preset: r.preset, role: r.role === "only" ? "only" : "avoid", val: Number(r.val) || 0, market: m }));
  renderRg(); renderRecent(); renderAcct(); renderRotPre();
}
const saveForm = () => store.set("st-form", getForm());
function clearForm() {
  setForm({ market, period: 2, btBench: "index", btAcct: "tokutei", btLev: "1", btLevCost: "1", btStrategy: "sma", btRgAct: "nobuy", btSize: "pct", btSl: "0", btTp: "0", btSide: "long", btBorrow: "1", btTrend: "0", btFee: "0", btSlip: "0.1" });
  $("btErr").textContent = ""; $("exOut").innerHTML = "";
  saveForm(); toast("設定をクリアしました");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
// 最近の検証（この端末に8件まで）
function addHist(lb) {
  const form = getForm(), key = JSON.stringify(form), M = lb.res.metrics;
  const list = store.get("st-hist", []).filter(h => JSON.stringify(h.form) !== key);
  list.unshift({ t: Date.now(), form, label: `${lb.cfg.symbols.join("・")}｜${paramText(lb.cfg)}`, total: M.totalPct, dd: M.maxDDPct, years: period });
  store.set("st-hist", list.slice(0, 8));
  renderHist(); renderRecent();
}
function renderHist() {
  const list = store.get("st-hist", []);
  $("histBtn").textContent = `最近の検証${list.length ? `（${list.length}）` : ""}`;
  $("histList").innerHTML = list.length ? list.map((h, i) => `<div class="hrow" data-i="${i}"><span>${esc(h.label)}<small>${h.form.market === "US" ? "米国株" : "日本株"}・${h.years ? h.years + "年" : "全期間"}・${new Date(h.t).toLocaleDateString("ja-JP")}</small></span><span class="num ${cls(h.total)}" style="white-space:nowrap">${pct(h.total)}<small>-${Number(h.dd).toFixed(0)}%</small></span></div>`).join("") : `<div class="empty">まだありません。検証すると、ここに設定と結果が残ります</div>`;
}
// 最近使った銘柄（いまの市場のもの）。タップで銘柄欄に足す
function renderRecent() {
  const seen = [];
  for (const h of store.get("st-hist", [])) if (h.form.market === market) for (const s of parseSyms(h.form.btSymbols)) if (!seen.includes(s)) seen.push(s);
  $("btRecent").innerHTML = seen.slice(0, 8).map(s => `<button data-s="${esc(s)}">${esc(symLabel(market, s))}</button>`).join("");
}

// 比べる相手の指数（米国株は S&P500 の SPY、日本株は TOPIX 連動の 1306）
const benchKey = m => $("btBench").value === "index" ? (m === "JP" ? "JP:1306" : "US:SPY") : null;
const benchName = m => $("btBench").value === "index" ? (m === "JP" ? "TOPIX（1306）" : "S&P500（SPY）") : "入れた銘柄";
async function addBench(m, data, from) {
  const k = benchKey(m); if (!k || data[k]) return;
  const [km, ks] = k.split(":"), v = await getBars(km, [ks], from);
  if (v.data[ks]?.length) data[k] = v.data[ks];
}

/* ---------- 自動探索の結果（優先する見方で並べかえる） ---------- */
let exState = null;
// 自動探索で、初期値に加えて試す「長め」の設定
const EX_VARIANTS = {
  sma: [{ short: 50, long: 200 }], ema: [{ short: 50, long: 200 }], tma: [{ short: 20, mid: 50, long: 200 }],
  macd: [{ fast: 24, slow: 52, signal: 18 }], breakout: [{ entry: 55, exit: 20 }], roc: [{ period: 200, th: 0 }],
  supertrend: [{ period: 20, mult: 4 }], linreg: [{ period: 200, k: 2 }], keltner: [{ period: 50, mult: 2 }],
  vwap: [{ period: 200 }], psar: [{ step: 0.01, max: 0.1 }], ichimoku: [{ tenkan: 18, kijun: 52, senkou: 104 }],
  rotation: [{ period: 252, top: 1, th: 0, rebal: 0 }, { period: 126, top: 2, th: 0, rebal: 0 }],
};
const EX_PRIO = {
  half: { label: "指数並み・下落半分", hint: "年率が買い持ちの9割以上で、最大下落が買い持ちの半分以下に近い順" },
  balance: { label: "区間の勝ち数", hint: "買い持ちに勝った区間が多い順" },
  ret: { label: "損益", hint: "全期間の損益が大きい順" },
  dd: { label: "下落の小ささ", hint: "年率が買い持ちの7割以上のうち、最大下落が小さい順" },
  sharpe: { label: "効率（シャープ）", hint: "値動きの大きさあたりの増え方が良い順" },
  calmar: { label: "年率÷最大下落", hint: "最大下落1%あたりの年率が大きい順。下落を抑えてから投資額を増やす考え方の目安" },
};
const calmar = M => M.maxDDPct > 0 ? M.cagrPct / M.maxDDPct : 0;
function renderEx() {
  const out = $("exOut"), S = exState;
  if (!S) return;
  const prio = $("exPrio").querySelector(".on")?.dataset.v || "half";
  const { rows, segs, benchSeg, benchM, K, need, unit, skipped, dates, bname } = S;
  const okRows = rows.filter(r => r.enough);
  // ★の条件と並べ方
  const ddRatio = M => M.maxDDPct > 0 ? benchM.maxDDPct * 0.5 / M.maxDDPct : 9;
  const cagrRatio = M => benchM.cagrPct > 0 ? M.cagrPct / (benchM.cagrPct * 0.9) : (M.cagrPct >= benchM.cagrPct ? 1 : 0);
  const pass = {
    half: r => r.M.cagrPct >= benchM.cagrPct * 0.9 && r.M.maxDDPct <= benchM.maxDDPct * 0.5,
    balance: r => r.wins >= need && r.M.sharpe > benchM.sharpe,
    ret: r => r.M.totalPct > benchM.totalPct,
    dd: r => r.M.cagrPct >= benchM.cagrPct * 0.7 && r.M.maxDDPct < benchM.maxDDPct * 0.7,
    sharpe: r => r.M.sharpe > benchM.sharpe,
    calmar: r => calmar(r.M) > calmar(benchM),
  }[prio];
  const key = {
    // 条件を満たしたものは年率の高い順、満たさないものは「年率」と「下落」のうち足りないほうが近い順
    half: r => [Math.min(cagrRatio(r.M), ddRatio(r.M), 1.0001), r.M.cagrPct],
    balance: r => [r.wins, r.median],
    ret: r => [r.M.totalPct, 0],
    dd: r => [r.M.cagrPct >= benchM.cagrPct * 0.7 ? 1 : 0, -r.M.maxDDPct],
    sharpe: r => [r.M.sharpe, 0],
    calmar: r => [calmar(r.M), 0],
  }[prio];
  const sorted = okRows.map(r => ({ r, p: pass(r), k: key(r) })).sort((x, y) => (y.p - x.p) || (y.k[0] - x.k[0]) || (y.k[1] - x.k[1]));
  // 成績がまったく同じもの（フィルターが一度も効かなかったなど）は1行にまとめる
  const seen = new Map();
  for (const x of sorted) {
    const id = `${x.r.st}|${JSON.stringify(x.r.params)}|${x.r.M.totalPct.toFixed(3)}|${x.r.M.maxDDPct.toFixed(3)}|${x.r.M.trades}`;
    if (seen.has(id)) seen.get(id).same.push(x.r.c); else seen.set(id, { ...x.r, pass: x.p, same: [] });
  }
  exRows = [...seen.values()].slice(0, 15);
  const nPass = sorted.filter(x => x.p).length;
  const metric = M => ({ half: `年率 ${M.cagrPct >= 0 ? "+" : ""}${M.cagrPct.toFixed(1)}%`, balance: null, ret: `年率 ${M.cagrPct >= 0 ? "+" : ""}${M.cagrPct.toFixed(1)}%`, dd: `下落 -${M.maxDDPct.toFixed(0)}%`, sharpe: `効率 ${M.sharpe.toFixed(2)}`, calmar: `${calmar(M).toFixed(2)}` })[prio];
  const unitName = { year: "1年", half: "半年", quarter: "3か月" }[unit];
  const strip = (vals, exs) => `<div class="segs" style="grid-template-columns:repeat(${K},1fr)">${vals.map((v, i) => {
    const e = exs ? exs[i] : null, col = e == null || Math.abs(e) <= 0.5 ? "" : e > 0 ? `background:rgba(52,140,90,${Math.min(0.55, 0.12 + Math.abs(e) / 40)})` : `background:rgba(200,70,60,${Math.min(0.5, 0.1 + Math.abs(e) / 40)})`;
    return `<span style="${col}">${v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(0)}</span>`;
  }).join("")}</div>`;
  const ruleText = (c, act) => !c ? "フィルターなし" : (/[るいた]$/.test(c.P.label) ? c.P.label + "とき" : c.P.label + "のとき") + (c.f.role === "only" ? "だけ持つ" : "は降りる") + (act === "nobuy" ? "（新規だけ止める）" : "");
  const stName = r => (r.st === "hold" ? "買って持ち続ける" : STRATEGIES[r.st].label) + (r.alt ? `（${shortParams(r.st, r.params)}）` : "");
  const passText = {
    half: `年率が買い持ちの9割以上（${(benchM.cagrPct * 0.9).toFixed(1)}%以上）で、最大下落が買い持ちの半分以下（-${(benchM.maxDDPct * 0.5).toFixed(0)}%以内）`,
    balance: `${K}区間のうち${need}区間以上で買い持ちに勝ち、全体の効率も上回った`,
    ret: "全期間の損益で買い持ちを上回った",
    dd: `年率が買い持ちの7割以上（${(benchM.cagrPct * 0.7).toFixed(1)}%以上）で、最大下落が買い持ちの7割未満（-${(benchM.maxDDPct * 0.7).toFixed(0)}%より小さい）`,
    sharpe: `効率（シャープ）が買い持ちの ${benchM.sharpe.toFixed(2)} を上回った`,
    calmar: `年率÷最大下落が買い持ちの ${calmar(benchM).toFixed(2)} を上回った`,
  }[prio];
  const right = (M, wins) => `${prio === "balance" ? `<b>${wins}/${K}勝</b>` : `<b>${metric(M)}</b>`}<span class="${cls(M.totalPct)}">${pct(M.totalPct)}</span><small>${prio === "dd" ? "" : `-${M.maxDDPct.toFixed(0)}%`}${prio === "balance" ? "" : `${prio === "dd" ? "" : "・"}${wins}/${K}勝`}</small>`;
  out.innerHTML = !exRows.length ? `<div class="empty">売買が成立した組み合わせがありませんでした。売買単位や資金を見直してください</div>` : `
    <div class="swsum">${rows.length}通りを、${unitName}ごとの<b>${K}区間</b>に分けて買い持ちと比べました（<span class="num">${fmtD(dates[0])}〜${fmtD(dates[dates.length - 1])}</span>）。並び：<b>${EX_PRIO[prio].hint}</b>。<br>
    ${passText}のは <b>${nPass}通り</b>。${nPass === 0 ? "条件を満たすものはありませんでした。下は惜しかった順です。" : ""}</div>
    <div class="segrow head"><div class="t"><span class="mu">区間</span></div><div class="segs lab" style="grid-template-columns:repeat(${K},1fr)">${segs.map(g => `<span>${esc(g.label)}</span>`).join("")}</div></div>
    <div class="segrow base"><div class="t"><span>${esc(bname)}を持ち続けた場合</span><span class="num">${prio === "balance" ? "" : `<b>${metric(benchM)}</b>`}<span class="${cls(benchM.totalPct)}">${pct(benchM.totalPct)}</span><small>-${benchM.maxDDPct.toFixed(0)}%</small></span></div>${strip(benchSeg, null)}</div>
    ${exRows.map((r, i) => `<div class="segrow r" data-i="${i}"><div class="t"><span>${r.pass ? `<span class="star">★</span>` : ""}${esc(stName(r))}<small>${esc(ruleText(r.c, r.act))}${r.same.length ? `<br>（同じ結果：${esc(r.same.slice(0, 3).map(c => ruleText(c, r.act)).join("、"))}${r.same.length > 3 ? ` ほか${r.same.length - 3}件` : ""}）` : ""}</small></span><span class="num">${right(r.M, r.wins)}</span></div>${strip(r.seg, r.ex)}</div>`).join("")}
    <p class="hint">マスの数字は、その区間の損益（%）。<span style="background:rgba(52,140,90,.35);padding:0 4px;border-radius:3px">緑</span>は買い持ちに勝った区間、<span style="background:rgba(200,70,60,.3);padding:0 4px;border-radius:3px">赤</span>は負けた区間で、色が濃いほど差が大きい（差が0.5ポイント以内なら色なし＝引き分け）。右上は${prio === "balance" ? "勝った区間の数" : "優先した指標"}と、全期間の損益・最大下落。★は${passText}もの。行をタップすると、その組み合わせで検証します。数値は各戦略の初期値で試しています。${skipped.length ? `<br>データが取れず試せなかった条件：${esc(skipped.join("、"))}` : ""}</p>`;
  out.querySelectorAll(".segrow.r").forEach(tr => tr.onclick = () => {
    const r = exRows[Number(tr.dataset.i)];
    $("btStrategy").value = r.st; renderParams();
    for (const [k, v] of Object.entries(r.params || {})) { const el = $("bp_" + k); if (el) el.value = v; }
    rgRows = r.c ? [{ ...r.c.row }] : []; renderRg();
    if (r.c) $("btRgAct").value = r.act;
    $("btRun").click();
  });
}

/* ---------- 組み合わせを自動で探す ---------- */
let exRows = [];
$("exRun").onclick = async () => {
  const base = readCfg(), out = $("exOut");
  out.innerHTML = "";
  if (!base.symbols.length) { out.innerHTML = `<div class="err">先に銘柄を入れてください</div>`; return; }
  if (base.sizeMode === "risk" && !(base.slPct > 0)) { out.innerHTML = `<div class="err">「損切り幅から逆算」を使うときは、細かい設定で損切り（%）を入れてください</div>`; return; }
  const m = market, tick = () => new Promise(r => setTimeout(r, 0));
  busy($("exRun"), true, "データを集めています…");
  try {
    const start = period ? isoAgo(Math.round(period * 365.25)) : null;
    const from = start ? isoAgo(Math.round(period * 365.25) + 600) : null;
    const { data, errors } = await getBars(m, base.symbols, from);
    const ok = base.symbols.filter(s => data[s]?.length);
    if (!ok.length) throw new Error(Object.values(errors)[0] || "株価が取得できませんでした");
    // 条件に使うデータを全部集める。取れなかったものは、その条件だけ飛ばす
    const cands = Object.entries(RG_PRESETS).map(([k, P]) => ({ k, P, row: { preset: k, role: P.role, val: P.def(m), market: m } })).map(c => ({ ...c, f: rgFilter(c.row, m) }));
    const keys = [...new Set([...cands.map(c => c.f.key).filter(Boolean), "IX:" + (m === "JP" ? "NKVI" : "VIX")])];
    for (const key of keys) {
      const [km, ks] = key.split(":");
      try { const v = await getBars(km, [ks], from); if (v.data[ks]?.length) data[key] = v.data[ks]; } catch (_) { /* 飛ばす */ }
    }
    const filters = [null, ...cands.filter(c => !c.f.key || data[c.f.key])];
    const skipped = cands.filter(c => c.f.key && !data[c.f.key]).map(c => c.P.label);
    // 全期間を1回ずつ検証し、年ごと（短い期間は半年・四半期ごと）の区間に分けて買い持ち（1倍）と比べる
    const cfg0 = { ...base, symbols: ok, regime: { mode: "off" } };
    await addBench(m, data, from);
    const benchRun = backtest({ ...cfg0, strategy: "hold", params: {} }, data, { from: start, benchSym: benchKey(m) });
    const dates = benchRun.bench.equity.map(e => e.d);
    if (dates.length < 120) throw new Error("期間が短すぎます。1年以上で試してください");
    const { unit, segs } = segmentize(dates);
    const benchSeg = segReturns(benchRun.bench.equity, segs, base.initialCash), benchM = benchRun.bench.metrics;
    const K = segs.length, need = Math.max(2, Math.ceil(K * 0.6));
    // 試す戦略：各戦略の初期値と、主な戦略の「長め」の設定。買い持ち＋フィルターも入れる
    const variants = [];
    for (const st of Object.keys(STRATEGIES)) {
      const S = STRATEGIES[st];
      if (S.needsVol && !data["IX:" + (m === "JP" ? "NKVI" : "VIX")]) continue;
      if (S.multi && ok.length < 2) continue;
      variants.push({ st, params: Object.fromEntries(S.params.map(p => [p.key, p.def])), alt: false });
      for (const v of EX_VARIANTS[st] || []) variants.push({ st, params: v, alt: true });
    }
    const acts = $("exAct").value === "both" ? ["exit", "nobuy"] : [$("exAct").value];
    // 相場フィルターの判定は、条件ごとに1回だけ計算しておく
    const allDates = [...new Set(ok.flatMap(s => data[s].map(b => b.d)))].sort();
    const maps = new Map(filters.filter(Boolean).map(c => [c, regimeMap({ ...cfg0, regime: { mode: "auto", filters: [c.f] } }, data, allDates)]));
    const rows = [];
    for (const [vi, v] of variants.entries()) {
      busy($("exRun"), true, `計算中… ${vi + 1}/${variants.length}`);
      await tick();
      const cfgS = { ...cfg0, strategy: v.st, params: v.params, fearSym: STRATEGIES[v.st].needsVol ? (m === "JP" ? "NKVI" : "VIX") : "", fearLag: false };
      const sig = precomputeSignals(cfgS, data);
      for (const c of filters) {
        // 買い持ちでフィルターなしは比べる相手と同じなので、レバレッジがあるときだけ試す
        if (v.st === "hold" && !c && !(base.lev > 1)) continue;
        for (const act of c ? acts : ["exit"]) {
          // 買い持ち＋「新しく買わない」は、一度買ったら売らないので試さない
          if (v.st === "hold" && act === "nobuy") continue;
          const cfg = { ...cfgS, regime: c ? { mode: "auto", action: act, filters: [c.f] } : { mode: "off" } };
          const r = backtest(cfg, data, { from: start, sig, bearMap: c ? maps.get(c) : undefined, noBench: true });
          if (!r.metrics || r.equity.length < dates.length * 0.9) continue;
          const seg = segReturns(r.equity, segs, base.initialCash);
          const ex = seg.map((x, i) => x == null || benchSeg[i] == null ? null : x - benchSeg[i]);
          const wins = ex.filter(x => x != null && x > 0.5).length; // 0.5ポイント以内の差は引き分け
          const sorted = ex.filter(x => x != null).sort((x, y) => x - y), median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
          const enough = v.st === "hold" ? r.metrics.trades >= 1 : r.metrics.roundTrips >= 3;
          rows.push({ st: v.st, params: v.params, alt: v.alt, act, c, M: r.metrics, seg, ex, wins, median, enough });
        }
      }
    }
    exState = { rows, segs, benchSeg, benchM, K, need, unit, skipped, dates, bname: benchName(m) };
    renderEx();
  } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  finally { busy($("exRun"), false); }
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
  $("btCmp").innerHTML = `${esc(lastBT.bname || "入れた銘柄")}を買って持ち続けた場合は <b class="num ${cls(B.totalPct)}">${pct(B.totalPct)}</b>（最大下落 <span class="num">-${B.maxDDPct.toFixed(1)}%</span>）。`
    + `この戦略は <b class="num ${cls(diff)}">${diff >= 0 ? "上回り" : "下回り"}（${pct(diff)}）</b>`
    + (M.maxDDPct < B.maxDDPct ? `、下落は小さく抑えられています。` : `、下落は同じか大きめです。`);
  drawChart($("btEqChart"), [
    { pts: res.bench.equity.map(e => ({ d: e.d, v: e.equity })), color: "#9aa0a8", width: 1.4, tipColor: "#c9cdd2" },
    { pts: res.equity.map(e => ({ d: e.d, v: e.equity })), color: "#0f5c47", width: 2, tipColor: "#7fe0bd" },
  ], { m });
  $("btSymSeg").innerHTML = cfg.symbols.map((s, i) => `<button data-s="${esc(s)}" class="${i ? "" : "on"}">${esc(symLabel(m, s))}</button>`).join("");
  drawPx(cfg.symbols[0]);
  if (cfg.taxPct > 0) $("btCmp").innerHTML += `<br>税金（${cfg.taxPct}%）を引いたあとの成績です。この戦略の税金 <span class="num">${money(res.taxTotal || 0, m)}</span>、買い持ちは最後の日に売った場合 <span class="num">${money(res.bench.taxTotal || 0, m)}</span>。`;
  else $("btCmp").innerHTML += `<br>税金は${$("btAcct").value === "nisa" ? "かからない（NISA）" : "考えていない"}計算です。`;
  if (cfg.lev > 1) $("btCmp").innerHTML += `<br>レバレッジ${cfg.lev}倍の型ETFを想定（毎日、値動きの${cfg.lev}倍・経費 年${cfg.levCostPct}%）。売買の判断は元の値動きで行います。買い持ちとの比較は1倍のままです。`;
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
  const ps = (STRATEGIES[cfg.strategy]?.params || []).map(p => p.options ? p.options[cfg.params[p.key]] : `${p.label.replace(/（.*）/, "")} ${cfg.params[p.key]}`).join("・");
  return `${cfg.side === "short" ? "【空売り】" : ""}${STRATEGIES[cfg.strategy]?.label || cfg.strategy}${cfg.fearSym ? "・" + VOL_NAME[cfg.fearSym] : ""}${ps ? "（" + ps + "）" : ""}${cfg.trendMa ? `＋${cfg.trendMa}日線より上のときだけ` : ""}${cfg.regime && cfg.regime.mode !== "off" ? `＋相場フィルター` : ""}${cfg.lev > 1 ? `【${cfg.lev}倍】` : ""}`;
};
const VOL_NAME = { VIX: "VIX", NKVI: "日経平均VI" };
const RG_ACT = { nobuy: "新しく買わない", exit: "持ち株も売って待つ", half: "買う量を半分にする" };
const KEY_NAME = { "JP:1306": "TOPIX（1306）", "US:SPY": "S&P500（SPY）", "US:GLD": "金（GLD）", "US:TLT": "米国長期債（TLT）", "IX:VIX": "VIX", "IX:NKVI": "日経平均VI", "IX:FF": "米国の政策金利", "IX:JPR": "日本の短期金利", "US:QQQ": "ナスダック100（QQQ）", "US:IWM": "米国小型株（IWM）", "US:HYG": "ハイイールド債（HYG）", "IX:USDJPY": "ドル円", "IX:US10Y": "米国の10年金利", "IX:T10Y2Y": "米国の長短金利差", "IX:WTI": "原油（WTI）", "IX:BEI": "米国の期待インフレ率", "IX:UNRATE": "米国の失業率" };
const keyName = k => KEY_NAME[k] || String(k).split(":").pop();
const filterText = f => {
  const what = f.kind === "season" ? `${f.m1}〜${f.m2}月`
    : f.kind === "sig" ? `${keyName(f.key)}の${STRATEGIES[f.strat]?.label || f.strat}${f.strat === "rating" ? `（${f.params.buy}超）` : f.strat === "sma" ? `（${f.params.short}日>${f.params.long}日）` : ""}が${f.cond === "off" ? "弱気" : "強気"}`
    : f.kind === "osc" ? `${keyName(f.key)}の${{ rsi: "RSI", adx: "ADX", atrp: "ATR（株価比%）" }[f.osc]}が${f.th}${f.op === "gt" ? "超" : "未満"}`
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
const shortParams = (st, p) => (STRATEGIES[st]?.params || []).map(x => x.options ? x.options[p[x.key]] : `${x.label.replace(/（.*）/, "").replace(/^買い：|^売り：/, "")}${p[x.key]}`).join(" / ");

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
$("btStrategy").innerHTML = Object.entries(STRATEGY_GROUPS).map(([g, gl]) => `<optgroup label="${esc(gl)}">${Object.entries(STRATEGIES).filter(([, v]) => v.group === g).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</optgroup>`).join("");
$("btStrategy").onchange = renderParams;
$("btSize").onchange = () => renderSize(true);
$("btAcct").onchange = $("btLev").onchange = $("btSide").onchange = renderAcct;
$("btRotPre").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { $("btSymbols").value = b.dataset.v; saveForm(); } });
$("rgAdd").onchange = e => {
  const k = e.target.value, P = RG_PRESETS[k];
  if (P && rgRows.length < RG_MAX) rgRows.push({ preset: k, role: P.role, val: P.def(market), market });
  renderRg();
};
$("rgList").addEventListener("click", e => { const b = e.target.closest("[data-del]"); if (b) { rgRows.splice(Number(b.dataset.del), 1); renderRg(); saveForm(); } });
$("rgList").addEventListener("input", e => { const t = e.target; if (t.dataset.val != null) rgRows[Number(t.dataset.val)].val = Number(String(t.value).replace(/[,\s]/g, "")) || 0; });
$("rgList").addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.role != null) { rgRows[Number(t.dataset.role)].role = t.value; renderRg(); }
  else if (t.dataset.val != null) rgRows[Number(t.dataset.val)].val = Number(String(t.value).replace(/[,\s]/g, "")) || 0;
});
segInit("btMarket", m => { if (m !== market) $("btSymbols").value = ""; setMarket(m); renderRecent(); saveForm(); });
segInit("btPeriod", v => { period = Number(v); saveForm(); });
setMarket("JP");
renderParams();
// 前回の設定を戻す
{ const f = store.get("st-form", null); if (f) { try { setForm(f); } catch (_) { /* 古い形式は無視 */ } } }
renderHist(); renderRecent();
$("vBT").addEventListener("change", e => { if (e.target.closest("input,select")) saveForm(); });
$("btClear").onclick = clearForm;
// 自動探索の並べ方。選んだものを覚えておき、結果があれば並べかえる
{ const v = store.get("st-exprio", "half"); [...$("exPrio").children].forEach(b => b.classList.toggle("on", b.dataset.v === v)); }
segInit("exPrio", v => { store.set("st-exprio", v); renderEx(); });
$("exAct").value = store.get("st-exact", "exit");
$("exAct").onchange = () => store.set("st-exact", $("exAct").value);
renderAcct();
$("histBtn").onclick = () => $("histBox").classList.toggle("hidden");
$("histList").addEventListener("click", e => {
  const r = e.target.closest(".hrow"); if (!r) return;
  const h = store.get("st-hist", [])[Number(r.dataset.i)]; if (!h) return;
  setForm(h.form); saveForm(); $("histBox").classList.add("hidden"); toast("設定を呼び出しました");
});
$("btRecent").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const cur = parseSyms($("btSymbols").value);
  if (!cur.includes(b.dataset.s)) { $("btSymbols").value = [...cur, b.dataset.s].join(", "); saveForm(); }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
