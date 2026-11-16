-- 株ラボ（stock-trader）用のテーブル。株価は全員共通、ボット・取引履歴は本人のものだけ見える
create table if not exists public.st_symbols (
  market text not null check (market in ('JP','US')),
  symbol text not null,
  name text,
  first_date date,
  last_date date,
  last_fetched timestamptz,
  primary key (market, symbol)
);

create table if not exists public.st_prices (
  market text not null,
  symbol text not null,
  d date not null,
  o double precision, h double precision, l double precision, c double precision, v double precision,
  primary key (market, symbol, d)
);

create table if not exists public.st_bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  market text not null check (market in ('JP','US')),
  cfg jsonb not null,
  state jsonb not null,
  active boolean not null default true,
  halted_reason text,
  last_run_at timestamptz,
  last_message text,
  created_at timestamptz not null default now()
);
create index if not exists st_bots_user on public.st_bots(user_id);

create table if not exists public.st_trades (
  id bigint generated always as identity primary key,
  bot_id uuid not null references public.st_bots(id) on delete cascade,
  user_id uuid not null,
  d date not null,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  qty double precision not null,
  price double precision not null,
  fee double precision not null default 0,
  pnl double precision,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists st_trades_bot on public.st_trades(bot_id, d);
create index if not exists st_trades_user on public.st_trades(user_id);

create table if not exists public.st_equity (
  bot_id uuid not null references public.st_bots(id) on delete cascade,
  user_id uuid not null,
  d date not null,
  equity double precision not null,
  cash double precision not null,
  primary key (bot_id, d)
);
create index if not exists st_equity_user on public.st_equity(user_id);

alter table public.st_symbols enable row level security;
alter table public.st_prices enable row level security;
alter table public.st_bots enable row level security;
alter table public.st_trades enable row level security;
alter table public.st_equity enable row level security;

-- 書き込みは Edge Function（service role）だけ。画面からは読むのと、自分のボットの削除だけ
create policy "st_symbols read" on public.st_symbols for select to authenticated using (true);
create policy "st_prices read" on public.st_prices for select to authenticated using (true);
create policy "st_bots own select" on public.st_bots for select to authenticated using ((select auth.uid()) = user_id);
create policy "st_bots own delete" on public.st_bots for delete to authenticated using ((select auth.uid()) = user_id);
create policy "st_trades own select" on public.st_trades for select to authenticated using ((select auth.uid()) = user_id);
create policy "st_equity own select" on public.st_equity for select to authenticated using ((select auth.uid()) = user_id);

-- 自動実行の合言葉（画面からは読めない。Edge Function だけが読む）
create table if not exists public.st_config (key text primary key, value text not null);
alter table public.st_config enable row level security;
insert into public.st_config(key, value) values ('cron_key', encode(gen_random_bytes(24), 'hex')) on conflict (key) do nothing;

-- このプロジェクトは新しいテーブルに自動で権限が付かないので明示する
grant select, insert, update, delete on public.st_symbols, public.st_prices, public.st_bots, public.st_trades, public.st_equity, public.st_config to service_role;
grant select on public.st_symbols, public.st_prices, public.st_bots, public.st_trades, public.st_equity to authenticated;
grant delete on public.st_bots to authenticated;

-- 毎営業日の引け後に模擬取引を進める（日本株 18:10 JST、米国株 翌朝 8:10 JST）
select cron.schedule('stock-trader-jp-close', '10 9 * * 1-5', $$select net.http_post(url := 'https://oqtyorwlrnrcyjxiassg.supabase.co/functions/v1/stock-trader', body := '{"action":"run_all"}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-cron-key',(select value from public.st_config where key='cron_key')), timeout_milliseconds := 300000)$$);
select cron.schedule('stock-trader-us-close', '10 23 * * 1-5', $$select net.http_post(url := 'https://oqtyorwlrnrcyjxiassg.supabase.co/functions/v1/stock-trader', body := '{"action":"run_all"}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-cron-key',(select value from public.st_config where key='cron_key')), timeout_milliseconds := 300000)$$);
