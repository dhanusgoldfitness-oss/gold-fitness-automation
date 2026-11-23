-- DRAFT, NOT APPLIED. New tables for the GOLD FITNESS KENGERI enquiry bot. Additive only; no existing table is changed.
-- Row Level Security is on with no policies, so only the service role (the Render service) can read or write them.

create table if not exists public.wa_bot_inbound_events (
  wamid text primary key,                      -- WhatsApp message id: the dedupe key
  chat text not null,
  name text,
  msg_type text,
  payload jsonb not null,
  status text not null default 'received',     -- received -> processing -> processed | error | ignored_*
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists wa_bot_inbound_status_idx on public.wa_bot_inbound_events (status, received_at);

create table if not exists public.wa_bot_sessions (
  chat text primary key,
  state jsonb not null,                        -- {menu, lang, step, data, status, staffSince}
  updated_at timestamptz not null default now()
);

create table if not exists public.wa_bot_photo_jobs (
  job_key text primary key,                    -- photos:<chat>:<triggering wamid>; a webhook retry cannot create a second batch
  chat text not null,
  status text not null,                        -- pending | running | paused_rate_limit | done
  created_at_ms bigint not null,
  job jsonb not null                           -- per-asset progress: pending | sending | accepted | failed | uncertain
);
create index if not exists wa_bot_photo_jobs_chat_idx on public.wa_bot_photo_jobs (chat, created_at_ms desc);

create table if not exists public.wa_bot_visit_requests (
  id uuid primary key default gen_random_uuid(),
  chat text not null,
  name text,
  preferred_slot text,
  source text default 'whatsapp_bot',
  status text not null default 'requested',    -- requested | confirmed | cancelled (set by staff)
  created_at timestamptz not null default now()
);

create table if not exists public.wa_bot_handoffs (
  id uuid primary key default gen_random_uuid(),
  chat text not null, name text, reason text, details text,
  created_at timestamptz not null default now(), resolved_at timestamptz
);

create table if not exists public.wa_bot_staff_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text, chat text, name text, text text,
  created_at timestamptz not null default now(), seen_at timestamptz
);

create table if not exists public.wa_bot_media_errors (
  id uuid primary key default gen_random_uuid(),
  chat text, job_key text, public_id text, kind text, message text,
  created_at timestamptz not null default now()
);

create table if not exists public.wa_bot_missing_settings (
  setting_key text primary key, context text, last_seen_at timestamptz not null default now()
);

create table if not exists public.wa_bot_status_events (
  id uuid primary key default gen_random_uuid(),
  message_id text not null, status text not null, recipient text, errors jsonb,
  received_at timestamptz not null default now()
);
create index if not exists wa_bot_status_msg_idx on public.wa_bot_status_events (message_id);

create table if not exists public.wa_bot_timings (wamid text primary key, report jsonb not null);
create table if not exists public.wa_bot_outbound_links (out_id text primary key, inbound_wamid text not null);

alter table public.wa_bot_inbound_events enable row level security;
alter table public.wa_bot_sessions enable row level security;
alter table public.wa_bot_photo_jobs enable row level security;
alter table public.wa_bot_visit_requests enable row level security;
alter table public.wa_bot_handoffs enable row level security;
alter table public.wa_bot_staff_notifications enable row level security;
alter table public.wa_bot_media_errors enable row level security;
alter table public.wa_bot_missing_settings enable row level security;
alter table public.wa_bot_status_events enable row level security;
alter table public.wa_bot_timings enable row level security;
alter table public.wa_bot_outbound_links enable row level security;

-- Owner-command enquiry packs (owner sends a client's number; the bot sends the pack).
create table if not exists public.wa_bot_pack_sends (
  owner_wamid text primary key,
  client text not null,
  mode text,                                   -- pack_in_window | template
  status text not null,                        -- accepted | uncertain | failed | not_sent
  error text,
  created_at_ms bigint not null,
  detail jsonb not null
);
create index if not exists wa_bot_pack_sends_client_idx on public.wa_bot_pack_sends (client, created_at_ms desc);
create table if not exists public.wa_bot_pack_notices (notice_key text primary key, created_at timestamptz not null default now());
alter table public.wa_bot_pack_sends enable row level security;
alter table public.wa_bot_pack_notices enable row level security;
