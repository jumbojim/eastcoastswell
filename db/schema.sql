-- East Coast Swell SMS — schema
-- Run this once against your Supabase Postgres database (Supabase SQL editor,
-- or `npm run migrate`, which just executes this file).

create table if not exists breaks (
  id             serial primary key,
  break_name     text not null,
  state          text,
  region         text,
  latitude       double precision not null,
  longitude      double precision not null,
  notes          text,
  created_at     timestamptz not null default now(),
  constraint uq_breaks_name_state unique (break_name, state)
);

create table if not exists subscribers (
  id                 serial primary key,
  phone              text not null unique,        -- E.164, e.g. +15555550123
  zip                text not null,
  lookup_latitude    double precision,
  lookup_longitude   double precision,
  matched_break_id   integer references breaks(id), -- legacy: first/primary break from
                                                      -- before multi-break support. No
                                                      -- longer written to; superseded by
                                                      -- subscriber_breaks below. Kept so we
                                                      -- don't drop a populated column.
  frequency          text not null check (frequency in ('daily', 'weekly')),
  status             text not null default 'active' check (status in ('active', 'unsubscribed')),
  opt_in_timestamp   timestamptz not null default now(),
  unsubscribed_at    timestamptz,
  resubscribed_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_subscribers_status
  on subscribers (status);

-- Superseded by idx_subscriber_breaks_break below now that break<->subscriber
-- is many-to-many; drop if it exists from an earlier deploy.
drop index if exists idx_subscribers_break_freq_status;

-- One row per (subscriber, break) they follow — replaces the old
-- one-break-per-subscriber assumption (subscribers.matched_break_id).
-- Application code enforces the max-breaks-per-subscriber cap; nothing here.
create table if not exists subscriber_breaks (
  id             serial primary key,
  subscriber_id  integer not null references subscribers(id) on delete cascade,
  break_id       integer not null references breaks(id) on delete cascade,
  created_at     timestamptz not null default now(),
  constraint uq_subscriber_breaks unique (subscriber_id, break_id)
);

create index if not exists idx_subscriber_breaks_subscriber on subscriber_breaks (subscriber_id);
create index if not exists idx_subscriber_breaks_break on subscriber_breaks (break_id);

-- One-time backfill: carry forward anyone's existing single break into the
-- new table. Safe to re-run (ON CONFLICT DO NOTHING).
insert into subscriber_breaks (subscriber_id, break_id)
select id, matched_break_id from subscribers
where matched_break_id is not null
on conflict (subscriber_id, break_id) do nothing;

create table if not exists message_log (
  id                serial primary key,
  break_id          integer references breaks(id),
  frequency         text not null,
  message_body      text not null,
  recipients_count  integer not null default 0,
  failures_count    integer not null default 0,
  sent_at           timestamptz not null default now()
);

create table if not exists send_failures (
  id             serial primary key,
  subscriber_id  integer references subscribers(id),
  phone          text,
  error_message  text,
  occurred_at    timestamptz not null default now()
);

-- Keep updated_at current on subscribers
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_subscribers_updated_at on subscribers;
create trigger trg_subscribers_updated_at
  before update on subscribers
  for each row execute function set_updated_at();
