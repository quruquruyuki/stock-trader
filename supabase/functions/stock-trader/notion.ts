// バックテスト結果を Notion の「Claude連携」データベースに保存する
// 使う Secret: NOTION_API_KEY（他のアプリと共用。データベースをインテグレーションに共有しておく）
const DATA_SOURCE_ID = "3c485790-2406-80d9-8bf5-000b484f19ae";
const DATABASE_ID = "3c485790240680f09a2fceb35a0fd9e1";

export type Section =
  | { type: "h"; text: string }
  | { type: "p"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "table"; rows: string[][] };

const rt = (t: string) => [{ type: "text", text: { content: String(t).slice(0, 1900) } }];

function blocks(sections: Section[]) {
  const out: unknown[] = [];
  for (const s of sections.slice(0, 60)) {
    if (s.type === "h") out.push({ object: "block", type: "heading_2", heading_2: { rich_text: rt(s.text) } });
    else if (s.type === "p") out.push({ object: "block", type: "paragraph", paragraph: { rich_text: rt(s.text) } });
    else if (s.type === "bullets") for (const it of s.items.slice(0, 50)) out.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(it) } });
    else if (s.type === "table" && s.rows.length) {
      const w = Math.max(...s.rows.map(r => r.length));
      out.push({
        object: "block", type: "table",
        table: {
          table_width: w, has_column_header: true, has_row_header: false,
          children: s.rows.slice(0, 90).map(r => ({ object: "block", type: "table_row", table_row: { cells: Array.from({ length: w }, (_, i) => rt(r[i] ?? "")) } })),
        },
      });
    }
  }
  return out.slice(0, 100);
}

export async function saveToNotion(apiKey: string, page: { title: string; genre: string; summary: string; date: string; sections: Section[] }) {
  const properties = {
    "名前": { title: rt(page.title) },
    "日付": { date: { start: page.date } },
    "ジャンル": { rich_text: rt(page.genre) },
    "要約": { rich_text: rt(page.summary) },
  };
  const children = blocks(page.sections);
  const call = (version: string, parent: unknown) => fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Notion-Version": version },
    body: JSON.stringify({ parent, properties, children }),
  });
  // 新しい API（データソース指定）で試し、だめなら従来の API（データベース指定）で
  let r = await call("2025-09-03", { type: "data_source_id", data_source_id: DATA_SOURCE_ID });
  if (!r.ok && r.status === 400) r = await call("2022-06-28", { database_id: DATABASE_ID });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(j?.message ?? r.status);
    if (r.status === 404 || /Could not find/i.test(msg)) throw new Error("Notionの「Claude連携」データベースが見つかりません。データベースの「…」→「接続」から、このアプリのインテグレーションを追加してください");
    throw new Error("Notionへの保存に失敗しました: " + msg.slice(0, 200));
  }
  return { url: j.url as string };
}
