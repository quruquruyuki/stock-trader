// 売買エンジン（バックテストと模擬取引で共用。ブラウザと Supabase Edge Function の両方で動く）
// 日足ベース：その日の終値でシグナルを判定し、翌営業日の始値で約定する。通常は買い、side: "short" なら空売り。

export const STRATEGIES = {
  sma: {
    group: "trend",
    label: "移動平均クロス",
    desc: "短期の移動平均が長期を上回ったら買い、下回ったら売り。",
    params: [
      { key: "short", label: "短期（日）", def: 5, min: 2, max: 200 },
      { key: "long", label: "長期（日）", def: 25, min: 3, max: 400 },
    ],
  },
  rsi: {
    group: "rev",
    label: "RSI逆張り",
    desc: "RSIが「買い」の値を下回ったら買い、「売り」の値を上回ったら売り。",
    params: [
      { key: "period", label: "期間（日）", def: 14, min: 2, max: 100 },
      { key: "buy", label: "買い（未満）", def: 30, min: 1, max: 99 },
      { key: "sell", label: "売り（超え）", def: 70, min: 1, max: 99 },
    ],
  },
  breakout: {
    group: "break",
    label: "高値ブレイク",
    desc: "終値が過去N日の高値を超えたら買い、過去M日の安値を割ったら売り。",
    params: [
      { key: "entry", label: "買い：高値（日）", def: 20, min: 2, max: 300 },
      { key: "exit", label: "売り：安値（日）", def: 10, min: 2, max: 300 },
    ],
  },
  boll: {
    group: "rev",
    label: "ボリンジャー逆張り",
    desc: "終値がボリンジャーバンドの下限（平均−σ×倍率）を割ったら買い、平均線まで戻ったら売り。",
    params: [
      { key: "period", label: "期間（日）", def: 20, min: 5, max: 200 },
      { key: "k", label: "倍率（σ）", def: 2, min: 0.5, max: 4, step: 0.1 },
    ],
  },
  macd: {
    group: "trend",
    label: "MACDクロス",
    desc: "MACD（短期EMA−長期EMA）がシグナル線を上回ったら買い、下回ったら売り。",
    params: [
      { key: "fast", label: "短期EMA", def: 12, min: 2, max: 100 },
      { key: "slow", label: "長期EMA", def: 26, min: 3, max: 300 },
      { key: "signal", label: "シグナル", def: 9, min: 2, max: 100 },
    ],
  },
  roc: {
    group: "trend",
    label: "モメンタム（騰落率）",
    desc: "N日前と比べた上昇率が基準を超えていたら持つ、下回ったら売る。上がっているものに乗る順張り。",
    params: [
      { key: "period", label: "比較（日前）", def: 60, min: 5, max: 300 },
      { key: "th", label: "基準（%）", def: 0, min: -20, max: 50, step: 0.5 },
    ],
  },
  stoch: {
    group: "rev",
    label: "ストキャスティクス逆張り",
    desc: "直近N日の値幅の中で終値が下のほう（%Kが「買い」未満）なら買い、上のほう（「売り」超え）で売り。",
    params: [
      { key: "period", label: "期間（日）", def: 14, min: 3, max: 100 },
      { key: "buy", label: "買い（未満）", def: 20, min: 1, max: 99 },
      { key: "sell", label: "売り（超え）", def: 80, min: 1, max: 99 },
      { key: "smooth", label: "平滑（1=ファスト・3=スロー）", def: 1, min: 1, max: 5 },
    ],
  },
  tma: {
    group: "trend",
    label: "3本の移動平均（パーフェクトオーダー）",
    desc: "短期＞中期＞長期の順に並んだら買い、並びが崩れたら売り。だましが少ない代わりに売買は遅め。",
    params: [
      { key: "short", label: "短期（日）", def: 5, min: 2, max: 100 },
      { key: "mid", label: "中期（日）", def: 25, min: 3, max: 200 },
      { key: "long", label: "長期（日）", def: 75, min: 5, max: 400 },
    ],
  },
  dip: {
    group: "rev",
    label: "連続下落の押し目買い",
    desc: "終値がN日続けて下がったら買い、終値がM日移動平均を上回ったら売り。短期の反発を狙う。",
    params: [
      { key: "down", label: "連続下落（日）", def: 3, min: 2, max: 10 },
      { key: "exit", label: "売り：移動平均（日）", def: 5, min: 2, max: 50 },
    ],
  },
  tom: {
    group: "etc",
    label: "月末・月初だけ持つ",
    desc: "毎月「開始日」以降から翌月「終了日」までだけ持つ。月の変わり目は上がりやすいという経験則。",
    params: [
      { key: "from", label: "開始日（日）", def: 25, min: 15, max: 31 },
      { key: "to", label: "終了日（日）", def: 3, min: 1, max: 10 },
    ],
  },
  fear: {
    group: "etc",
    label: "恐怖指数の逆張り",
    desc: "恐怖指数（VIX・日経VI）が「仕掛け」を超えたら持ち、「手じまい」を下回ったら手放す。みんなが怖がっているときに入る。",
    needsVol: true,
    params: [
      { key: "buy", label: "仕掛け（超え）", def: 30, min: 10, max: 80 },
      { key: "sell", label: "手じまい（未満）", def: 20, min: 8, max: 60 },
    ],
  },
  fearpeak: {
    group: "etc",
    label: "恐怖指数のピークアウト",
    desc: "恐怖指数が直近20日の高値（「高値」以上）から「下落%」だけ下がったら持ち、「手じまい」を下回ったら手放す。落ち着き始めを待ってから入る。",
    needsVol: true,
    params: [
      { key: "th", label: "高値（以上）", def: 30, min: 15, max: 80 },
      { key: "drop", label: "下落（%）", def: 20, min: 5, max: 60 },
      { key: "sell", label: "手じまい（未満）", def: 18, min: 8, max: 60 },
    ],
  },
  ema: {
    group: "trend",
    label: "EMAクロス（指数移動平均）",
    desc: "最近の値を重く見る移動平均（EMA）を2本使う。短期が長期を上回ったら買い、下回ったら売り。普通の移動平均より反応が早い。",
    params: [
      { key: "short", label: "短期EMA（日）", def: 12, min: 2, max: 200 },
      { key: "long", label: "長期EMA（日）", def: 26, min: 3, max: 400 },
    ],
  },
  ichimoku: {
    group: "trend",
    label: "一目均衡表（三役好転）",
    desc: "転換線＞基準線、終値が雲の上、遅行線が26日前の終値より上（三役好転）で買い、終値が雲の中に入ったら売り。",
    params: [
      { key: "tenkan", label: "転換線（日）", def: 9, min: 3, max: 60 },
      { key: "kijun", label: "基準線（日）", def: 26, min: 5, max: 120 },
      { key: "senkou", label: "先行スパンB（日）", def: 52, min: 10, max: 240 },
    ],
  },
  psar: {
    group: "trend",
    label: "パラボリックSAR",
    desc: "株価の下に点（SAR）があるあいだ持ち、株価がSARを割ったら売る。上昇が続くほどSARが近づいてくる、追いかける損切り線。",
    params: [
      { key: "step", label: "加速の幅", def: 0.02, min: 0.01, max: 0.1, step: 0.01 },
      { key: "max", label: "加速の上限", def: 0.2, min: 0.1, max: 0.5, step: 0.05 },
    ],
  },
  supertrend: {
    group: "trend",
    label: "スーパートレンド",
    desc: "値動きの大きさ（ATR）で上下に線を引き、終値が上の線を超えたら買い、下の線を割ったら売り。トレンドが続く限り持ち続ける。",
    params: [
      { key: "period", label: "ATR（日）", def: 10, min: 3, max: 100 },
      { key: "mult", label: "倍率", def: 3, min: 1, max: 6, step: 0.5 },
    ],
  },
  adx: {
    group: "break",
    label: "ADXブレイク（もみ合い放れ）",
    desc: "トレンドの強さ（ADX）が低い＝もみ合いのときに、直近N日の高値を上抜けたら買い、N日の安値を割ったら売り。",
    params: [
      { key: "period", label: "ADX（日）", def: 14, min: 5, max: 50 },
      { key: "th", label: "もみ合い（ADX未満）", def: 18, min: 10, max: 40 },
      { key: "box", label: "高値・安値（日）", def: 20, min: 5, max: 120 },
    ],
  },
  linreg: {
    group: "trend",
    label: "回帰トレンド",
    desc: "直近N日の終値に直線を引き（回帰線）、線が右肩上がりで終値が線より上なら買い。線の下の帯（σ×倍率）を割るか、線が下向きになったら売り。",
    params: [
      { key: "period", label: "期間（日）", def: 50, min: 10, max: 300 },
      { key: "k", label: "下の帯（σ）", def: 2, min: 0.5, max: 4, step: 0.5 },
    ],
  },
  rating: {
    group: "trend",
    label: "テクニカル評価（総合）",
    desc: "移動平均12本と、RSI・ストキャス・MACD・モメンタム・ADX・アルティメットの7指標の「買い／売り」を数えて、−1〜+1の点数にする。点数が「買い」を超えたら買い、「売り」を下回ったら売り。",
    params: [
      { key: "buy", label: "買い（超え）", def: 0.3, min: 0, max: 1, step: 0.05 },
      { key: "sell", label: "売り（未満）", def: 0, min: -1, max: 0.5, step: 0.05 },
    ],
  },
  keltner: {
    group: "break",
    label: "ケルトナーチャネル・ブレイク",
    desc: "EMAの上下にATR×倍率の帯を引き、終値が上の帯を超えたら買い、EMAを割ったら売り。勢いよく動き出したところに乗る。",
    params: [
      { key: "period", label: "期間（日）", def: 20, min: 5, max: 100 },
      { key: "mult", label: "倍率（ATR）", def: 2, min: 0.5, max: 4, step: 0.5 },
    ],
  },
  volexp: {
    group: "break",
    label: "ボラティリティ拡大",
    desc: "その日の値幅がふだん（ATR）の何倍にも広がり、高値近くで引けた陽線で買い。終値がM日移動平均を割ったら売り。",
    params: [
      { key: "period", label: "ATR（日）", def: 14, min: 5, max: 60 },
      { key: "k", label: "値幅（ATRの倍）", def: 1.5, min: 1, max: 4, step: 0.1 },
      { key: "exit", label: "売り：移動平均（日）", def: 10, min: 3, max: 60 },
    ],
  },
  insidebar: {
    group: "break",
    label: "インサイドバー・ブレイク",
    desc: "前日の値幅が前々日の値幅に収まった（はらみ足＝力をためている）あと、前々日の高値を上抜けたら買い。前々日の安値を割るか、N日たったら売り。",
    params: [
      { key: "hold", label: "最長で持つ（日）", def: 10, min: 2, max: 60 },
    ],
  },
  pivot: {
    group: "break",
    label: "ピボット反転（直近の山・谷）",
    desc: "左右の足より高い「山」と低い「谷」を見つけ、直近の山を上抜けたら買い、直近の谷を割ったら売り。",
    params: [
      { key: "left", label: "左の足（本）", def: 4, min: 1, max: 20 },
      { key: "right", label: "右の足（本）", def: 2, min: 1, max: 20 },
    ],
  },
  volume: {
    group: "break",
    label: "出来高急増",
    desc: "出来高がふだん（N日平均）の何倍にも膨らんだ陽線で買い。終値がM日移動平均を割ったら売り。大口の買いに乗る。",
    params: [
      { key: "period", label: "出来高の平均（日）", def: 20, min: 5, max: 100 },
      { key: "k", label: "急増（倍）", def: 2, min: 1.2, max: 6, step: 0.1 },
      { key: "exit", label: "売り：移動平均（日）", def: 10, min: 3, max: 60 },
    ],
  },
  vwap: {
    group: "break",
    label: "VWAP（出来高加重平均）",
    desc: "直近N日の「出来高で重みをつけた平均価格（VWAP）」より終値が上なら持ち、下回ったら売る。多くの人の平均買値より上か下かを見る。",
    params: [
      { key: "period", label: "期間（日）", def: 20, min: 5, max: 200 },
    ],
  },
  vprofile: {
    group: "break",
    label: "価格帯別出来高ブレイク",
    desc: "直近N日で出来高が多かった価格帯（バリューエリア＝出来高の7割が集まる範囲）を求め、その上端を上抜けたら買い、一番売買の多い価格（POC）を割ったら売り。",
    params: [
      { key: "period", label: "期間（日）", def: 60, min: 20, max: 250 },
    ],
  },
  uo: {
    group: "rev",
    label: "アルティメット・オシレーター逆張り",
    desc: "7日・14日・28日の3つの期間で買いの強さをまとめた指標。「買い」を下回ったら買い、「売り」を上回ったら売り。RSIよりだましが少ない。",
    params: [
      { key: "buy", label: "買い（未満）", def: 35, min: 10, max: 50 },
      { key: "sell", label: "売り（超え）", def: 65, min: 50, max: 90 },
    ],
  },
  fibo: {
    group: "rev",
    label: "フィボナッチ押し目買い",
    desc: "直近N日の上昇（安値→高値）に対して、決まった割合だけ下げた水準（38.2%・50%・61.8%）まで押して戻したら買い。目標まで上がるか、元の安値を割るか、60日たったら売り。",
    params: [
      { key: "look", label: "見る期間（日）", def: 60, min: 20, max: 250 },
      { key: "swing", label: "上昇幅（%以上）", def: 10, min: 3, max: 50 },
      { key: "level", label: "押し目の深さ", def: 1, min: 0, max: 2, options: ["38.2%", "50%", "61.8%"] },
      { key: "target", label: "利確の目標", def: 0, min: 0, max: 2, options: ["前の高値", "127.2%", "161.8%"] },
    ],
  },
  candle: {
    group: "pat",
    label: "ローソク足パターン",
    desc: "選んだ足の形が出た翌日に入り、反対向きのパターンが出るか、N日たったら手じまう。反転型（ハンマー、包み足など）は、その前に下げている（空売り向けは上げている）ときだけ数える。",
    params: [
      { key: "pat", label: "パターン", def: 0, min: 0, max: 19, options: ["強気パターンすべて", "包み足（陽の包み）", "ハンマー・たくり線", "逆ハンマー", "明けの明星", "切り込み線", "はらみ足（陽）", "赤三兵", "毛抜き底", "下落後の十字線", "窓を開けて上昇", "上げ三法", "（空売り向け）弱気パターンすべて", "（空売り向け）包み足（陰の包み）", "（空売り向け）流れ星・首つり線", "（空売り向け）宵の明星", "（空売り向け）かぶせ線", "（空売り向け）黒三兵", "（空売り向け）毛抜き天井", "（空売り向け）窓を開けて下落"] },
      { key: "hold", label: "最長で持つ（日）", def: 10, min: 1, max: 60 },
    ],
  },
  chartpat: {
    group: "pat",
    label: "チャートパターン",
    desc: "山と谷を自動で見つけて、選んだ形ができたあと、ネックライン（形の節目）を抜けたら入る。形の高さぶん動いたら利確、形の端を逆に抜けたら損切り、N日たったら手じまい。",
    params: [
      { key: "pat", label: "パターン", def: 0, min: 0, max: 8, options: ["強気パターンすべて", "ダブルボトム", "トリプルボトム", "逆三尊（逆ヘッド＆ショルダー）", "カップ・ウィズ・ハンドル", "（空売り向け）弱気パターンすべて", "（空売り向け）ダブルトップ", "（空売り向け）トリプルトップ", "（空売り向け）三尊（ヘッド＆ショルダー）"] },
      { key: "width", label: "山・谷の幅（本）", def: 5, min: 2, max: 20 },
      { key: "tol", label: "高さのずれ（%以内）", def: 3, min: 0.5, max: 10, step: 0.5 },
      { key: "hold", label: "最長で持つ（日）", def: 60, min: 5, max: 250 },
    ],
  },
  rotation: {
    group: "rot",
    label: "資産の乗り換え（強いものを持つ）",
    desc: "入れた銘柄（例：SPY・TLT・GLD）の中から、直近N日の上昇率が高い上位だけを持ち、決まったタイミングで入れかえる。上昇率が「基準」以下なら持たずに現金で待つ。",
    multi: true,
    params: [
      { key: "period", label: "比べる期間（日）", def: 126, min: 20, max: 300 },
      { key: "top", label: "持つ数", def: 1, min: 1, max: 5 },
      { key: "th", label: "基準（%超）", def: 0, min: -20, max: 30, step: 0.5 },
      { key: "rebal", label: "入れかえ", def: 0, min: 0, max: 2, options: ["毎月", "毎週", "毎日"] },
    ],
  },
  hold: {
    group: "etc",
    label: "買って持ち続ける",
    desc: "最初に買って、そのまま持ち続ける（比較用）。",
    params: [],
  },
};

// 戦略の並び（画面の見出し）
export const STRATEGY_GROUPS = { trend: "トレンドに乗る", rot: "資産の乗り換え", break: "ブレイク・出来高で入る", rev: "逆張り・押し目", pat: "パターン", etc: "季節・恐怖指数・比較用" };

export const DEFAULT_CFG = {
  strategy: "sma",
  params: { short: 5, long: 25 },
  symbols: [],
  initialCash: 1_000_000,
  lot: 100,            // 売買単位（日本株は100株、米国株は1株）
  // 1回に買う量の決め方。pct=資産の割合（maxPosPct と銘柄数の等分）/ cash=金額で固定 / shares=株数で固定
  // risk=損切りにかかったときの損が資産の sizeVal% になる量（損切りの設定が必要。なければ pct と同じ）
  sizeMode: "pct",
  sizeVal: 0,
  feePct: 0,           // 手数料（約定金額に対する%）
  slipPct: 0.1,        // スリッページ（想定より不利な値段で約定する分、%）
  slPct: 0,            // 損切り（買値から何%下がったら売るか。0=なし）
  tpPct: 0,            // 利確（買値から何%上がったら売るか。0=なし）
  maxPosPct: 100,      // 1銘柄に使う上限（資産に対する%。銘柄数で等分した値と小さい方を使う）
  maxTradesPerDay: 4,  // 1日の約定回数の上限
  maxDailyLossPct: 5,  // 1日でこれ以上資産が減ったら停止（%）
  maxDrawdownPct: 20,  // 最高値からこれ以上資産が減ったら停止（%）
  side: "long",        // long=買い / short=空売り（シグナルが出たら売りで入り、消えたら買い戻す）
  borrowPct: 1,        // 空売りの貸株料など（年率%）
  fearSym: "",         // 恐怖指数を使う戦略で見る指数（VIX / NKVI）
  fearLag: false,      // 日本株で VIX を見るとき、前日までの値で判定する
  lev: 1,              // レバレッジ型ETFを想定した計算（毎日、元の値動きの lev 倍。1=使わない）
  levCostPct: 1,       // レバレッジ型ETFの経費・金利コスト（年率%）
  taxPct: 0,           // 税金（利益にかかる%。特定口座は 20.315、NISA は 0）。同じ年の損失とは相殺する
  trendMa: 0,          // トレンド条件：終値がこの日数の移動平均より上のときだけ持つ（0=使わない）
  // 相場フィルター（市況）。mode: off=使わない / auto=下の条件で判定 / bull=強気で固定 / bear=弱気で固定
  // action は弱気のときの動き: nobuy=新しく買わない / exit=持ち株も売って待つ / half=買う量を半分にする
  // filters は条件の並び。1つでも「弱気」と判定したら、その日は弱気。各条件:
  //   kind: trend（key の終値が ma 日線より cond=above 上 / below 下）
  //         level（key の値が th より op=gt 上 / lt 下）
  //         rate （key の値が days 日前より th 以上 dir=up 上がった / down 下がった）
  //         dd   （key の終値が、直近 days 本の高値から th% 以上下げている op=gt / th% 以内 op=lt）
  //         season（月が m1〜m2 の間。年をまたぐ指定もできる。key は要らない）
  //   key : データの名前 "JP:1306" "US:GLD" "IX:VIX" "IX:FF" など
  //   role: avoid=当てはまる日は弱気 / only=当てはまらない日は弱気（＝当てはまる日だけ売買）
  //   lag : 日本株で米国のデータを見るとき、前日までの値で判定する
  regime: { mode: "off", action: "nobuy", filters: [] },
};

export function normalizeCfg(c) {
  const cfg = { ...DEFAULT_CFG, ...(c || {}) };
  const st = STRATEGIES[cfg.strategy] ? cfg.strategy : "sma";
  const params = normParams(st, cfg.params);
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    strategy: st,
    params,
    symbols: [...new Set((cfg.symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 10),
    initialCash: num(cfg.initialCash, 1, 1e12, DEFAULT_CFG.initialCash),
    lot: Math.round(num(cfg.lot, 1, 10000, 1)),
    sizeMode: ["cash", "shares", "risk"].includes(cfg.sizeMode) ? cfg.sizeMode : "pct",
    sizeVal: num(cfg.sizeVal, 0, 1e12, 0),
    feePct: num(cfg.feePct, 0, 5, 0),
    slipPct: num(cfg.slipPct, 0, 5, 0.1),
    slPct: num(cfg.slPct, 0, 90, 0),
    tpPct: num(cfg.tpPct, 0, 1000, 0),
    maxPosPct: num(cfg.maxPosPct, 1, 100, 100),
    maxTradesPerDay: Math.round(num(cfg.maxTradesPerDay, 1, 100, 4)),
    maxDailyLossPct: num(cfg.maxDailyLossPct, 0, 100, 5),
    maxDrawdownPct: num(cfg.maxDrawdownPct, 0, 100, 20),
    side: cfg.side === "short" ? "short" : "long",
    borrowPct: num(cfg.borrowPct, 0, 20, 1),
    fearSym: ["VIX", "NKVI"].includes(cfg.fearSym) ? cfg.fearSym : "",
    fearLag: !!cfg.fearLag,
    trendMa: Math.round(num(cfg.trendMa, 0, 400, 0)),
    lev: Math.round(num(cfg.lev, 1, 3, 1) * 2) / 2,
    levCostPct: num(cfg.levCostPct, 0, 10, 1),
    taxPct: num(cfg.taxPct, 0, 60, 0),
    regime: {
      mode: ["auto", "bull", "bear"].includes(cfg.regime?.mode) ? cfg.regime.mode : "off",
      action: ["exit", "half"].includes(cfg.regime?.action) ? cfg.regime.action : "nobuy",
      filters: (Array.isArray(cfg.regime?.filters) ? cfg.regime.filters : []).map(f => normalizeFilter(f, num)).filter(Boolean).slice(0, 8),
    },
  };
}

// 戦略の数値を、決められた範囲と刻みにそろえる
export function normParams(st, given) {
  const params = {};
  for (const p of STRATEGIES[st].params) {
    const v = Number(given?.[p.key]);
    const step = p.step || 1;
    params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, Math.round(v / step) * step)) : p.def;
    if (p.step) params[p.key] = Number(params[p.key].toFixed(4));
  }
  return params;
}

function normalizeFilter(f, num) {
  if (f?.kind === "season") return { kind: "season", key: "", role: f.role === "only" ? "only" : "avoid", lag: false, m1: Math.round(num(f.m1, 1, 12, 5)), m2: Math.round(num(f.m2, 1, 12, 10)) };
  const key = String(f?.key ?? "").trim().toUpperCase();
  if (!/^(JP|US|IX):[A-Z0-9.\-]{1,10}$/.test(key)) return null;
  const base = { key, role: f.role === "only" ? "only" : "avoid", lag: !!f.lag };
  if (f.kind === "trend") return { kind: "trend", ...base, ma: Math.round(num(f.ma, 5, 400, 200)), cond: f.cond === "above" ? "above" : "below" };
  if (f.kind === "level") return { kind: "level", ...base, op: f.op === "lt" ? "lt" : "gt", th: num(f.th, 0, 1000, 25) };
  // sig: key の値動きに戦略をあてはめ、その戦略が「持つ」(cond=on) / 「持たない」(off) の状態か
  if (f.kind === "sig") return STRATEGIES[f.strat] && !STRATEGIES[f.strat].needsVol && f.strat !== "hold" && !STRATEGIES[f.strat].multi ? { kind: "sig", ...base, strat: f.strat, params: normParams(f.strat, f.params), cond: f.cond === "off" ? "off" : "on" } : null;
  // osc: key の値動きから指標（rsi / adx / atrp=ATRの株価比%）を計算し、th より op=gt 上 / lt 下
  if (f.kind === "osc") return ["rsi", "adx", "atrp"].includes(f.osc) ? { kind: "osc", ...base, osc: f.osc, n: Math.round(num(f.n, 2, 200, 14)), op: f.op === "lt" ? "lt" : "gt", th: num(f.th, 0, 100, 50) } : null;
  if (f.kind === "dd") return { kind: "dd", ...base, op: f.op === "lt" ? "lt" : "gt", days: Math.round(num(f.days, 20, 750, 250)), th: num(f.th, 0, 90, 10) };
  if (f.kind === "rate") return { kind: "rate", ...base, dir: f.dir === "down" ? "down" : "up", days: Math.round(num(f.days, 20, 750, 180)), th: num(f.th, 0, 10, 0.25) };
  return null;
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

// 値動きの大きさ（ATR、ワイルダーの平均）
function atrArr(bars, n) {
  const out = new Array(bars.length).fill(null);
  let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i < n) a += tr;
    else if (i === n) { a = (a + tr) / n; out[i] = a; }
    else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}
// トレンドの強さ ADX と、上向きの力 +DI・下向きの力 −DI
function dmiArr(bars, n) {
  const L = bars.length, adx = new Array(L).fill(null), pdi = new Array(L).fill(null), mdi = new Array(L).fill(null);
  let tr = 0, p = 0, m = 0, dxSum = 0, cnt = 0, ad = null;
  for (let i = 1; i < L; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { tr += t; p += pdm; m += mdm; if (i < n) continue; }
    else { tr = tr - tr / n + t; p = p - p / n + pdm; m = m - m / n + mdm; }
    const P = tr ? 100 * p / tr : 0, M = tr ? 100 * m / tr : 0, dx = P + M ? 100 * Math.abs(P - M) / (P + M) : 0;
    pdi[i] = P; mdi[i] = M;
    if (ad == null) { dxSum += dx; cnt++; if (cnt === n) { ad = dxSum / n; adx[i] = ad; } }
    else { ad = (ad * (n - 1) + dx) / n; adx[i] = ad; }
  }
  return { adx, pdi, mdi };
}
// 期間 n の最高値・最安値（i を含む）
const hhv = (bars, i, n, f = "h") => { let v = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) v = Math.max(v, bars[k][f]); return v; };
const llv = (bars, i, n, f = "l") => { let v = Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) v = Math.min(v, bars[k][f]); return v; };
// アルティメット・オシレーター（7・14・28日）
function uoArr(bars) {
  const L = bars.length, out = new Array(L).fill(null), bp = [0], trr = [0];
  for (let i = 1; i < L; i++) {
    const lo = Math.min(bars[i].l, bars[i - 1].c), hi = Math.max(bars[i].h, bars[i - 1].c);
    bp.push(bars[i].c - lo); trr.push(hi - lo);
  }
  const avg = (i, n) => { let a = 0, b = 0; for (let k = i - n + 1; k <= i; k++) { a += bp[k]; b += trr[k]; } return b ? a / b : 0.5; };
  for (let i = 28; i < L; i++) out[i] = 100 * (4 * avg(i, 7) + 2 * avg(i, 14) + avg(i, 28)) / 7;
  return out;
}
// ストキャスティクスの %K（smooth>1 ならスロー）
function stochK(bars, n, smooth = 1) {
  const L = bars.length, k = new Array(L).fill(null);
  for (let i = n - 1; i < L; i++) { const hh = hhv(bars, i, n), ll = llv(bars, i, n); k[i] = hh > ll ? (bars[i].c - ll) / (hh - ll) * 100 : 50; }
  if (smooth <= 1) return k;
  const out = new Array(L).fill(null);
  for (let i = n - 1 + smooth - 1; i < L; i++) { let s = 0; for (let j = i - smooth + 1; j <= i; j++) s += k[j]; out[i] = s / smooth; }
  return out;
}

/* ---------- ローソク足の形 ---------- */
// i 日目の足が、各パターンにあてはまるか。down / up は「その前に下げていた / 上げていた」
function candleAt(bars, i, down, up) {
  const B = j => bars[j], body = j => Math.abs(B(j).c - B(j).o), rng = j => Math.max(B(j).h - B(j).l, 1e-9);
  const green = j => B(j).c > B(j).o, red = j => B(j).c < B(j).o;
  const upSh = j => B(j).h - Math.max(B(j).o, B(j).c), loSh = j => Math.min(B(j).o, B(j).c) - B(j).l;
  const longBody = j => body(j) >= rng(j) * 0.6;
  const mid = j => (B(j).o + B(j).c) / 2;
  const r = {};
  if (i < 1) return r;
  const a = i - 1;
  // 強気
  r[1] = down && red(a) && green(i) && B(i).o <= B(a).c && B(i).c >= B(a).o && body(i) > body(a);
  r[2] = down && loSh(i) >= 2 * body(i) && upSh(i) <= Math.max(body(i) * 0.5, rng(i) * 0.1) && body(i) > 0;
  r[3] = down && upSh(i) >= 2 * body(i) && loSh(i) <= Math.max(body(i) * 0.5, rng(i) * 0.1) && body(i) > 0;
  r[5] = down && red(a) && longBody(a) && green(i) && B(i).o < B(a).c && B(i).c > mid(a) && B(i).c < B(a).o;
  r[6] = down && red(a) && longBody(a) && green(i) && B(i).o > B(a).c && B(i).c < B(a).o && body(i) < body(a) * 0.6;
  r[8] = down && red(a) && green(i) && Math.abs(B(i).l - B(a).l) <= B(i).l * 0.002;
  r[9] = down && body(i) <= rng(i) * 0.1 && rng(i) > 0;
  r[10] = B(i).l > B(a).h;
  // 弱気（空売り向け）
  r[13] = up && green(a) && red(i) && B(i).o >= B(a).c && B(i).c <= B(a).o && body(i) > body(a);
  r[14] = up && ((upSh(i) >= 2 * body(i) && loSh(i) <= Math.max(body(i) * 0.5, rng(i) * 0.1)) || (loSh(i) >= 2 * body(i) && upSh(i) <= Math.max(body(i) * 0.5, rng(i) * 0.1))) && body(i) > 0;
  r[16] = up && green(a) && longBody(a) && red(i) && B(i).o > B(a).c && B(i).c < mid(a) && B(i).c > B(a).o;
  r[18] = up && green(a) && red(i) && Math.abs(B(i).h - B(a).h) <= B(i).h * 0.002;
  r[19] = B(i).h < B(a).l;
  if (i >= 2) {
    const z = i - 2;
    r[4] = down && red(z) && longBody(z) && body(a) <= body(z) * 0.4 && Math.max(B(a).o, B(a).c) < B(z).c && green(i) && B(i).c > mid(z);
    r[7] = [z, a, i].every(green) && B(a).c > B(z).c && B(i).c > B(a).c && B(a).o > B(z).o && B(a).o < B(z).c && B(i).o > B(a).o && B(i).o < B(a).c && [z, a, i].every(j => upSh(j) <= body(j) * 0.5);
    r[15] = up && green(z) && longBody(z) && body(a) <= body(z) * 0.4 && Math.min(B(a).o, B(a).c) > B(z).c && red(i) && B(i).c < mid(z);
    r[17] = [z, a, i].every(red) && B(a).c < B(z).c && B(i).c < B(a).c && B(a).o < B(z).o && B(a).o > B(z).c && B(i).o < B(a).o && B(i).o > B(a).c && [z, a, i].every(j => loSh(j) <= body(j) * 0.5);
  }
  if (i >= 4) {
    const f = i - 4;
    r[11] = green(f) && longBody(f) && [i - 3, i - 2, i - 1].every(j => body(j) < body(f) * 0.6 && B(j).h <= B(f).h && B(j).l >= B(f).l) && green(i) && B(i).c > B(f).c;
  }
  return r;
}
const BULL_PATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], BEAR_PATS = [13, 14, 15, 16, 17, 18, 19];

/* ---------- チャートパターン（山と谷から） ---------- */
// width 本の左右より高い足を山、低い足を谷とする。i 日目には i-width までの山・谷しか分からない
function chartSignals(bars, p) {
  const n = bars.length, w = p.width, tol = p.tol / 100, out = new Array(n).fill(0);
  const bear = p.pat >= 5;
  const want = bear ? (p.pat === 5 ? [6, 7, 8] : [p.pat]) : (p.pat === 0 ? [1, 2, 3, 4] : [p.pat]);
  const piv = []; // { t: "H"|"L", i, v }
  let setup = null, pos = null;
  const near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * tol;
  const addPivot = q => {
    const last = piv[piv.length - 1];
    if (last && last.t === q.t) { if (q.t === "H" ? q.v > last.v : q.v < last.v) piv[piv.length - 1] = q; }
    else piv.push(q);
    if (piv.length > 12) piv.shift();
  };
  const find = () => {
    const P = piv, k = P.length, lastT = P[k - 1]?.t;
    const sets = [];
    // 強気：最後が谷
    if (lastT === "L") {
      const [L1, H1, L2] = P.slice(-3);
      if (k >= 3 && want.includes(1) && near(L1.v, L2.v) && H1.v > Math.max(L1.v, L2.v) * (1 + 2 * tol)) sets.push({ neck: H1.v, stop: Math.min(L1.v, L2.v) });
      if (k >= 5) {
        const [A, H1b, B, H2b, C] = P.slice(-5);
        const neck = Math.max(H1b.v, H2b.v);
        if (want.includes(2) && near(A.v, B.v) && near(B.v, C.v) && near(A.v, C.v)) sets.push({ neck, stop: Math.min(A.v, B.v, C.v) });
        if (want.includes(3) && B.v < A.v * (1 - tol) && B.v < C.v * (1 - tol) && near(A.v, C.v)) sets.push({ neck, stop: B.v });
      }
      if (k >= 4 && want.includes(4)) {
        const [R1, Cb, R2, Hd] = P.slice(-4);
        const depth = (R1.v - Cb.v) / R1.v;
        if (R1.t === "H" && near(R1.v, R2.v) && depth >= 0.1 && depth <= 0.5 && Hd.v > Cb.v + (R1.v - Cb.v) * 0.5) sets.push({ neck: Math.max(R1.v, R2.v), stop: Hd.v });
      }
    }
    // 弱気：最後が山
    if (lastT === "H") {
      const [H1, L1, H2] = P.slice(-3);
      if (k >= 3 && want.includes(6) && near(H1.v, H2.v) && L1.v < Math.min(H1.v, H2.v) * (1 - 2 * tol)) sets.push({ neck: L1.v, stop: Math.max(H1.v, H2.v) });
      if (k >= 5) {
        const [A, L1b, B, L2b, C] = P.slice(-5);
        const neck = Math.min(L1b.v, L2b.v);
        if (want.includes(7) && near(A.v, B.v) && near(B.v, C.v) && near(A.v, C.v)) sets.push({ neck, stop: Math.max(A.v, B.v, C.v) });
        if (want.includes(8) && B.v > A.v * (1 + tol) && B.v > C.v * (1 + tol) && near(A.v, C.v)) sets.push({ neck, stop: B.v });
      }
    }
    return sets[0] || null;
  };
  for (let i = 0; i < n; i++) {
    const j = i - w; // 今日はっきりする山・谷の候補
    if (j >= w) {
      let isH = true, isL = true;
      for (let k = j - w; k <= j + w; k++) { if (k === j) continue; if (bars[k].h > bars[j].h) isH = false; if (bars[k].l < bars[j].l) isL = false; }
      if (isH) addPivot({ t: "H", i: j, v: bars[j].h });
      if (isL) addPivot({ t: "L", i: j, v: bars[j].l });
      if (isH || isL) { const s = find(); if (s) setup = { ...s, from: i }; }
    }
    const c = bars[i].c;
    if (pos) {
      const hit = bear ? c <= pos.target : c >= pos.target, broke = bear ? c > pos.stop : c < pos.stop;
      if (hit || broke || i - pos.at >= p.hold) pos = null;
    } else if (setup) {
      if (bear ? c > setup.stop : c < setup.stop) setup = null;
      else if (i - setup.from > w * 8) setup = null;
      else if (bear ? c < setup.neck : c > setup.neck) {
        const h = Math.abs(setup.neck - setup.stop);
        pos = { at: i, stop: setup.stop, target: bear ? setup.neck - h : setup.neck + h };
        setup = null;
      }
    }
    out[i] = pos ? 1 : 0;
  }
  return out;
}

// テクニカル評価：移動平均12本と指標7つの多数決（−1〜+1）
function ratingArr(bars) {
  const c = bars.map(b => b.c), L = c.length;
  const mas = [10, 20, 30, 50, 100, 200].flatMap(n => [smaArr(c, n), emaArr(c, n)]);
  const rsi = rsiArr(c, 14), st = stochK(bars, 14, 3), ef = emaArr(c, 12), es = emaArr(c, 26), dm = dmiArr(bars, 14), uo = uoArr(bars);
  const macd = c.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null), start = macd.findIndex(v => v != null);
  const sig = new Array(L).fill(null);
  if (start >= 0) { const e = emaArr(macd.slice(start), 9); for (let i = 0; i < e.length; i++) sig[start + i] = e[i]; }
  const out = new Array(L).fill(null);
  for (let i = 0; i < L; i++) {
    const mv = mas.filter(m => m[i] != null).map(m => c[i] > m[i] ? 1 : c[i] < m[i] ? -1 : 0);
    const ov = [];
    if (rsi[i] != null) ov.push(rsi[i] < 30 ? 1 : rsi[i] > 70 ? -1 : 0);
    if (st[i] != null) ov.push(st[i] < 20 ? 1 : st[i] > 80 ? -1 : 0);
    if (macd[i] != null && sig[i] != null) ov.push(macd[i] > sig[i] ? 1 : -1);
    if (i >= 10) ov.push(c[i] > c[i - 10] ? 1 : -1);
    if (dm.adx[i] != null) ov.push(dm.adx[i] > 20 ? (dm.pdi[i] > dm.mdi[i] ? 1 : -1) : 0);
    if (uo[i] != null) ov.push(uo[i] < 30 ? 1 : uo[i] > 70 ? -1 : 0);
    if (mv.length < 4 || ov.length < 3) continue;
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    out[i] = (avg(mv) + avg(ov)) / 2;
  }
  return out;
}

// 各日の「持ちたいか（1）／持ちたくないか（0）」。その日までのデータだけで判定する
// cfg.trendMa があれば、終値がその移動平均より上のときだけ持つ
// vol = { bars, lag }：恐怖指数を使う戦略用
export function signals(bars, strategy, p, trendMa = 0, vol = null) {
  const raw = rawSignals(bars, strategy, p, vol);
  if (!trendMa) return raw;
  const t = smaArr(bars.map(b => b.c), trendMa);
  return raw.map((v, i) => v && t[i] != null && bars[i].c > t[i] ? 1 : 0);
}

function rawSignals(bars, strategy, p, vol) {
  const n = bars.length, c = bars.map(b => b.c), out = new Array(n).fill(0);
  if (strategy === "hold") return out.fill(1);
  if (strategy === "fear" || strategy === "fearpeak") {
    const vb = vol?.bars;
    if (!vb?.length) return out;
    let ip = -1, pos = 0;
    const recent = []; // 直近20個の恐怖指数
    for (let i = 0; i < n; i++) {
      const D = bars[i].d;
      while (ip + 1 < vb.length && (vol.lag ? vb[ip + 1].d < D : vb[ip + 1].d <= D)) { ip++; recent.push(vb[ip].c); if (recent.length > 20) recent.shift(); }
      if (ip >= 0) {
        const v = vb[ip].c;
        if (strategy === "fear") { if (!pos && v > p.buy) pos = 1; else if (pos && v < p.sell) pos = 0; }
        else { const hi = Math.max(...recent); if (!pos && hi >= p.th && v <= hi * (1 - p.drop / 100) && v >= p.sell) pos = 1; else if (pos && v < p.sell) pos = 0; }
      }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "ema") {
    const s = emaArr(c, p.short), l = emaArr(c, p.long);
    for (let i = 0; i < n; i++) out[i] = s[i] != null && l[i] != null && s[i] > l[i] ? 1 : 0;
    return out;
  }
  if (strategy === "ichimoku") {
    const mid = (i, k) => (hhv(bars, i, k) + llv(bars, i, k)) / 2;
    const tk = [], kj = [], sa = [], sb = [];
    for (let i = 0; i < n; i++) {
      tk[i] = i >= p.tenkan - 1 ? mid(i, p.tenkan) : null;
      kj[i] = i >= p.kijun - 1 ? mid(i, p.kijun) : null;
      sa[i] = tk[i] != null && kj[i] != null ? (tk[i] + kj[i]) / 2 : null;
      sb[i] = i >= p.senkou - 1 ? mid(i, p.senkou) : null;
    }
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const j = i - p.kijun; // 雲は基準線の日数だけ先にずらして描く
      if (j >= 0 && sa[j] != null && sb[j] != null && tk[i] != null && kj[i] != null) {
        const top = Math.max(sa[j], sb[j]);
        if (!pos && tk[i] > kj[i] && c[i] > top && c[i] > c[i - p.kijun]) pos = 1;
        else if (pos && c[i] < top) pos = 0;
      }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "psar") {
    if (n < 3) return out;
    let isUp = c[1] >= c[0], af = p.step, ep = isUp ? Math.max(bars[0].h, bars[1].h) : Math.min(bars[0].l, bars[1].l), sar = isUp ? Math.min(bars[0].l, bars[1].l) : Math.max(bars[0].h, bars[1].h);
    for (let i = 2; i < n; i++) {
      sar += af * (ep - sar);
      if (isUp) {
        sar = Math.min(sar, bars[i - 1].l, bars[i - 2].l);
        if (bars[i].l < sar) { isUp = false; sar = ep; ep = bars[i].l; af = p.step; }
        else if (bars[i].h > ep) { ep = bars[i].h; af = Math.min(p.max, af + p.step); }
      } else {
        sar = Math.max(sar, bars[i - 1].h, bars[i - 2].h);
        if (bars[i].h > sar) { isUp = true; sar = ep; ep = bars[i].h; af = p.step; }
        else if (bars[i].l < ep) { ep = bars[i].l; af = Math.min(p.max, af + p.step); }
      }
      out[i] = isUp ? 1 : 0;
    }
    return out;
  }
  if (strategy === "supertrend") {
    const a = atrArr(bars, p.period);
    let fu = null, fl = null, dir = 0;
    for (let i = 1; i < n; i++) {
      if (a[i] == null) continue;
      const hl = (bars[i].h + bars[i].l) / 2, bu = hl + p.mult * a[i], bl = hl - p.mult * a[i];
      fu = fu == null || bu < fu || c[i - 1] > fu ? bu : fu;
      fl = fl == null || bl > fl || c[i - 1] < fl ? bl : fl;
      if (!dir) dir = c[i] > hl ? 1 : -1;
      else if (dir === 1 && c[i] < fl) dir = -1;
      else if (dir === -1 && c[i] > fu) dir = 1;
      out[i] = dir === 1 ? 1 : 0;
    }
    return out;
  }
  if (strategy === "adx") {
    const d = dmiArr(bars, p.period);
    let pos = 0;
    for (let i = p.box; i < n; i++) {
      const hh = hhv(bars, i - 1, p.box), ll = llv(bars, i - 1, p.box);
      if (!pos && d.adx[i - 1] != null && d.adx[i - 1] < p.th && c[i] > hh) pos = 1;
      else if (pos && c[i] < ll) pos = 0;
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "linreg") {
    let pos = 0;
    const N = p.period, sx = N * (N - 1) / 2, sxx = (N - 1) * N * (2 * N - 1) / 6;
    for (let i = N - 1; i < n; i++) {
      let sy = 0, sxy = 0;
      for (let k = 0; k < N; k++) { const y = c[i - N + 1 + k]; sy += y; sxy += k * y; }
      const b = (N * sxy - sx * sy) / (N * sxx - sx * sx), a0 = (sy - b * sx) / N, line = a0 + b * (N - 1);
      let ss = 0; for (let k = 0; k < N; k++) { const e = c[i - N + 1 + k] - (a0 + b * k); ss += e * e; }
      const sd = Math.sqrt(ss / N);
      if (!pos && b > 0 && c[i] > line) pos = 1;
      else if (pos && (b < 0 || c[i] < line - p.k * sd)) pos = 0;
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "rating") {
    const r = ratingArr(bars);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (r[i] != null) { if (!pos && r[i] > p.buy) pos = 1; else if (pos && r[i] < p.sell) pos = 0; }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "keltner") {
    const m = emaArr(c, p.period), a = atrArr(bars, p.period);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (m[i] != null && a[i] != null) { if (!pos && c[i] > m[i] + p.mult * a[i]) pos = 1; else if (pos && c[i] < m[i]) pos = 0; }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "volexp") {
    const a = atrArr(bars, p.period), m = smaArr(c, p.exit);
    let pos = 0;
    for (let i = 1; i < n; i++) {
      const r = bars[i].h - bars[i].l;
      if (!pos && a[i - 1] != null && r > p.k * a[i - 1] && c[i] > bars[i].o && c[i] >= bars[i].l + r * 0.7) pos = 1;
      else if (pos && m[i] != null && c[i] < m[i]) pos = 0;
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "insidebar") {
    let pos = null;
    for (let i = 2; i < n; i++) {
      if (pos) { if (c[i] < pos.stop || i - pos.at >= p.hold) pos = null; }
      else if (bars[i - 1].h < bars[i - 2].h && bars[i - 1].l > bars[i - 2].l && c[i] > bars[i - 2].h) pos = { at: i, stop: bars[i - 2].l };
      out[i] = pos ? 1 : 0;
    }
    return out;
  }
  if (strategy === "pivot") {
    let ph = null, pl = null, pos = 0;
    for (let i = 0; i < n; i++) {
      const j = i - p.right;
      if (j - p.left >= 0) {
        let isH = true, isL = true;
        for (let k = j - p.left; k <= i; k++) { if (k === j) continue; if (bars[k].h >= bars[j].h) isH = false; if (bars[k].l <= bars[j].l) isL = false; }
        if (isH) ph = bars[j].h;
        if (isL) pl = bars[j].l;
      }
      if (!pos && ph != null && c[i] > ph) pos = 1;
      else if (pos && pl != null && c[i] < pl) pos = 0;
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "volume") {
    const m = smaArr(c, p.exit);
    let pos = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const avg = i >= p.period ? sum / p.period : null;
      if (!pos && avg > 0 && bars[i].v > p.k * avg && c[i] > bars[i].o && i > 0 && c[i] > c[i - 1]) pos = 1;
      else if (pos && m[i] != null && c[i] < m[i]) pos = 0;
      out[i] = pos;
      sum += bars[i].v || 0; if (i >= p.period) sum -= bars[i - p.period].v || 0;
    }
    return out;
  }
  if (strategy === "vwap") {
    let pv = 0, vv = 0;
    for (let i = 0; i < n; i++) {
      const tp = (bars[i].h + bars[i].l + c[i]) / 3, v = bars[i].v || 0;
      pv += tp * v; vv += v;
      if (i >= p.period) { const o = bars[i - p.period], ov = o.v || 0; pv -= (o.h + o.l + o.c) / 3 * ov; vv -= ov; }
      out[i] = i >= p.period - 1 && vv > 0 && c[i] > pv / vv ? 1 : 0;
    }
    return out;
  }
  if (strategy === "vprofile") {
    let pos = 0;
    const BINS = 24;
    for (let i = p.period; i < n; i++) {
      let lo = Infinity, hi = -Infinity, tot = 0;
      for (let k = i - p.period; k < i; k++) { lo = Math.min(lo, bars[k].l); hi = Math.max(hi, bars[k].h); tot += bars[k].v || 0; }
      if (!(hi > lo) || !(tot > 0)) { out[i] = pos; continue; }
      const step = (hi - lo) / BINS, vol = new Array(BINS).fill(0);
      for (let k = i - p.period; k < i; k++) { const tp = (bars[k].h + bars[k].l + bars[k].c) / 3; vol[Math.min(BINS - 1, Math.floor((tp - lo) / step))] += bars[k].v || 0; }
      let poc = 0; for (let b = 1; b < BINS; b++) if (vol[b] > vol[poc]) poc = b;
      let a = poc, z = poc, got = vol[poc];
      while (got < tot * 0.7 && (a > 0 || z < BINS - 1)) { const dn = a > 0 ? vol[a - 1] : -1, upv = z < BINS - 1 ? vol[z + 1] : -1; if (upv >= dn) { z++; got += upv; } else { a--; got += dn; } }
      const vah = lo + (z + 1) * step, pocP = lo + (poc + 0.5) * step;
      if (!pos && c[i] > vah) pos = 1; else if (pos && c[i] < pocP) pos = 0;
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "uo") {
    const u = uoArr(bars);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (u[i] != null) { if (!pos && u[i] < p.buy) pos = 1; else if (pos && u[i] > p.sell) pos = 0; }
      out[i] = pos;
    }
    return out;
  }
  if (strategy === "fibo") {
    const lv = [0.382, 0.5, 0.618][p.level], tg = [1, 1.272, 1.618][p.target];
    let pos = null;
    for (let i = p.look; i < n; i++) {
      if (pos) {
        if (c[i] >= pos.target || c[i] < pos.stop || i - pos.at >= 60) pos = null;
      } else {
        // 直近の高値と、その前の安値
        let ih = i - p.look; for (let k = i - p.look; k < i; k++) if (bars[k].h > bars[ih].h) ih = k;
        let il = i - p.look; for (let k = i - p.look; k <= ih; k++) if (bars[k].l < bars[il].l) il = k;
        const H = bars[ih].h, Lw = bars[il].l;
        if (ih > il && Lw > 0 && (H - Lw) / Lw * 100 >= p.swing && i - ih >= 2) {
          const level = H - lv * (H - Lw);
          if (bars[i].l <= level && c[i] > level && c[i] > bars[i].o && llv(bars, i - 1, i - ih) > Lw) pos = { at: i, stop: Lw, target: Lw + tg * (H - Lw) };
        }
      }
      out[i] = pos ? 1 : 0;
    }
    return out;
  }
  if (strategy === "candle") {
    const bearSide = p.pat >= 12;
    const entry = p.pat === 0 ? BULL_PATS : p.pat === 12 ? BEAR_PATS : [p.pat];
    const exitP = bearSide ? BULL_PATS : BEAR_PATS;
    const m = smaArr(c, 10);
    let pos = null;
    for (let i = 1; i < n; i++) {
      // 反転型は、前日の終値が10日線より下（空売り向けは上）のときだけ
      const down = m[i - 1] != null && c[i - 1] < m[i - 1], up = m[i - 1] != null && c[i - 1] > m[i - 1];
      const r = candleAt(bars, i, down, up);
      if (pos) { if (exitP.some(k => r[k]) || i - pos >= p.hold) pos = null; }
      else if (entry.some(k => r[k])) pos = i;
      out[i] = pos != null ? 1 : 0;
    }
    return out;
  }
  if (strategy === "chartpat") return chartSignals(bars, p);
  if (strategy === "rotation") { for (let i = p.period; i < n; i++) out[i] = c[i - p.period] > 0 && (c[i] / c[i - p.period] - 1) * 100 > p.th ? 1 : 0; return out; }
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
    const k = stochK(bars, p.period, p.smooth || 1);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (k[i] != null) { if (!pos && k[i] < p.buy) pos = 1; else if (pos && k[i] > p.sell) pos = 0; }
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
  for (const [s, p] of Object.entries(st.positions)) { const c = st.lastClose[s] ?? p.avg; e += p.short ? p.qty * (p.avg - c) : p.qty * c; }
  return e;
}

// レバレッジ型ETFを想定した値動き：毎日、前日終値からの動きを lev 倍し、経費を日割りで引く
export function levBars(bars, lev, costPct = 1) {
  const out = [];
  const dayCost = costPct / 100 / 252;
  let L = bars.length ? bars[0].c : 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { out.push({ ...b }); continue; }
    const pc = bars[i - 1].c, prevL = L;
    const f = x => Math.max(prevL * 0.01, prevL * (1 + lev * (x / pc - 1) - dayCost));
    L = f(b.c);
    out.push({ d: b.d, o: f(b.o), h: Math.max(f(b.h), f(b.l)), l: Math.min(f(b.h), f(b.l)), c: L, v: b.v });
  }
  return out;
}

// 資産の乗り換え：入れかえの日に、直近 period 日の上昇率が高い上位 top 銘柄だけを「持つ」にする
function rotationSignals(p, data, syms) {
  const dates = [...new Set(syms.flatMap(s => data[s].map(b => b.d)))].sort();
  const idx = {}, out = {};
  for (const s of syms) { idx[s] = new Map(data[s].map((b, i) => [b.d, i])); out[s] = new Array(data[s].length).fill(0); }
  const keyOf = D => p.rebal === 0 ? D.slice(0, 7) : p.rebal === 1 ? Math.floor((Date.parse(D) / 864e5 + 3) / 7) : D;
  let hold = new Set(), last = null;
  for (const D of dates) {
    const k = keyOf(D);
    if (k !== last) {
      last = k;
      const sc = syms.map(s => {
        const i = idx[s].get(D);
        if (i == null || i < p.period) return null;
        const c0 = data[s][i - p.period].c;
        return c0 > 0 ? { s, r: (data[s][i].c / c0 - 1) * 100 } : null;
      }).filter(Boolean).sort((a, b) => b.r - a.r);
      if (sc.length) hold = new Set(sc.slice(0, p.top).filter(x => x.r > p.th).map(x => x.s));
    }
    for (const s of syms) { const i = idx[s].get(D); if (i != null) out[s][i] = hold.has(s) ? 1 : 0; }
  }
  return out;
}

// 相場フィルターの判定を、日付ごとの表（Map: 日付 → 弱気か）にする。自動探索で同じ条件を何度も使うときの計算を省く
export function regimeMap(cfgIn, data, dates) {
  const cfg = normalizeCfg(cfgIn), f = bearTester(cfg.regime, data);
  return new Map(dates.map(D => [D, f(D)]));
}
// 各戦略の「持ちたいか」を前もって計算する（自動探索用）
export function precomputeSignals(cfgIn, data) {
  const cfg = normalizeCfg(cfgIn), syms = cfg.symbols.filter(s => data[s]?.length);
  if (cfg.strategy === "rotation") return rotationSignals(cfg.params, data, syms);
  return Object.fromEntries(syms.map(s => [s, signals(data[s], cfg.strategy, cfg.params, cfg.trendMa, { bars: data["IX:" + cfg.fearSym], lag: cfg.fearLag })]));
}

// 相場フィルターの条件から、「その日は弱気か」を返す関数を作る（日付は古い順に聞くこと）
function bearTester(rg, data) {
  if (rg.mode === "bear") return () => true;
  if (rg.mode !== "auto") return () => false;
  // 各条件を「その日は弱気か」を返す関数にする。その日までに分かっている最後の値で判定（lag なら前日まで）
  const tests = rg.filters.map(f => {
    if (f.kind === "season") {
      const inS = D => { const m = Number(D.slice(5, 7)); return f.m1 <= f.m2 ? m >= f.m1 && m <= f.m2 : m >= f.m1 || m <= f.m2; };
      return D => f.role === "only" ? !inS(D) : inS(D);
    }
    const b = data[f.key];
    if (!b?.length) return null;
    let ip = -1, jp = -1;
    const at = D => { while (ip + 1 < b.length && (f.lag ? b[ip + 1].d < D : b[ip + 1].d <= D)) ip++; return ip; };
    let cond;
    if (f.kind === "trend") { const m = smaArr(b.map(x => x.c), f.ma); cond = i => m[i] == null ? null : (f.cond === "above" ? b[i].c > m[i] : b[i].c <= m[i]); }
    else if (f.kind === "sig") { const sg = signals(b, f.strat, f.params); cond = i => f.cond === "off" ? !sg[i] : !!sg[i]; }
    else if (f.kind === "osc") {
      const v = f.osc === "rsi" ? rsiArr(b.map(x => x.c), f.n) : f.osc === "adx" ? dmiArr(b, f.n).adx : atrArr(b, f.n).map((a, i) => a == null ? null : a / b[i].c * 100);
      cond = i => v[i] == null ? null : (f.op === "gt" ? v[i] > f.th : v[i] < f.th);
    }
    else if (f.kind === "dd") cond = i => {
      let hi = 0; for (let k = Math.max(0, i - f.days + 1); k <= i; k++) hi = Math.max(hi, b[k].c);
      const dd = hi > 0 ? (hi - b[i].c) / hi * 100 : 0;
      return f.op === "gt" ? dd >= f.th : dd <= f.th;
    };
    else if (f.kind === "level") cond = i => f.op === "gt" ? b[i].c > f.th : b[i].c < f.th;
    else cond = i => {
      const t = new Date(b[i].d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - f.days);
      const past = t.toISOString().slice(0, 10);
      while (jp + 1 < b.length && b[jp + 1].d <= past) jp++;
      if (jp < 0) return null;
      const diff = b[i].c - b[jp].c;
      return f.dir === "up" ? diff >= f.th : diff <= -f.th;
    };
    // 分からない日（データ不足）は弱気にしない
    return D => { const i = at(D); if (i < 0) return false; const c = cond(i); return c == null ? false : (f.role === "only" ? !c : c); };
  }).filter(Boolean);
  return D => { let bear = false; for (const t of tests) if (t(D)) bear = true; return bear; };
}

// state から始めて、data（{ 銘柄: [{d,o,h,l,c,v}, ...] }）の state.lastDate より後の日を順に処理する
// opts.applyHalts: 安全装置（1日の損失上限・最大下落）で止めるか
export function runDays(cfgIn, stateIn, data, opts = {}) {
  const cfg = normalizeCfg(cfgIn);
  const st = clone(stateIn);
  const trades = [], equity = [], notes = [];
  const syms = cfg.symbols.filter(s => data[s]?.length);
  const idx = {}, tb = {};
  // シグナルは元の値動きで判定し、売買と評価はレバレッジを想定した値動き（lev=1 なら同じ）で行う
  const sig = opts.sig || precomputeSignals(cfg, data);
  for (const s of syms) {
    idx[s] = new Map(data[s].map((b, i) => [b.d, i]));
    tb[s] = cfg.lev > 1 ? levBars(data[s], cfg.lev, cfg.levCostPct) : data[s];
    // 模擬取引は毎回ちがう日からデータを読むので、前回の最後の日の値段にそろえる（レバレッジの値動きは始まりの日で水準が変わるため）
    const an = st.levAnchor?.[s];
    if (cfg.lev > 1 && an) {
      const j = idx[s].get(an.d);
      if (j != null && tb[s][j].c > 0) { const k = an.L / tb[s][j].c; tb[s] = tb[s].map(b => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k })); }
    }
  }
  const dates = [...new Set(syms.flatMap(s => data[s].map(b => b.d)))]
    .filter(d => (!st.lastDate || d > st.lastDate) && (!opts.toDate || d <= opts.toDate)).sort();
  // 相場フィルター：その日が「弱気」かどうか（自動探索では前もって計算した表を使う）
  const rg = cfg.regime;
  const bearOn = opts.bearMap ? D => !!opts.bearMap.get(D) : bearTester(rg, data);
  let bearDays = 0;
  const slip = cfg.slipPct / 100, fee = cfg.feePct / 100;
  const posPct = Math.min(cfg.maxPosPct / 100, 1 / Math.max(1, cfg.strategy === "rotation" ? Math.min(cfg.params.top, syms.length) : syms.length));
  // 税金：利益が出た手じまいのたびに引き、同じ年の損失が出たら戻す（特定口座の源泉徴収と同じ考え方）
  const rate = cfg.taxPct / 100;
  const taxOn = (D, pnl) => {
    if (!rate) return;
    const y = D.slice(0, 4);
    if (st.taxYear !== y) { st.taxYear = y; st.ytdGain = 0; st.ytdTax = 0; }
    st.ytdGain += pnl;
    const due = Math.max(0, st.ytdGain) * rate, delta = due - st.ytdTax;
    st.cash -= delta; st.ytdTax = due; st.taxTotal = (st.taxTotal || 0) + delta;
  };
  // 1回に買う（空売りする）株数。どの決め方でも、手元資金と「1銘柄の上限」は超えない
  const sizeQty = (price, scale, feeMul) => {
    const eq = equityOf(st), cap = Math.min(st.cash, eq * cfg.maxPosPct / 100);
    let budget = eq * posPct;
    if (cfg.sizeVal > 0) {
      if (cfg.sizeMode === "cash") budget = cfg.sizeVal;
      else if (cfg.sizeMode === "shares") budget = cfg.sizeVal * price * feeMul;
      else if (cfg.sizeMode === "risk" && cfg.slPct > 0) budget = eq * (cfg.sizeVal / 100) / (cfg.slPct / 100);
    }
    return Math.floor(Math.min(budget * scale, cap) / (price * feeMul) / cfg.lot + 1e-9) * cfg.lot;
  };

  for (const D of dates) {
    const bar = s => { const i = idx[s]?.get(D); return i == null ? null : tb[s][i]; };

    // 1) 前日に出した注文を、今日の始値で約定（売りを先に）
    let fills = 0;
    const keep = [];
    // 手じまい（売り・買い戻し）を先に。open が無い古い注文は、買い＝新規とみなす
    const isOpen = o => o.open ?? o.side === "buy";
    const orders = [...st.pending].sort((a, b) => (isOpen(a) ? 1 : 0) - (isOpen(b) ? 1 : 0));
    for (const o of orders) {
      const b = bar(o.symbol);
      if (!b || !(b.o > 0)) { keep.push(o); continue; }
      if (!isOpen(o) && st.positions[o.symbol]?.short) {
        // 空売りの買い戻し
        if (fills >= cfg.maxTradesPerDay) { notes.push({ d: D, msg: `${o.symbol}：1日の取引回数の上限（${cfg.maxTradesPerDay}回）のため注文を取り消しました` }); continue; }
        const p = st.positions[o.symbol], price = b.o * (1 + slip), f = p.qty * price * fee;
        const borrow = p.qty * p.avg * cfg.borrowPct / 100 * Math.max(1, (Date.parse(D) - Date.parse(p.entry)) / 864e5) / 365;
        const gain = p.qty * (p.avg - price) - f - borrow;
        st.cash += gain;
        trades.push({ d: D, symbol: o.symbol, side: "buy", qty: p.qty, price, fee: f + borrow, pnl: gain - (p.feeIn || 0), reason: o.reason });
        taxOn(D, gain - (p.feeIn || 0));
        delete st.positions[o.symbol];
        fills++;
        continue;
      }
      if (isOpen(o) && o.side === "sell") {
        // 空売りで新規
        if (st.positions[o.symbol]) continue;
        if (fills >= cfg.maxTradesPerDay) { notes.push({ d: D, msg: `${o.symbol}：1日の取引回数の上限（${cfg.maxTradesPerDay}回）のため注文を取り消しました` }); continue; }
        const price = b.o * (1 - slip);
        const qty = sizeQty(price, o.scale || 1, 1);
        if (qty <= 0) { notes.push({ d: D, msg: `${o.symbol}：資金が足りず空売りできませんでした（${cfg.lot}株単位）` }); continue; }
        const f = qty * price * fee;
        st.cash -= f;
        st.positions[o.symbol] = { qty, avg: price, cost: qty * price, entry: D, short: true, feeIn: f };
        trades.push({ d: D, symbol: o.symbol, side: "sell", qty, price, fee: f, pnl: null, reason: o.reason });
        fills++;
        continue;
      }
      if (fills >= cfg.maxTradesPerDay) { notes.push({ d: D, msg: `${o.symbol}：1日の取引回数の上限（${cfg.maxTradesPerDay}回）のため注文を取り消しました` }); continue; }
      if (o.side === "sell") {
        const p = st.positions[o.symbol];
        if (!p) continue;
        const price = b.o * (1 - slip), value = p.qty * price, f = value * fee;
        st.cash += value - f;
        trades.push({ d: D, symbol: o.symbol, side: "sell", qty: p.qty, price, fee: f, pnl: value - f - p.cost, reason: o.reason });
        taxOn(D, value - f - p.cost);
        delete st.positions[o.symbol];
        fills++;
      } else {
        if (st.positions[o.symbol]) continue;
        const price = b.o * (1 + slip);
        const qty = sizeQty(price, o.scale || 1, 1 + fee);
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
        const want = sig[s]?.[i], c = tb[s][i].c, p = st.positions[s];
        const short = cfg.side === "short", rgOn = rg.mode !== "off";
        const has = open => st.pending.some(o => o.symbol === s && isOpen(o) === open);
        if (p) {
          // 損切り・利確は、空売りなら向きが逆（上がったら損切り、下がったら利確）
          const move = (p.short ? p.avg - c : c - p.avg) / p.avg * 100;
          let reason = null;
          if (cfg.slPct > 0 && move <= -cfg.slPct) reason = "損切り";
          else if (cfg.tpPct > 0 && move >= cfg.tpPct) reason = "利確";
          else if (rgOn && rg.action === "exit" && (p.short ? !bear : bear)) reason = "相場フィルター";
          else if (!want) reason = p.short ? "買い戻しシグナル" : "売りシグナル";
          if (reason && !has(false)) {
            st.pending.push({ symbol: s, side: p.short ? "buy" : "sell", open: false, reason, signalDate: D });
            if (reason === "損切り" || reason === "利確") st.blocked[s] = true; // 損切り・利確のあとは、シグナルが一度消えるまで入り直さない
          }
        } else {
          if (st.blocked[s] && !want) delete st.blocked[s];
          // 買いは「弱気なら控える」、空売りは「弱気のときだけ仕掛ける」
          const stop = short ? (rgOn && !bear) : (bear && rg.action !== "half");
          if (want && !stop && !st.blocked[s] && !has(true)) st.pending.push({ symbol: s, side: short ? "sell" : "buy", open: true, reason: short ? "空売りシグナル" : "買いシグナル", signalDate: D, ...(bear && !short ? { scale: 0.5 } : {}) });
        }
      }
    }
    st.prevEquity = eq;
    st.lastDate = D;
  }
  if (cfg.lev > 1) {
    st.levAnchor = st.levAnchor || {};
    for (const s of syms) { const j = idx[s].get(st.lastDate); if (j != null) st.levAnchor[s] = { d: st.lastDate, L: tb[s][j].c }; }
  }
  return { state: st, trades, equity, notes, bearDays };
}

// 最後の日に全部売ったとしてかかる税金（含み益と、その年の確定済みの損益を合わせて計算）
export function exitTax(cfgIn, st) {
  const cfg = normalizeCfg(cfgIn), rate = cfg.taxPct / 100;
  if (!rate || !st.lastDate) return 0;
  let unreal = 0;
  for (const [s, p] of Object.entries(st.positions)) { const c = st.lastClose[s] ?? p.avg; unreal += p.short ? p.qty * (p.avg - c) - (p.feeIn || 0) : p.qty * c - p.cost; }
  const same = st.taxYear === st.lastDate.slice(0, 4);
  return Math.max(0, (same ? st.ytdGain : 0) + unreal) * rate - (same ? st.ytdTax : 0);
}

