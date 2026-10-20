create table if not exists public.student_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  grade smallint check (grade in (4, 5)),
  grade_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.student_profiles enable row level security;

revoke all on public.student_profiles from anon;
grant select, insert, update on public.student_profiles to authenticated;

drop policy if exists "Students can read their own profile" on public.student_profiles;
create policy "Students can read their own profile"
  on public.student_profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Students can create their own profile" on public.student_profiles;
create policy "Students can create their own profile"
  on public.student_profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Students can update their own profile" on public.student_profiles;
create policy "Students can update their own profile"
  on public.student_profiles
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
