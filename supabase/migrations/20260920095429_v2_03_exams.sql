-- ============ Exams ============
create table public.exams (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  status public.exam_status not null default 'draft',
  duration_minutes integer not null check (duration_minutes between 1 and 600),
  passing_grade integer not null default 75 check (passing_grade between 0 and 100),
  availability_mode public.availability_mode not null default 'manual',
  starts_at timestamptz,
  ends_at timestamptz,
  late_start_policy public.late_start_policy not null default 'full_duration',
  access_code text not null check (access_code ~ '^[A-Z0-9]{4,12}$'),
  selection_mode public.selection_mode not null default 'manual',
  auto_filter jsonb not null default '{}'::jsonb,
  pool_size integer check (pool_size is null or pool_size > 0),
  draw_per_student boolean not null default true,
  randomize_questions boolean not null default true,
  randomize_options boolean not null default true,
  result_visibility public.result_visibility not null default 'score',
  essay_pending_display public.essay_pending_display not null default 'hide_score',
  tab_switch_warn_limit integer not null default 1 check (tab_switch_warn_limit >= 0),
  tab_switch_flag_limit integer not null default 3 check (tab_switch_flag_limit >= 0),
  tab_switch_autosubmit_limit integer not null default 5 check (tab_switch_autosubmit_limit >= 0),   -- 0 = automatic submit turned off
  is_template boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exams_schedule_valid check (
    availability_mode = 'manual'
    or (starts_at is not null and ends_at is not null and ends_at > starts_at)
  ),
  constraint exams_limits_ordered check (
    tab_switch_autosubmit_limit = 0
    or (tab_switch_warn_limit <= tab_switch_flag_limit and tab_switch_flag_limit <= tab_switch_autosubmit_limit)
  ),
  constraint exams_auto_needs_pool check (selection_mode = 'manual' or pool_size is not null)
);
-- A code can only be in use by one open exam at a time.
create unique index exams_open_code_unique on public.exams (access_code) where status = 'open';
create index exams_status_idx on public.exams (status, is_template);

-- ============ Exam questions (manual selection) ============
create table public.exam_questions (
  exam_id uuid not null references public.exams (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete restrict,
  position integer not null check (position > 0),
  weight numeric(6,2) not null default 1 check (weight > 0),
  primary key (exam_id, question_id),
  unique (exam_id, position) deferrable initially deferred
);
create index exam_questions_question_idx on public.exam_questions (question_id);

-- ============ Retake permissions (remedial, single use) ============
create table public.retake_permissions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams (id) on delete cascade,
  student_name_normalized text not null check (student_name_normalized = public.normalize_text(student_name_normalized)),
  student_class_normalized text not null check (student_class_normalized = public.normalize_text(student_class_normalized)),
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  used_at timestamptz
);
create unique index retake_permissions_unused_unique
  on public.retake_permissions (exam_id, student_name_normalized, student_class_normalized)
  where used_at is null;

create trigger set_updated_at before update on public.exams for each row execute function public.set_updated_at();

alter table public.exams enable row level security;
alter table public.exam_questions enable row level security;
alter table public.retake_permissions enable row level security;
