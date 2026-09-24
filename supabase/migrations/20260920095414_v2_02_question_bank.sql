-- ============ Reading passages (shared by several questions) ============
create table public.passages (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 20000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ Questions ============
create table public.questions (
  id uuid primary key default gen_random_uuid(),
  legacy_id integer unique,                       -- id in the v1 database, for traceability
  type public.question_type not null,
  topic_id uuid references public.topics (id) on delete set null,
  difficulty public.difficulty_level not null default 'medium',
  passage_id uuid references public.passages (id) on delete set null,
  body text not null check (char_length(body) between 1 and 5000),
  explanation text check (explanation is null or char_length(explanation) <= 5000),
  default_weight numeric(6,2) not null default 1 check (default_weight > 0),
  essay_guidance text check (essay_guidance is null or char_length(essay_guidance) <= 5000),
  content_hash text not null,                     -- for duplicate detection
  is_archived boolean not null default false,     -- questions used by exams are archived, not deleted
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index questions_topic_idx on public.questions (topic_id);
create index questions_passage_idx on public.questions (passage_id);
create index questions_hash_idx on public.questions (content_hash);
create index questions_active_idx on public.questions (is_archived, type, difficulty);

-- ============ Answer options (multiple choice and true/false) ============
create table public.question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  position smallint not null check (position between 1 and 8),
  body text not null check (char_length(body) between 1 and 1000),
  is_correct boolean not null default false,
  unique (question_id, position)
);
create unique index question_options_one_correct on public.question_options (question_id) where is_correct;

-- ============ Accepted answers (short answer) ============
create table public.accepted_answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  answer_text text not null check (char_length(answer_text) between 1 and 300),
  answer_normalized text generated always as (public.normalize_text(answer_text)) stored,
  unique (question_id, answer_normalized)
);

-- ============ Class labels on questions (typed freely, normalized) ============
create table public.question_class_labels (
  question_id uuid not null references public.questions (id) on delete cascade,
  label_display text not null check (char_length(label_display) between 1 and 40),
  label_normalized text generated always as (public.normalize_text(label_display)) stored,
  primary key (question_id, label_normalized)
);
create index question_class_labels_label_idx on public.question_class_labels (label_normalized);

-- ============ Media files (images and audio, stored in Supabase Storage) ============
create table public.media_files (
  id uuid primary key default gen_random_uuid(),
  kind public.media_kind not null,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.question_media (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references public.media_files (id) on delete restrict,
  question_id uuid references public.questions (id) on delete cascade,
  passage_id uuid references public.passages (id) on delete cascade,
  position smallint not null default 0,
  check (num_nonnulls(question_id, passage_id) = 1)
);
create index question_media_question_idx on public.question_media (question_id);
create index question_media_passage_idx on public.question_media (passage_id);
create index question_media_media_idx on public.question_media (media_id);

-- ============ Triggers and RLS ============
create trigger set_updated_at before update on public.passages for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.questions for each row execute function public.set_updated_at();

alter table public.passages enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.accepted_answers enable row level security;
alter table public.question_class_labels enable row level security;
alter table public.media_files enable row level security;
alter table public.question_media enable row level security;
