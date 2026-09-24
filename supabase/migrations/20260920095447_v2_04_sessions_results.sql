-- ============ Exam sessions (one row per attempt) ============
create table public.exam_sessions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams (id) on delete restrict,
  student_name text not null check (char_length(btrim(student_name)) between 1 and 80),
  student_name_normalized text generated always as (public.normalize_text(student_name)) stored,
  student_class text not null check (char_length(btrim(student_class)) between 1 and 40),
  student_class_normalized text generated always as (public.normalize_text(student_class)) stored,
  attempt_no integer not null default 1 check (attempt_no >= 1),
  status public.session_status not null default 'in_progress',
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  extra_seconds integer not null default 0 check (extra_seconds >= 0),
  submitted_at timestamptz,
  last_heartbeat_at timestamptz,
  questions_snapshot jsonb not null,          -- questions as the student sees them (no answer key)
  answer_key jsonb not null,                  -- server only: correct answers and weights for this session
  tab_switch_count integer not null default 0 check (tab_switch_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The 1-attempt rule: same exam + same normalized name + same normalized class can only repeat with a new attempt number.
  unique (exam_id, student_name_normalized, student_class_normalized, attempt_no)
);
create index exam_sessions_exam_status_idx on public.exam_sessions (exam_id, status);
create index exam_sessions_heartbeat_idx on public.exam_sessions (last_heartbeat_at) where status = 'in_progress';

-- ============ Answers (autosaved during the exam) ============
create table public.session_answers (
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete restrict,
  answer jsonb not null,
  is_flagged boolean not null default false,
  answered_at timestamptz not null default now(),
  client_saved_at timestamptz,
  primary key (session_id, question_id)       -- sending the same answer again never creates a duplicate
);

-- ============ Grades per question (automatic and manual) ============
create table public.answer_grades (
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete restrict,
  points_awarded numeric(6,2) not null check (points_awarded >= 0),
  max_points numeric(6,2) not null check (max_points > 0),
  is_auto boolean not null default true,
  graded_by uuid references public.profiles (id) on delete set null,   -- null when graded automatically
  feedback text check (feedback is null or char_length(feedback) <= 2000),
  graded_at timestamptz not null default now(),
  primary key (session_id, question_id),
  check (points_awarded <= max_points)
);

-- ============ Results ============
create table public.exam_results (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.exam_sessions (id) on delete cascade,   -- one result per session
  total_points numeric(7,2) not null check (total_points >= 0),
  max_points numeric(7,2) not null check (max_points > 0),
  percentage numeric(5,2) not null check (percentage between 0 and 100),
  status public.result_status not null default 'graded',
  pass_status public.pass_status not null,
  correct_count integer not null default 0 check (correct_count >= 0),
  wrong_count integer not null default 0 check (wrong_count >= 0),
  time_used_seconds integer not null default 0 check (time_used_seconds >= 0),
  review_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'pending_review') = (pass_status = 'not_final'))
);

-- ============ Session events (anti-cheating log) ============
create table public.session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 60),
  severity public.event_severity not null default 'info',
  meta jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index session_events_session_idx on public.session_events (session_id, occurred_at);

create trigger set_updated_at before update on public.exam_sessions for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.exam_results for each row execute function public.set_updated_at();

alter table public.exam_sessions enable row level security;
alter table public.session_answers enable row level security;
alter table public.answer_grades enable row level security;
alter table public.exam_results enable row level security;
alter table public.session_events enable row level security;
