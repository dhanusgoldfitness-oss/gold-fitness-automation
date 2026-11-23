-- DRAFT. NOT APPLIED. Review before running against the "DGF claude app" project (tdllxiresvvucorpmqzn).
-- Adds the tables for enquiry capture preferences and scheduled WhatsApp messages. It does not alter any existing table.
-- Like 002: RLS enabled with no policies (only the service role used by the Render bot can read/write) and explicit revokes.
-- Leads/contacts/members are the ERP's own tables; ids here are plain uuids (no foreign keys) so nothing in the ERP is coupled to these tables.

create table if not exists wa_person_prefs (
  phone text primary key,                    -- normalised 91XXXXXXXXXX; one row per person, whether lead or member
  name text,
  language text not null default 'en' check (language in ('en','kn')),
  lead_id uuid, member_id uuid, contact_id uuid,
  motivation text not null default 'off' check (motivation in ('daily','weekly','off')),
  weekly_dow smallint check (weekly_dow between 1 and 7),   -- 1=Monday; null = Monday
  weekly_time text,                                          -- 'HH:MM' IST; null = campaign time
  birthday_wishes boolean not null default false,
  birth_month smallint check (birth_month between 1 and 12), -- month and day only, never a year
  birth_day smallint check (birth_day between 1 and 31),
  festival_greetings boolean not null default false,
  stopped_at timestamptz,                    -- STOP: survives lead -> member; cleared only by START
  consent jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wa_person_prefs_birthday_idx on wa_person_prefs (birth_month, birth_day) where birthday_wishes;

create table if not exists wa_consent_log (  -- append-only: scope, value, source, timestamp
  id bigserial primary key,
  phone text not null,
  scope text not null check (scope in ('motivation','birthday','festival','all')),
  value text not null,
  source text not null,
  at timestamptz not null default now()
);
create index if not exists wa_consent_log_phone_idx on wa_consent_log (phone, at desc);

create table if not exists wa_sched_campaigns (
  key text primary key check (key in ('birthday','festival','motivation_daily','motivation_weekly','closure_notice','revised_hours')),
  enabled boolean not null default false,    -- every campaign starts OFF
  send_time text,                            -- 'HH:MM' IST, owner-editable
  preview_hash text, previewed_at bigint,
  enabled_at bigint, enabled_by text, disabled_at bigint, disabled_by text,
  updated_at timestamptz not null default now()
);

create table if not exists wa_calendar_events (
  id text primary key,
  event_date date not null,
  type text not null check (type in ('festival','national','holiday','closure')),
  name_en text, name_kn text,
  greet boolean not null default false,
  verified boolean not null default false,   -- a greeting is only sent for a verified date
  gym_closed boolean not null default false, -- only the owner sets this; a holiday never closes the gym by itself
  revised_hours text,
  reason_en text, reason_kn text,
  notice_rev integer not null default 0,     -- bumped on owner edits so a changed notice is sent once more
  cancelled boolean not null default false,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists wa_calendar_events_date_idx on wa_calendar_events (event_date);

create table if not exists wa_motivation_messages (
  id text primary key default ('mot-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
  lang text not null check (lang in ('en','kn')),
  category text not null check (category in ('workout','consistency','recovery')),
  text text not null check (char_length(text) between 10 and 300),
  approved boolean not null default false,   -- owner approves each message
  created_at timestamptz not null default now()
);

create table if not exists wa_send_queue (
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null,
  occurrence_key text not null,              -- date, ISO week, event id + revision, or birthday:<year>
  phone text not null,
  kind text not null check (kind in ('birthday','festival','motivation','notice')),
  priority smallint not null,
  ist_date date not null,
  scheduled_for bigint not null,             -- epoch ms
  expires_at bigint not null,
  template text not null, lang text not null, params jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','sending','accepted','delivered','read','failed','uncertain','cancelled','expired')),
  attempts integer not null default 0,
  sending_at bigint, wamid text,
  accepted_at bigint, sent_at bigint, delivered_at bigint, read_at bigint, failed_at bigint,   -- tracked separately
  error text, error_code integer, cancel_reason text,
  created_at timestamptz not null default now(),
  unique (campaign_key, occurrence_key, phone)               -- one row per campaign occurrence and recipient
);
-- At most one greeting/motivation per person per IST day (cancelled/failed/expired rows do not count).
create unique index if not exists wa_send_queue_day_cap on wa_send_queue (phone, ist_date)
  where kind in ('birthday','festival','motivation') and status in ('queued','sending','accepted','uncertain','delivered','read');
create index if not exists wa_send_queue_due on wa_send_queue (scheduled_for) where status = 'queued';
create index if not exists wa_send_queue_wamid on wa_send_queue (wamid) where wamid is not null;

do $$
declare t text;
begin
  foreach t in array array['wa_person_prefs','wa_consent_log','wa_sched_campaigns','wa_calendar_events','wa_motivation_messages','wa_send_queue'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence wa_consent_log_id_seq from anon, authenticated;
