create table if not exists public.studyai_feedback (
  id uuid primary key,
  user_id uuid references public.studyai_users(id) on delete set null,
  name text,
  email text,
  rating integer not null default 5 check (rating between 1 and 5),
  message text not null check (char_length(message) between 5 and 1200),
  page text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.studyai_feedback enable row level security;

grant usage on schema public to service_role;
grant insert on public.studyai_feedback to service_role;

create index if not exists studyai_feedback_created_at_idx
  on public.studyai_feedback (created_at desc);

create index if not exists studyai_feedback_rating_idx
  on public.studyai_feedback (rating);
