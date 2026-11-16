// 株ラボ（stock-trader）の Edge Function
// ・株価の取得と保存（日本株: J-Quants API、米国株: Tiingo）
// ・模擬取引ボットの作成・実行・停止（実際の注文は一切出さない）
//
// 使う Secrets:
//   JQUANTS_API_KEY  … J-Quants の APIキー（日本株）
//   TIINGO_API_KEY   … Tiingo の APIトークン（米国株）
//   ALLOWED_EMAIL    … このアプリを使えるログイン用メールアドレス（他のアプリと共用）
// 毎日の自動実行（pg_cron）からの呼び出しは、st_config テーブルの cron_key（画面からは読めない）で確かめる
import { createClient } from "jsr:@supabase/supabase-js@2";
import { initialState, normalizeCfg, runDays, STRATEGIES } from "./engine.js";

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
type Market = "JP" | "US";
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

function cleanSymbol(market: Market, s: string) {
  const v = String(s).trim().toUpperCase();
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
  const { bars, name } = market === "JP" ? await fetchJP(symbol, from) : await fetchUS(symbol, from);
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

async function createBot(userId: string, body: any) {
  const market: Market = body.market === "US" ? "US" : "JP";
  const cfg = normalizeCfg({ ...body.cfg, symbols: (body.cfg?.symbols ?? []).map((s: string) => cleanSymbol(market, s)) });
  if (!cfg.symbols.length) throw new HttpError(400, "銘柄を1つ以上入れてください");
  const { symbols: got, errors } = await bars(market, cfg.symbols, lookbackFrom(null));
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0]);
  // 最新の1日ぶんから判定を始める（今日の終値でシグナルを見て、次の営業日の始値で約定）
  const dates = [...new Set(Object.values(got).flatMap(x => x.bars.map(b => b.d)))].sort();
  if (dates.length < 2) throw new HttpError(400, "株価データが足りません");
  const st: any = initialState(cfg.initialCash);
  st.lastDate = dates[dates.length - 2];
  const data = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.bars]));
  const name = String(body.name ?? "").trim().slice(0, 40) || `${(STRATEGIES as any)[cfg.strategy].label}（${cfg.symbols.join("・")}）`;
  const { data: bot, error } = await db.from("st_bots").insert({ user_id: userId, name, market, cfg, state: st, active: true }).select().single();
  if (error) throw new HttpError(500, error.message);
  await runBot(bot, data);
  const { data: fresh } = await db.from("st_bots").select("*").eq("id", bot.id).single();
  return fresh;
}

async function runBot(bot: any, preloaded?: Record<string, Bar[]>) {
  const cfg = normalizeCfg(bot.cfg);
  let data = preloaded;
  const errors: string[] = [];
  if (!data) {
    data = {};
    for (const s of cfg.symbols) {
      try { await ensure(bot.market, s); data[s] = await loadBars(bot.market, s, lookbackFrom(bot.state.lastDate)); }
      catch (e) { errors.push(`${s}: ${e instanceof Error ? e.message : e}`); }
    }
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

    const user = await requireUser(req);
    switch (body.action) {
      case "status":
        return json({ jquants: !!JQUANTS_API_KEY, tiingo: !!TIINGO_API_KEY });
      case "bars": {
        const market: Market = body.market === "US" ? "US" : "JP";
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
            state.prevEquity = state.cash + Object.entries(state.positions ?? {}).reduce((a, [s, p]: [string, any]) => a + p.qty * (state.lastClose[s] ?? p.avg), 0);
          }
          state.halted = false; state.haltReason = null; state.peak = state.prevEquity;
        }
        await db.from("st_bots").update({ active, state, halted_reason: active ? null : bot.halted_reason }).eq("id", bot.id);
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
