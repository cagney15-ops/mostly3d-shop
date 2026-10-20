-- 812 Sensory agent office: tables the agents write and the Daily Brief reads.
-- Every table is row-level secured the same way as the shop app (is_allowed() on the signed-in email).
-- The scheduled agents write through the Supabase service connection, which bypasses RLS.

create table if not exists office_agents (
  id text primary key,                     -- slug: chief, till, booker, scout, stock, post, inbox, ledger, hello, site
  name text not null,
  role text not null,                      -- short role line shown on the desk card
  blurb text not null default '',          -- one-paragraph profile
  instructions text not null default '',   -- editable standing orders the agent reads at the start of every run
  cadence_text text not null default '',   -- human wording of the schedule
  cron text,                               -- the schedule as created (informational)
  trigger_id text,                         -- scheduled task id
  phase int not null default 1,            -- 1 live, 2 next, 3 later
  enabled boolean not null default true,
  status text not null default 'idle',     -- idle | running | error | paused | hiring
  current_task text,
  last_run_at timestamptz,
  last_run_status text,
  last_summary text,
  next_run_at timestamptz,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists office_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references office_agents(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running', -- running | done | failed | skipped
  summary text,
  stats jsonb not null default '{}'::jsonb,
  error text
);
create index if not exists office_runs_agent_started on office_runs(agent_id, started_at desc);

create table if not exists office_run_events (
  id bigserial primary key,
  run_id uuid not null references office_runs(id) on delete cascade,
  agent_id text not null,
  at timestamptz not null default now(),
  kind text not null default 'info',      -- info | found | wrote | flag | error
  message text not null,
  data jsonb
);
create index if not exists office_run_events_run on office_run_events(run_id, at);

create table if not exists office_briefs (
  id uuid primary key default gen_random_uuid(),
  for_date date not null,
  period text not null default 'morning', -- morning | evening | adhoc
  greeting text,
  headline text not null,
  body_md text not null,
  sections jsonb not null default '[]'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  emailed_to text[],
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists office_briefs_date on office_briefs(for_date desc, created_at desc);

create table if not exists office_decisions (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  title text not null,
  detail_md text not null default '',
  options jsonb not null default '[]'::jsonb, -- [{"key":"yes","label":"Yes, do it"}, ...]
  chosen text,
  answer_note text,
  answered_at timestamptz,
  answered_by text,
  status text not null default 'open',    -- open | answered | expired | acted
  priority text not null default 'normal',-- normal | high
  due_at timestamptz,
  link_url text,
  ref jsonb,
  created_at timestamptz not null default now()
);
create index if not exists office_decisions_open on office_decisions(status, created_at desc);

create table if not exists office_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  title text not null,
  detail text,
  kind text not null default 'reminder',  -- reminder | todo | nudge
  due_at timestamptz,
  done boolean not null default false,
  done_at timestamptz,
  done_by text,
  snoozed_until timestamptz,
  link_url text,
  ref jsonb,
  created_at timestamptz not null default now()
);
create index if not exists office_tasks_open on office_tasks(done, due_at);

create table if not exists office_orders (
  id uuid primary key default gen_random_uuid(),
  channel text not null,                  -- wix | etsy | tiktok | booking | plan | giftcard | paylink | other
  external_id text not null,
  number text,
  placed_at timestamptz,
  customer_name text,
  customer_email text,
  items jsonb not null default '[]'::jsonb,
  items_summary text,
  total numeric(10,2),
  currency text default 'USD',
  payment_status text,
  fulfillment_status text,
  buyer_note text,
  source_url text,
  flags text[] not null default '{}',
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (channel, external_id)
);
create index if not exists office_orders_placed on office_orders(placed_at desc);

create table if not exists office_bookings (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  service_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  customer_name text,
  customer_email text,
  customer_phone text,
  status text,
  payment_status text,
  participants int,
  notes text,
  prep_sent boolean not null default false,
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists office_bookings_start on office_bookings(starts_at);

create table if not exists office_events (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null default 'scout',
  name text not null,
  start_date date,
  end_date date,
  city text,
  venue text,
  address text,
  distance_miles numeric(6,1),
  category text,                          -- festival | market | fair | craft show | holiday bazaar | school | other
  fee text,
  booth text,
  deadline date,
  attendance text,
  apply_url text,
  info_url text,
  summary text,
  fit_score int,                          -- 1-5, how well it fits kids/family foot traffic
  fit_notes text,
  status text not null default 'found',   -- found | kept | removed | applied | accepted | scheduled | declined | past
  reserved boolean not null default false,
  on_calendar boolean not null default false,
  notes text,
  source text,
  found_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists office_events_name_date on office_events (lower(name), coalesce(start_date, '1900-01-01'::date));
create index if not exists office_events_status on office_events(status, start_date);

create table if not exists office_insights (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null default 'stock',
  run_id uuid references office_runs(id) on delete set null,
  kind text not null,                     -- low_stock | top_seller | trend | dead_stock | margin | placeholder | summary | idea
  severity text not null default 'info',  -- info | watch | act
  title text not null,
  detail_md text not null default '',
  data jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists office_insights_created on office_insights(created_at desc);

create table if not exists office_posts (
  id uuid primary key default gen_random_uuid(),
  platform text not null,                 -- tiktok | instagram | facebook
  kind text not null default 'post',      -- post | reel | story
  scheduled_for timestamptz,
  hook text,
  caption text,
  hashtags text,
  media jsonb not null default '[]'::jsonb,
  status text not null default 'draft',   -- draft | approved | published | rejected
  approved_by text,
  approved_at timestamptz,
  published_at timestamptz,
  external_url text,
  created_at timestamptz not null default now()
);

create table if not exists office_messages (
  id uuid primary key default gen_random_uuid(),
  platform text not null,                 -- instagram | facebook | tiktok | email | site
  external_id text,
  from_name text,
  received_at timestamptz,
  text text,
  category text,                          -- question | order | party | compliment | spam | other
  auto_acked boolean not null default false,
  draft_reply text,
  status text not null default 'open',    -- open | replied | dismissed
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (platform, external_id)
);

create table if not exists office_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row-level security: same rule as the rest of the shop.
do $$
declare t text;
begin
  foreach t in array array['office_agents','office_runs','office_run_events','office_briefs','office_decisions','office_tasks','office_orders','office_bookings','office_events','office_insights','office_posts','office_messages','office_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "allowed users manage %s" on %I', t, t);
    execute format('create policy "allowed users manage %s" on %I for all to authenticated using (is_allowed()) with check (is_allowed())', t, t);
  end loop;
end $$;

-- Live updates for the Daily Brief page.
do $$
declare t text;
begin
  foreach t in array array['office_agents','office_runs','office_run_events','office_briefs','office_decisions','office_tasks','office_orders','office_bookings','office_events','office_insights','office_posts','office_messages','office_settings'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename=t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Write helpers. Agents never write INSERT/UPDATE/DELETE themselves (the MCP tool gates
-- them behind a confirmation prompt); every write goes through one of these, called with SELECT.
-- Security definer so the scheduled runs can write without an authenticated user.
-- office_start_run(agent, task) -> run id            office_finish_run(run, status, summary, stats, error)
-- office_set_task(agent, task)                        office_log(run, agent, kind, message, data)
-- office_task(agent, title, detail, kind, due, link, ref)   -> no-op if an open task with the title exists
-- office_decision(agent, title, detail, options, priority, due, link, ref) -> no-op if open title exists
-- office_decision_acted(id)   office_task_done(id, by)
-- office_upsert_order(jsonb)  office_upsert_booking(jsonb)  office_booking_prep_sent(external_id)
-- office_upsert_event(jsonb)  office_events_mark_past()
-- office_insight(agent, run, kind, severity, title, detail, data)   office_clear_insights(agent, days)
-- office_save_brief(date, period, greeting, headline, body, stats) -> id   office_brief_emailed(id, emails[])
-- office_sweep_stale()  marks runs open > 2 h as failed     office_delete_rows(table, key, value)  admin cleanup
-- Definitions live in the Supabase migrations office_run_helpers, office_write_helpers, office_admin_helpers.
-- Known tool quirk: a '#' character anywhere in SQL text hangs the Supabase MCP execute_sql call (180 s timeout).
