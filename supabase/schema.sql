-- Run this once in the Supabase SQL editor.

create table if not exists leads (
  id bigint generated always as identity primary key,
  channel text not null check (channel in ('whatsapp', 'instagram')),
  external_id text not null,            -- WhatsApp number or Instagram-scoped ID
  name text,
  phone text,
  goal text,
  preferred_time text,
  state text not null default 'idle',   -- idle, ask_name, ask_goal, ask_time, ask_consent
  booked boolean not null default false,
  needs_human boolean not null default false,
  last_seen_before boolean not null default false,
  opt_in boolean not null default false, -- agreed to offers and reminders
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_id)
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  channel text not null,
  external_id text not null,
  message_id text,                      -- Meta's message ID; used to drop duplicate webhooks
  direction text not null check (direction in ('in', 'out')),
  body text,
  created_at timestamptz not null default now()
);
create unique index if not exists messages_message_id_key on messages (message_id) where message_id is not null;

create table if not exists members (
  id bigint generated always as identity primary key,
  name text,
  phone text not null,                  -- international format, digits only, e.g. 919876543210
  plan text,
  expires_on date,
  opt_in boolean not null default false,
  last_reminded_on date,
  created_at timestamptz not null default now()
);
create index if not exists members_expires_on_idx on members (expires_on);

-- The service uses the service role key, which bypasses row level security.
-- Turn RLS on so the public anon key can never read these tables.
alter table leads enable row level security;
alter table messages enable row level security;
alter table members enable row level security;
