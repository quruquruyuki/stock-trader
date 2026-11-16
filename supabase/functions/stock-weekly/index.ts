// 株ラボ：週末のまとめ通知。各ボットの今週の損益と、恐怖指数の水準を1通で届ける
// pg_cron から毎週土曜の朝に呼ぶ（st_config の cron_key で確かめる）。{"dry":true} なら送らずに文面だけ返す
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush, type Vapid } from "./push.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const LEVEL: Record<string, [number, number]> = { VIX: [20, 30], NKVI: [25, 35] };
const NAME: Record<string, string> = { VIX: "VIX", NKVI: "日経VI" };

async function marketLine() {
  const parts: string[] = [];
  for (const s of ["NKVI", "VIX"]) {
    const { data } = await db.from("st_prices").select("c").eq("market", "IX").eq("symbol", s).order("d", { ascending: false }).limit(1).maybeSingle();
    if (data?.c) { const [lo, hi] = LEVEL[s]; parts.push(`${NAME[s]} ${Number(data.c).toFixed(1)}（${data.c < lo ? "平常" : data.c < hi ? "警戒" : "強い警戒"}）`); }
  }
  return parts.length ? `市況：${parts.join("／")}` : "";
}

async function summaryFor(userId: string) {
  const { data: bots } = await db.from("st_bots").select("id,name,active,cfg,state").eq("user_id", userId).order("created_at");
  const lines: string[] = [];
  for (const b of bots ?? []) {
    const { data: eq } = await db.from("st_equity").select("d,equity").eq("bot_id", b.id).order("d", { ascending: false }).limit(15);
    if (!eq?.length) { lines.push(`${b.name}：まだ記録なし`); continue; }
    const last = eq[0], cut = new Date(last.d); cut.setDate(cut.getDate() - 7);
    const c = cut.toISOString().slice(0, 10);
    const base = eq.find(e => e.d <= c)?.equity ?? (eq.length < 15 ? b.cfg.initialCash : eq[eq.length - 1].equity);
    const mood = b.state?.regimeBear === true ? "・弱気" : "";
    lines.push(`${b.name}：今週 ${pct((last.equity / base - 1) * 100)}（通算 ${pct((last.equity / b.cfg.initialCash - 1) * 100)}）${b.active ? "" : "・停止中"}${mood}`);
  }
  if (!lines.length) lines.push("模擬取引のボットはまだありません");
  const m = await marketLine();
  return [...lines.slice(0, 8), ...(m ? [m] : [])].join("\n");
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { data: k } = await db.from("st_config").select("value").eq("key", "cron_key").maybeSingle();
    if (!k?.value || req.headers.get("x-cron-key") !== k.value) return json({ error: "unauthorized" }, 401);
    const { data: subs } = await db.from("st_push_subs").select("*");
    const { data: v } = await db.from("st_config").select("value").eq("key", "vapid").maybeSingle();
    const users = [...new Set((subs ?? []).map(s => s.user_id))];
    const out: unknown[] = [];
    for (const u of users) {
      const text = await summaryFor(u);
      let sent = 0;
      if (!body.dry && v?.value) {
        const vapid = JSON.parse(v.value) as Vapid;
        for (const s of (subs ?? []).filter(s => s.user_id === u)) {
          const r = await sendPush(s, { title: "株ラボ｜今週のまとめ", body: text, tag: "weekly", url: "./#paper" }, vapid);
          if (r === "ok") sent++; else if (r === "gone") await db.from("st_push_subs").delete().eq("id", s.id); else console.error("push", r);
        }
      }
      out.push({ sent, text });
    }
    return json({ ok: true, result: out });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
