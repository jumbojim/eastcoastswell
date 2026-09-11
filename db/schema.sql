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
  matched_break_id   integer references breaks(id),
  frequency          text not null check (frequency in ('daily', 'weekly')),
  status             text not null default 'active' check (status in ('active', 'unsubscribed')),
  opt_in_timestamp   timestamptz not null default now(),
  unsubscribed_at    timestamptz,
  resubscribed_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_subscribers_break_freq_status
  on subscribers (matched_break_id, frequency, status);

create index if not exists idx_subscribers_status
  on subscribers (status);

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
