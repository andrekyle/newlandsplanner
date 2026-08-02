-- Newlands SDA Church Programme Planner — Supabase schema
-- Run this once in the Supabase SQL Editor (project: newlandsplanner).

create table if not exists public.events (
  id         text primary key,
  date       text not null,          -- YYYY-MM-DD
  type       text not null,          -- event type key (sabbath, board_meeting, ...)
  data       jsonb not null,         -- all form fields
  updated_at text not null,
  updated_by text
);
create index if not exists idx_events_date on public.events (date);

create table if not exists public.names (
  field text not null,               -- duty/field key e.g. songService
  name  text not null,
  uses  integer not null default 1,
  primary key (field, name)
);

-- Upsert helper used by the server for name suggestions
create or replace function public.bump_name(p_field text, p_name text)
returns void
language sql
security definer
as $$
  insert into public.names (field, name, uses) values (p_field, p_name, 1)
  on conflict (field, name) do update set uses = public.names.uses + 1;
$$;

-- Lock the tables down: only the service role (used by the server) may access them.
alter table public.events enable row level security;
alter table public.names  enable row level security;
