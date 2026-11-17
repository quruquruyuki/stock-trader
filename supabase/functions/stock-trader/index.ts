// 株ラボ（stock-trader）の Edge Function
// ・株価の取得と保存（日本株: J-Quants API、米国株: Tiingo、恐怖指数: Cboe の VIX・日経平均VI、政策金利: FRED）
// ・模擬取引ボットの作成・実行・停止（実際の注文は一切出さない）
//
// 使う Secrets:
//   JQUANTS_API_KEY  … J-Quants の APIキー（日本株）
//   TIINGO_API_KEY   … Tiingo の APIトークン（米国株）
//   ALLOWED_EMAIL    … このアプリを使えるログイン用メールアドレス（他のアプリと共用）
//   NOTION_API_KEY   … 結果を Notion に保存するとき（他のアプリと共用）
// プッシュ通知の鍵（VAPID）は初回に自動で作って st_config に保存する
// 毎日の自動実行（pg_cron）からの呼び出しは、st_config テーブルの cron_key（画面からは読めない）で確かめる
import { createClient } from "jsr:@supabase/supabase-js@2";
import { initialState, normalizeCfg, runDays, STRATEGIES } from "./engine.js";
import { generateVapid, sendPush, type Vapid } from "./push.ts";
import { saveToNotion } from "./notion.ts";

const norm = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, "");
function env(name: string, ...aliases: string[]): string {
  const wanted = new Set([name, ...aliases].map(norm));
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (wanted.has(norm(k))) return v.trim().replace(/^["']|["']$/g, "").trim();
  }
  return "";
}
const JQUANTS_API_KEY = env("JQUANTS_API_KEY", "JQUANTS_KEY", "J_QUANTS_API_KEY");
const TIINGO_API_KEY = env("TIINGO_API_KEY", "TIINGO_KEY", "TIINGO_TOKEN");
const ALLOWED_EMAIL = env("ALLOWED_EMAIL").toLowerCase();
const NOTION_API_KEY = env("NOTION_API_KEY", "NOTION_KEY", "NOTION_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };
type Market = "JP" | "US" | "IX"; // IX = 指標（恐怖指数、金利、為替、原油など）
const REFRESH_MS = 3 * 60 * 60 * 1000; // 3時間以内に取得済みなら取り直さない

/* ---------- 株価の取得 ---------- */
async function getJson(url: string, init: RequestInit, label: string) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, init);
    if (r.ok) return await r.json();
    const t = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 800 * 2 ** i)); continue; }
    throw new HttpError(502, `${label}（${r.status}）: ${t.slice(0, 200)}`);
  }
  throw new HttpError(502, `${label} が混み合っています。少し待ってからもう一度お試しください`);
}
const ymd = (s: string) => /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : String(s).slice(0, 10);

async function fetchJP(code: string, from: string | null): Promise<{ bars: Bar[]; name: string | null }> {
  if (!JQUANTS_API_KEY) throw new HttpError(400, "日本株のデータ取得用の J-Quants APIキーが未設定です（設定タブを見てください）");
  const headers = { "x-api-key": JQUANTS_API_KEY };
  const bars: Bar[] = [];
  const get = async (withFrom: boolean) => {
    let key = "";
    bars.length = 0;
    do {
      const u = new URL("https://api.jquants.com/v2/equities/bars/daily");
      u.searchParams.set("code", code);
      if (withFrom && from) u.searchParams.set("from", from.replaceAll("-", ""));
      if (key) u.searchParams.set("pagination_key", key);
      const j = await getJson(u.toString(), { headers }, "J-Quants");
      for (const r of j.data ?? []) {
        const c = r.AdjC ?? r.C;
        if (c == null) continue;
        bars.push({ d: ymd(r.Date), o: r.AdjO ?? r.O ?? c, h: r.AdjH ?? r.H ?? c, l: r.AdjL ?? r.L ?? c, c, v: r.AdjVo ?? r.Vo ?? 0 });
      }
      key = j.pagination_key ?? "";
    } while (key);
  };
  try { await get(true); }
  catch (e) { if (from && e instanceof HttpError && /\(4\d\d\)|（4\d\d）/.test(e.message)) await get(false); else throw e; }
  let name: string | null = null;
  try {
    const m = await getJson(`https://api.jquants.com/v2/equities/master?code=${encodeURIComponent(code)}`, { headers }, "J-Quants");
    const r = (m.data ?? [])[0] ?? {};
    name = r.CoName ?? r.CompanyName ?? r.CoNameEn ?? r.CompanyNameEnglish ?? null;
  } catch (_) { /* 名前は取れなくてもよい */ }
  return { bars, name };
}

async function fetchUS(ticker: string, from: string | null): Promise<{ bars: Bar[]; name: string | null }> {
  if (!TIINGO_API_KEY) throw new HttpError(400, "米国株のデータ取得用の Tiingo APIトークンが未設定です（設定タブを見てください）");
  const headers = { "Content-Type": "application/json", "Authorization": `Token ${TIINGO_API_KEY}` };
  const t = encodeURIComponent(ticker.toLowerCase());
  const rows = await getJson(`https://api.tiingo.com/tiingo/daily/${t}/prices?startDate=${from ?? "2000-01-01"}&resampleFreq=daily`, { headers }, "Tiingo");
  const bars: Bar[] = (rows ?? []).filter((r: any) => (r.adjClose ?? r.close) != null).map((r: any) => ({
    d: String(r.date).slice(0, 10), o: r.adjOpen ?? r.open, h: r.adjHigh ?? r.high, l: r.adjLow ?? r.low, c: r.adjClose ?? r.close, v: r.adjVolume ?? r.volume ?? 0,
  }));
  let name: string | null = null;
  try { name = (await getJson(`https://api.tiingo.com/tiingo/daily/${t}`, { headers }, "Tiingo")).name ?? null; } catch (_) { /* 任意 */ }
  return { bars, name };
}

// 恐怖指数。VIX は Cboe の公開CSV（だめなら FRED）、日経平均VI は日経平均プロフィルの公開CSV
const IX_NAMES: Record<string, string> = { VIX: "VIX（米国・S&P500）", NKVI: "日経平均VI", FF: "米国の政策金利（FF金利）", JPR: "日本の短期金利（コール翌日物・月次）", USDJPY: "ドル円", US10Y: "米国の10年金利", T10Y2Y: "米国の長短金利差（10年−2年）", WTI: "原油（WTI）", BEI: "米国の期待インフレ率（10年）", UNRATE: "米国の失業率（月次）" };
// FRED の公開CSV（キー不要）。金利は 0 やマイナスもあるので、数値ならそのまま使う
const FRED_ID: Record<string, string> = { FF: "DFF", JPR: "IRSTCI01JPM156N", USDJPY: "DEXJPUS", US10Y: "DGS10", T10Y2Y: "T10Y2Y", WTI: "DCOILWTICO", BEI: "T10YIE", UNRATE: "UNRATE" };
async function fredSeries(id: string): Promise<Bar[]> {
  const out: Bar[] = [];
  for (const line of (await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`)).split(/\r?\n/)) {
    const p = line.split(","), c = Number(p[1]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p[0] ?? "") && p[1] !== "" && p[1] !== "." && Number.isFinite(c)) out.push({ d: p[0], o: c, h: c, l: c, c, v: 0 });
  }
  return out;
}
async function getText(url: string, enc = "utf-8") {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (stock-trader; personal use)" } });
  if (!r.ok) throw new HttpError(502, `${new URL(url).hostname}（${r.status}）`);
  return new TextDecoder(enc).decode(await r.arrayBuffer());
}
async function fetchIX(symbol: string, from: string | null): Promise<{ bars: Bar[]; name: string | null }> {
  const bars: Bar[] = [];
  const num = (x: string) => { const n = Number(String(x ?? "").replace(/["\s]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  if (FRED_ID[symbol]) bars.push(...await fredSeries(FRED_ID[symbol]));
  else if (symbol === "VIX") {
    try {
      for (const line of (await getText("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv")).split(/\r?\n/)) {
        const p = line.split(","), m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((p[0] ?? "").trim());
        const c = num(p[4]);
        if (m && c) bars.push({ d: `${m[3]}-${m[1]}-${m[2]}`, o: num(p[1]) ?? c, h: num(p[2]) ?? c, l: num(p[3]) ?? c, c, v: 0 });
      }
      if (!bars.length) throw new Error("empty");
    } catch (_) {
      bars.length = 0;
      bars.push(...await fredSeries("VIXCLS"));
    }
  } else {
    // 列: データ日付, 終値, 始値, 高値, 安値（Shift_JIS）
    for (const line of (await getText("https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_vi_daily_jp.csv", "shift_jis")).split(/\r?\n/)) {
      const p = line.split(",").map(x => x.replace(/"/g, "").trim()), m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(p[0] ?? "");
      const c = num(p[1]);
      if (m && c) bars.push({ d: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, o: num(p[2]) ?? c, h: num(p[3]) ?? c, l: num(p[4]) ?? c, c, v: 0 });
    }
  }
  bars.sort((a, b) => a.d < b.d ? -1 : 1);
  return { bars: from ? bars.filter(b => b.d >= from) : bars, name: IX_NAMES[symbol] };
}

function cleanSymbol(market: Market, s: string) {
  const v = String(s).trim().toUpperCase();
  if (market === "IX") { if (!IX_NAMES[v]) throw new HttpError(400, `この指標は使えません: ${s}`); return v; }
  if (market === "JP") { if (!/^\d{4}[0-9A-Z]?$|^\d{3}[A-Z]\d?$/.test(v)) throw new HttpError(400, `銘柄コードが正しくありません: ${s}（例: 7203）`); }
  else if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(v)) throw new HttpError(400, `ティッカーが正しくありません: ${s}（例: AAPL）`);
  return v;
}

// 足りない株価を取ってきて保存する
async function ensure(market: Market, symbol: string, force = false) {
  const { data: row } = await db.from("st_symbols").select("*").eq("market", market).eq("symbol", symbol).maybeSingle();
  if (!force && row?.last_fetched && Date.now() - Date.parse(row.last_fetched) < REFRESH_MS) return row;
  let from: string | null = null;
  if (row?.last_date) { const d = new Date(row.last_date); d.setDate(d.getDate() - 10); from = d.toISOString().slice(0, 10); }
  const { bars, name } = market === "IX" ? await fetchIX(symbol, from) : market === "JP" ? await fetchJP(symbol, from) : await fetchUS(symbol, from);
  if (!bars.length && !row) throw new HttpError(404, `${symbol} の株価が見つかりませんでした`);
  for (let i = 0; i < bars.length; i += 1000) {
    const { error } = await db.from("st_prices").upsert(bars.slice(i, i + 1000).map(b => ({ market, symbol, ...b })));
    if (error) throw new HttpError(500, "株価の保存に失敗しました: " + error.message);
  }
  const ds = bars.map(b => b.d).sort();
  const next = {
    market, symbol, name: name ?? row?.name ?? null,
    first_date: row?.first_date && (!ds[0] || row.first_date < ds[0]) ? row.first_date : (ds[0] ?? row?.first_date ?? null),
    last_date: ds.length ? (row?.last_date && row.last_date > ds[ds.length - 1] ? row.last_date : ds[ds.length - 1]) : row?.last_date ?? null,
    last_fetched: new Date().toISOString(),
  };
  await db.from("st_symbols").upsert(next);
  return next;
}

async function loadBars(market: Market, symbol: string, from: string | null): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let off = 0; ; off += 1000) {
    let q = db.from("st_prices").select("d,o,h,l,c,v").eq("market", market).eq("symbol", symbol).order("d").range(off, off + 999);
    if (from) q = q.gte("d", from);
    const { data, error } = await q;
    if (error) throw new HttpError(500, error.message);
    out.push(...(data as Bar[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function bars(market: Market, symbols: string[], from: string | null, force = false) {
  const result: Record<string, { name: string | null; bars: Bar[] }> = {};
  const errors: Record<string, string> = {};
  for (const raw of symbols.slice(0, 10)) {
    let s = raw;
    try {
      s = cleanSymbol(market, raw);
      const info = await ensure(market, s, force);
      result[s] = { name: info?.name ?? null, bars: await loadBars(market, s, from) };
    } catch (e) { errors[s] = e instanceof Error ? e.message : String(e); }
  }
  return { symbols: result, errors };
}

/* ---------- 模擬取引ボット ---------- */
const lookbackFrom = (lastDate: string | null) => {
  const d = lastDate ? new Date(lastDate) : new Date();
  d.setDate(d.getDate() - 800); // シグナル計算に十分な過去分
  return d.toISOString().slice(0, 10);
};

// 設定を整える。相場フィルターの各条件のデータ名を確かめ、日本株で米国のデータを見る条件は前日までで判定する
const US_TIMED = (key: string) => !key.startsWith("JP:") && key !== "IX:NKVI" && key !== "IX:JPR";
function withRegime(market: Market, cfgIn: any) {
  const cfg: any = normalizeCfg(cfgIn);
  for (const f of cfg.regime.filters) {
    if (!f.key) continue; // 季節の条件はデータを使わない
    const [m, sym] = f.key.split(":");
    f.key = `${m}:${cleanSymbol(m as Market, sym)}`;
    f.lag = market === "JP" && US_TIMED(f.key); // 米国の終値は日本の引け後に出る
  }
  if ((STRATEGIES as any)[cfg.strategy]?.needsVol) {
    if (!cfg.fearSym) cfg.fearSym = market === "US" ? "VIX" : "NKVI";
    cfg.fearLag = market === "JP" && cfg.fearSym === "VIX";
  }
  return cfg;
}
// 売買する銘柄のほかに必要なデータ（相場フィルターの条件、恐怖指数を使う戦略）
const extraKeys = (cfg: any): string[] => [...new Set([
  ...(cfg.regime?.mode === "auto" ? cfg.regime.filters.map((f: any) => f.key).filter(Boolean) : []),
  ...((STRATEGIES as any)[cfg.strategy]?.needsVol && cfg.fearSym ? ["IX:" + cfg.fearSym] : []),
])] as string[];
// data["US:GLD"] や data["IX:VIX"] のような名前で足す
async function addExtra(cfg: any, data: Record<string, Bar[]>, from: string | null, errors?: string[]) {
  for (const key of extraKeys(cfg)) {
    const [m, sym] = key.split(":");
    try { await ensure(m as Market, sym); data[key] = await loadBars(m as Market, sym, from); if (!data[key].length) throw new Error("データがありません"); }
    catch (e) { const msg = `${key}: ${e instanceof Error ? e.message : e}`; if (errors) errors.push(msg); else throw new HttpError(400, msg); }
  }
}

async function createBot(userId: string, body: any) {
  const market: Market = body.market === "US" ? "US" : "JP";
  const cfg = withRegime(market, { ...body.cfg, symbols: (body.cfg?.symbols ?? []).map((s: string) => cleanSymbol(market, s)) });
  if (!cfg.symbols.length) throw new HttpError(400, "銘柄を1つ以上入れてください");
  const { symbols: got, errors } = await bars(market, cfg.symbols, lookbackFrom(null));
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0]);
  // 最新の1日ぶんから判定を始める（今日の終値でシグナルを見て、次の営業日の始値で約定）
  const dates = [...new Set(cfg.symbols.flatMap((s: string) => got[s].bars.map(b => b.d)))].sort() as string[];
  if (dates.length < 2) throw new HttpError(400, "株価データが足りません");
  const st: any = initialState(cfg.initialCash);
  st.lastDate = dates[dates.length - 2];
  const data: Record<string, Bar[]> = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.bars]));
  await addExtra(cfg, data, lookbackFrom(null));
  const name = String(body.name ?? "").trim().slice(0, 40) || `${(STRATEGIES as any)[cfg.strategy].label}（${cfg.symbols.join("・")}）`;
  const { data: bot, error } = await db.from("st_bots").insert({ user_id: userId, name, market, cfg, state: st, active: true }).select().single();
  if (error) throw new HttpError(500, error.message);
  await runBot(bot, data);
  const { data: fresh } = await db.from("st_bots").select("*").eq("id", bot.id).single();
  return fresh;
}

/* ---------- プッシュ通知 ---------- */
let vapidCache: Vapid | null = null;
async function vapid(): Promise<Vapid> {
  if (vapidCache) return vapidCache;
  const { data } = await db.from("st_config").select("value").eq("key", "vapid").maybeSingle();
  if (data?.value) return (vapidCache = JSON.parse(data.value));
  const v = await generateVapid();
  await db.from("st_config").insert({ key: "vapid", value: JSON.stringify(v) });
  // 同時に作られた場合に備えて、保存されたほうを使う
  const { data: again } = await db.from("st_config").select("value").eq("key", "vapid").single();
  return (vapidCache = JSON.parse(again!.value));
}
async function notify(userId: string, msg: { title: string; body: string; tag?: string; url?: string }) {
  const { data: subs } = await db.from("st_push_subs").select("*").eq("user_id", userId);
  if (!subs?.length) return 0;
  const v = await vapid();
  let sent = 0;
  for (const s of subs) {
    try {
      const r = await sendPush(s, msg, v, ALLOWED_EMAIL ? `mailto:${ALLOWED_EMAIL}` : undefined);
      if (r === "ok") sent++;
      else if (r === "gone") await db.from("st_push_subs").delete().eq("id", s.id);
      else console.error("push", r);
    } catch (e) { console.error("push", e); }
  }
  return sent;
}
const fmtNum = (v: number, m: string) => m === "US" ? v.toFixed(2) : Math.round(v).toLocaleString("ja-JP");
function runSummary(bot: any, r: any): string | null {
  const lines: string[] = [];
  for (const t of r.trades.slice(-4)) lines.push(`${/空売り/.test(t.reason ?? "") ? "空売り" : t.side === "buy" ? "買" : "売"} ${t.symbol} ${t.qty}株 @${fmtNum(t.price, bot.market)}${t.pnl != null ? `（${t.pnl >= 0 ? "+" : ""}${fmtNum(t.pnl, bot.market)}）` : ""}`);
  if (r.trades.length > 4) lines.unshift(`約定${r.trades.length}件（最新4件）`);
  const fresh = (r.state.pending ?? []).filter((o: any) => o.signalDate === r.state.lastDate);
  for (const o of fresh.slice(0, 3)) lines.push(`次の営業日に${o.side === "buy" ? "買い" : "売り"}：${o.symbol}（${o.reason}）`);
  for (const n of r.notes.filter((n: any) => n.msg.startsWith("相場フィルター")).slice(-1)) lines.push(n.msg);
  if (r.state.halted && !bot.state.halted) lines.push(`安全装置で停止：${r.state.haltReason}`);
  return lines.length ? lines.join("\n") : null;
}

async function runBot(bot: any, preloaded?: Record<string, Bar[]>) {
  const cfg = withRegime(bot.market, bot.cfg);
  let data = preloaded;
  const errors: string[] = [];
  if (!data) {
    data = {};
    for (const s of cfg.symbols) {
      try { await ensure(bot.market, s); data[s] = await loadBars(bot.market, s, lookbackFrom(bot.state.lastDate)); }
      catch (e) { errors.push(`${s}: ${e instanceof Error ? e.message : e}`); }
    }
    await addExtra(cfg, data, lookbackFrom(bot.state.lastDate), errors);
  }
  const r = runDays(cfg, bot.state, data, { applyHalts: true });
  const days = r.equity.length;
  if (r.trades.length) {
    const { error } = await db.from("st_trades").insert(r.trades.map(t => ({ ...t, bot_id: bot.id, user_id: bot.user_id })));
    if (error) throw new HttpError(500, error.message);
  }
  if (days) {
    const { error } = await db.from("st_equity").upsert(r.equity.map(e => ({ bot_id: bot.id, user_id: bot.user_id, d: e.d, equity: e.equity, cash: e.cash })));
    if (error) throw new HttpError(500, error.message);
  }
  const msgs = [
    days ? `${r.state.lastDate} までの${days}日分を処理（約定${r.trades.length}件）` : "新しい株価はまだありません",
    ...r.notes.slice(-3).map(n => `${n.d} ${n.msg}`),
    ...errors,
  ];
  const update: Record<string, unknown> = { state: r.state, last_run_at: new Date().toISOString(), last_message: msgs.join("\n").slice(0, 1000) };
  if (r.state.halted) { update.active = false; update.halted_reason = r.state.haltReason; }
  await db.from("st_bots").update(update).eq("id", bot.id);
  const summary = runSummary(bot, r);
  // 名前が「（動作テスト）」で始まるボットは通知しない
  if (summary && !String(bot.name).startsWith("（動作テスト）")) { try { await notify(bot.user_id, { title: `株ラボ｜${bot.name}`, body: summary, tag: `bot-${bot.id}`, url: "./#paper" }); } catch (e) { console.error(e); } }
  return { processed: days, trades: r.trades.length, halted: r.state.halted };
}

async function runAll() {
  const { data: bots } = await db.from("st_bots").select("*").eq("active", true);
  const out: Record<string, unknown> = {};
  for (const b of bots ?? []) {
    try { out[b.id] = await runBot(b); }
    catch (e) {
      out[b.id] = { error: String(e) };
      await db.from("st_bots").update({ last_run_at: new Date().toISOString(), last_message: "エラー: " + (e instanceof Error ? e.message : e) }).eq("id", b.id);
    }
  }
  return out;
}

async function ownBot(userId: string, id: string) {
  const { data } = await db.from("st_bots").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "ボットが見つかりません");
  return data;
}

/* ---------- ログイン確認 ---------- */
async function requireUser(req: Request) {
  if (!ALLOWED_EMAIL) throw new HttpError(500, "ALLOWED_EMAIL が設定されていません");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "ログインしてください");
  const { data, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "ログインの期限が切れました。もう一度ログインしてください");
  if ((data.user.email ?? "").toLowerCase() !== ALLOWED_EMAIL) throw new HttpError(403, "このアカウントでは使えません");
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));

    // 毎日の自動実行（pg_cron から）
    if (body.action === "run_all") {
      const { data: k } = await db.from("st_config").select("value").eq("key", "cron_key").maybeSingle();
      if (!k?.value || req.headers.get("x-cron-key") !== k.value) throw new HttpError(401, "unauthorized");
      return json({ ok: true, result: await runAll() });
    }
    // 恐怖指数の取得テスト・更新（同じ合言葉で守る）
    if (body.action === "ix_refresh") {
      const { data: k } = await db.from("st_config").select("value").eq("key", "cron_key").maybeSingle();
      if (!k?.value || req.headers.get("x-cron-key") !== k.value) throw new HttpError(401, "unauthorized");
      const out: Record<string, unknown> = {};
      for (const s of Object.keys(IX_NAMES)) {
        try { const r = await ensure("IX", s, true); out[s] = { first: r?.first_date, last: r?.last_date }; }
        catch (e) { out[s] = { error: e instanceof Error ? e.message : String(e) }; }
      }
      return json({ ok: true, result: out });
    }

    const user = await requireUser(req);
    switch (body.action) {
      case "status":
        return json({ jquants: !!JQUANTS_API_KEY, tiingo: !!TIINGO_API_KEY, notion: !!NOTION_API_KEY });
      case "push_key":
        return json({ key: (await vapid()).publicKey });
      case "push_subscribe": {
        const sub = body.sub ?? {};
        const endpoint = String(sub.endpoint ?? ""), p256dh = String(sub.keys?.p256dh ?? ""), auth = String(sub.keys?.auth ?? "");
        if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new HttpError(400, "通知の登録情報が正しくありません");
        const { error } = await db.from("st_push_subs").upsert({ user_id: user.id, endpoint, p256dh, auth, ua: String(body.ua ?? "").slice(0, 200) }, { onConflict: "endpoint" });
        if (error) throw new HttpError(500, error.message);
        return json({ ok: true });
      }
      case "push_unsubscribe":
        await db.from("st_push_subs").delete().eq("user_id", user.id).eq("endpoint", String(body.endpoint ?? ""));
        return json({ ok: true });
      case "push_test": {
        const sent = await notify(user.id, { title: "株ラボ", body: "通知のテストです。模擬取引で約定したときや、安全装置で止まったときにお知らせします。", tag: "test", url: "./" });
        if (!sent) throw new HttpError(400, "通知を送れる端末がありません。この端末で通知をオンにしてください");
        return json({ sent });
      }
      case "notion_save": {
        if (!NOTION_API_KEY) throw new HttpError(400, "NOTION_API_KEY が未設定です");
        const pg = body.page ?? {};
        if (!pg.title) throw new HttpError(400, "保存する内容がありません");
        const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
        return json(await saveToNotion(NOTION_API_KEY, { title: String(pg.title), genre: String(pg.genre ?? "株・投資"), summary: String(pg.summary ?? ""), date: today, sections: Array.isArray(pg.sections) ? pg.sections : [] }));
      }
      case "bars": {
        const market: Market = body.market === "US" ? "US" : body.market === "IX" ? "IX" : "JP";
        return json(await bars(market, Array.isArray(body.symbols) ? body.symbols : [], body.from ?? null, !!body.force));
      }
      case "create_bot":
        return json({ bot: await createBot(user.id, body) });
      case "run_bot": {
        const bot = await ownBot(user.id, body.id);
        if (!bot.active) throw new HttpError(400, "停止中のボットです。再開してから更新してください");
        return json({ result: await runBot(bot) });
      }
      case "set_active": {
        const bot = await ownBot(user.id, body.id);
        const active = !!body.active;
        const state = { ...bot.state };
        if (active) {
          // 再開時は、止めていた間の日はさかのぼって売買しない。「最高値」も今の資産から数え直す
          const { data: rows } = await db.from("st_symbols").select("last_date").eq("market", bot.market).in("symbol", normalizeCfg(bot.cfg).symbols);
          const latest = (rows ?? []).map(r => r.last_date).filter(Boolean).sort().pop();
          if (latest && (!state.lastDate || latest > state.lastDate)) {
            state.lastDate = latest; state.pending = [];
            for (const s of Object.keys(state.positions ?? {})) {
              const { data: p } = await db.from("st_prices").select("c").eq("market", bot.market).eq("symbol", s).lte("d", latest).order("d", { ascending: false }).limit(1).maybeSingle();
              if (p?.c) state.lastClose[s] = p.c;
            }
            state.prevEquity = state.cash + Object.entries(state.positions ?? {}).reduce((a, [s, p]: [string, any]) => { const c = state.lastClose[s] ?? p.avg; return a + (p.short ? p.qty * (p.avg - c) : p.qty * c); }, 0);
          }
          state.halted = false; state.haltReason = null; state.peak = state.prevEquity;
        }
        await db.from("st_bots").update({ active, state, halted_reason: active ? null : bot.halted_reason }).eq("id", bot.id);
        return json({ ok: true });
      }
      case "set_regime": {
        // 相場感の切り替え（auto=条件で自動 / bull=強気で固定 / bear=弱気で固定 / off=使わない）
        const bot = await ownBot(user.id, body.id);
        const cfg = withRegime(bot.market, { ...bot.cfg, regime: { ...(bot.cfg.regime ?? {}), ...(body.regime ?? {}) } });
        await addExtra(cfg, {}, lookbackFrom(null));
        await db.from("st_bots").update({ cfg, state: { ...bot.state, regimeBear: null } }).eq("id", bot.id);
        return json({ ok: true });
      }
      case "stop_all":
        await db.from("st_bots").update({ active: false }).eq("user_id", user.id).eq("active", true);
        return json({ ok: true });
      default:
        throw new HttpError(400, "unknown action");
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
