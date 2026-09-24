-- ============ Enums ============
create type public.user_role as enum ('teacher', 'admin');
create type public.question_type as enum ('multiple_choice', 'true_false', 'short_answer', 'essay');
create type public.difficulty_level as enum ('easy', 'medium', 'hots');
create type public.exam_status as enum ('draft', 'open', 'closed');
create type public.availability_mode as enum ('manual', 'scheduled');
create type public.late_start_policy as enum ('full_duration', 'cut_at_end');
create type public.selection_mode as enum ('manual', 'auto');
create type public.result_visibility as enum ('none', 'score', 'score_and_review');
create type public.essay_pending_display as enum ('hide_score', 'show_partial');
create type public.session_status as enum ('in_progress', 'submitted', 'auto_submitted', 'timed_out', 'reopened');
create type public.result_status as enum ('pending_review', 'graded');
create type public.pass_status as enum ('passed', 'failed', 'not_final');
create type public.event_severity as enum ('info', 'warning', 'suspicious', 'violation');
create type public.media_kind as enum ('image', 'audio');
create type public.backup_kind as enum ('manual', 'automatic');

-- ============ Helper functions ============
create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Same rule the app uses for names and classes: ignore letter case and extra spaces.
create function public.normalize_text(t text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'))
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.normalize_text(text) from public, anon, authenticated;

-- ============ Profiles (teacher/admin accounts, linked to Supabase Auth) ============
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 120),
  role public.user_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ Topics ============
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  level smallint check (level in (10, 11, 12)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index topics_name_unique on public.topics (public.normalize_text(name));

-- ============ Class aliases (teacher merges spelling variants of a class name) ============
create table public.class_aliases (
  alias_normalized text primary key check (alias_normalized = public.normalize_text(alias_normalized) and char_length(alias_normalized) between 1 and 40),
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

-- ============ App settings (small key/value store) ============
create table public.app_settings (
  key text primary key check (char_length(key) between 1 and 80),
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ============ Rate limiting buckets (join attempts, exam-code attempts) ============
create table public.rate_limits (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 1 check (hits >= 0),
  primary key (bucket, key, window_start)
);
create index rate_limits_window_idx on public.rate_limits (window_start);

-- ============ Audit log ============
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (char_length(action) between 1 and 80),
  entity_type text not null check (char_length(entity_type) between 1 and 60),
  entity_id text,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

-- ============ Backups ============
create table public.backups (
  id uuid primary key default gen_random_uuid(),
  kind public.backup_kind not null,
  storage_path text not null,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ============ updated_at triggers ============
create trigger set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.topics for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.app_settings for each row execute function public.set_updated_at();

-- ============ Row Level Security: on, no policies (all access goes through Edge Functions) ============
alter table public.profiles enable row level security;
alter table public.topics enable row level security;
alter table public.class_aliases enable row level security;
alter table public.app_settings enable row level security;
alter table public.rate_limits enable row level security;
alter table public.audit_logs enable row level security;
alter table public.backups enable row level security;
