-- =====================================================================
--  우리반 클래스룸 – Supabase 데이터베이스 설정
--  사용법: Supabase 대시보드 > SQL Editor > New query 에
--          이 파일 전체를 붙여넣고 [Run] 을 누르세요. (여러 번 실행해도 안전)
-- =====================================================================

-- ---------- 1. 테이블 ----------

-- 반 (학생은 가입할 때 반 코드를 입력)
create table if not exists public.classes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  join_code   text not null unique,
  created_at  timestamptz not null default now()
);

-- 사용자 프로필 (회원가입하면 자동 생성)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text not null default '',
  phone       text,
  role        text not null default 'student' check (role in ('student','teacher')),
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  class_id    uuid references public.classes(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- 선생님만 보는 학생 메모
create table if not exists public.student_notes (
  student_id  uuid primary key references public.profiles(id) on delete cascade,
  memo        text not null default '',
  updated_at  timestamptz not null default now()
);

-- 수업 영상 (class_id 가 비어 있으면 모든 반에 공개)
create table if not exists public.videos (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  class_id    uuid references public.classes(id) on delete cascade,
  source      text not null check (source in ('youtube','file')),
  youtube_id  text,
  file_path   text,
  no_skip     boolean not null default false,   -- 앞으로 건너뛰기 방지
  published   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- 영상 시청 기록 (학생 x 영상 1줄)
create table if not exists public.video_progress (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  video_id            uuid not null references public.videos(id) on delete cascade,
  watched             int[] not null default '{}',  -- 실제로 본 5초 구간 번호들
  max_position        int not null default 0,
  percent             int not null default 0,
  completed           boolean not null default false,
  total_watch_seconds int not null default 0,
  duration_seconds    int,
  last_watched_at     timestamptz not null default now(),
  unique (user_id, video_id)
);

-- 숙제
create table if not exists public.assignments (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  class_id    uuid references public.classes(id) on delete cascade,
  due_at      timestamptz,
  file_path   text,
  file_name   text,
  video_id    uuid references public.videos(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- 숙제 제출 (학생 x 숙제 1줄, 다시 제출하면 덮어씀)
create table if not exists public.submissions (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  content       text,
  file_path     text,
  file_name     text,
  submitted_at  timestamptz not null default now(),
  score         numeric,
  feedback      text,
  graded_at     timestamptz,
  unique (assignment_id, user_id)
);
alter table public.submissions add column if not exists files jsonb not null default '[]'::jsonb;  -- 여러 장 사진/파일
alter table public.submissions add column if not exists files_cleared_at timestamptz;              -- 사진 정리한 시각

create index if not exists idx_profiles_class   on public.profiles(class_id);
create index if not exists idx_progress_video   on public.video_progress(video_id);
create index if not exists idx_sub_assignment   on public.submissions(assignment_id);

-- ---------- 2. 도우미 함수 ----------

create or replace function public.is_teacher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role = 'teacher' and status = 'approved');
$$;

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and status = 'approved');
$$;

create or replace function public.my_class_id() returns uuid
language sql stable security definer set search_path = public as $$
  select class_id from public.profiles where id = auth.uid();
$$;

-- 선생님 대시보드: 저장 공간 사용량
create or replace function public.storage_usage() returns table(bucket text, bytes bigint, files bigint)
language sql stable security definer set search_path = public, storage as $$
  select o.bucket_id::text, coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint, count(*)::bigint
  from storage.objects o
  where public.is_teacher() and o.bucket_id in ('videos','materials','submissions')
  group by o.bucket_id;
$$;

-- 가입 화면에서 반 코드가 맞는지 확인 (반 이름만 돌려줌)
create or replace function public.check_class_code(code text) returns text
language sql stable security definer set search_path = public as $$
  select name from public.classes where upper(join_code) = upper(trim(code)) limit 1;
$$;

-- 회원가입 시 프로필 자동 생성 (항상 '학생 / 승인 대기' 로 시작)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_class uuid;
begin
  select id into v_class from public.classes
   where upper(join_code) = upper(trim(coalesce(new.raw_user_meta_data->>'class_code', '')));
  insert into public.profiles (id, email, full_name, phone, class_id)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', ''),
          nullif(new.raw_user_meta_data->>'phone', ''),
          v_class)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 3. 권한 ----------

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on function public.check_class_code(text) to anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_teacher(), public.is_approved(), public.my_class_id() from public, anon;
grant execute on function public.is_teacher(), public.is_approved(), public.my_class_id() to authenticated;
revoke execute on function public.storage_usage() from public, anon;
grant execute on function public.storage_usage() to authenticated;

-- ---------- 4. 보안 규칙 (RLS) ----------
-- 학생은 자기 기록만, 선생님은 전부 볼 수 있게 합니다.

alter table public.classes        enable row level security;
alter table public.profiles       enable row level security;
alter table public.student_notes  enable row level security;
alter table public.videos         enable row level security;
alter table public.video_progress enable row level security;
alter table public.assignments    enable row level security;
alter table public.submissions    enable row level security;

-- 반
drop policy if exists classes_select      on public.classes;
drop policy if exists classes_teacher_all on public.classes;
create policy classes_select on public.classes for select to authenticated
  using (public.is_teacher() or id = public.my_class_id());
create policy classes_teacher_all on public.classes for all to authenticated
  using (public.is_teacher()) with check (public.is_teacher());

-- 프로필
drop policy if exists profiles_select         on public.profiles;
drop policy if exists profiles_teacher_update on public.profiles;
drop policy if exists profiles_teacher_delete on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_teacher());
create policy profiles_teacher_update on public.profiles for update to authenticated
  using (public.is_teacher()) with check (public.is_teacher());
create policy profiles_teacher_delete on public.profiles for delete to authenticated
  using (public.is_teacher());

-- 메모
drop policy if exists notes_teacher_all on public.student_notes;
create policy notes_teacher_all on public.student_notes for all to authenticated
  using (public.is_teacher()) with check (public.is_teacher());

-- 영상
drop policy if exists videos_select      on public.videos;
drop policy if exists videos_teacher_all on public.videos;
create policy videos_select on public.videos for select to authenticated
  using (public.is_teacher()
         or (public.is_approved() and published
             and (class_id is null or class_id = public.my_class_id())));
create policy videos_teacher_all on public.videos for all to authenticated
  using (public.is_teacher()) with check (public.is_teacher());

-- 시청 기록
drop policy if exists progress_select         on public.video_progress;
drop policy if exists progress_insert_own     on public.video_progress;
drop policy if exists progress_update_own     on public.video_progress;
drop policy if exists progress_teacher_delete on public.video_progress;
create policy progress_select on public.video_progress for select to authenticated
  using (user_id = auth.uid() or public.is_teacher());
create policy progress_insert_own on public.video_progress for insert to authenticated
  with check (user_id = auth.uid() and public.is_approved()
              and exists (select 1 from public.videos v where v.id = video_id));
create policy progress_update_own on public.video_progress for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_approved());
create policy progress_teacher_delete on public.video_progress for delete to authenticated
  using (public.is_teacher());

-- 숙제
drop policy if exists assignments_select      on public.assignments;
drop policy if exists assignments_teacher_all on public.assignments;
create policy assignments_select on public.assignments for select to authenticated
  using (public.is_teacher()
         or (public.is_approved()
             and (class_id is null or class_id = public.my_class_id())));
create policy assignments_teacher_all on public.assignments for all to authenticated
  using (public.is_teacher()) with check (public.is_teacher());

-- 제출 (학생은 점수/피드백을 직접 넣을 수 없고, 채점된 뒤에는 수정 불가)
drop policy if exists subs_select         on public.submissions;
drop policy if exists subs_insert_own     on public.submissions;
drop policy if exists subs_update_own     on public.submissions;
drop policy if exists subs_teacher_update on public.submissions;
drop policy if exists subs_teacher_delete on public.submissions;
create policy subs_select on public.submissions for select to authenticated
  using (user_id = auth.uid() or public.is_teacher());
create policy subs_insert_own on public.submissions for insert to authenticated
  with check (user_id = auth.uid() and public.is_approved()
              and score is null and feedback is null and graded_at is null
              and exists (select 1 from public.assignments a where a.id = assignment_id));
create policy subs_update_own on public.submissions for update to authenticated
  using (user_id = auth.uid() and graded_at is null)
  with check (user_id = auth.uid() and public.is_approved()
              and score is null and feedback is null and graded_at is null);
create policy subs_teacher_update on public.submissions for update to authenticated
  using (public.is_teacher()) with check (public.is_teacher());
create policy subs_teacher_delete on public.submissions for delete to authenticated
  using (public.is_teacher());

-- ---------- 5. 파일 저장소 ----------
-- videos: 수업 영상 파일 / materials: 숙제 첨부자료 / submissions: 학생 제출 파일

insert into storage.buckets (id, name, public) values
  ('videos', 'videos', false),
  ('materials', 'materials', false),
  ('submissions', 'submissions', false)
on conflict (id) do nothing;

drop policy if exists cls_teacher_all       on storage.objects;
drop policy if exists cls_student_read      on storage.objects;
drop policy if exists cls_student_sub_read  on storage.objects;
drop policy if exists cls_student_sub_write on storage.objects;
drop policy if exists cls_student_sub_delete on storage.objects;
create policy cls_teacher_all on storage.objects for all to authenticated
  using (bucket_id in ('videos','materials','submissions') and public.is_teacher())
  with check (bucket_id in ('videos','materials','submissions') and public.is_teacher());
create policy cls_student_read on storage.objects for select to authenticated
  using (bucket_id in ('videos','materials') and public.is_approved());
create policy cls_student_sub_read on storage.objects for select to authenticated
  using (bucket_id = 'submissions' and (storage.foldername(name))[1] = auth.uid()::text);
create policy cls_student_sub_write on storage.objects for insert to authenticated
  with check (bucket_id = 'submissions' and public.is_approved()
              and (storage.foldername(name))[1] = auth.uid()::text);
create policy cls_student_sub_delete on storage.objects for delete to authenticated
  using (bucket_id = 'submissions' and (storage.foldername(name))[1] = auth.uid()::text);


-- ---------- 6. 어휘 테스트 (매주 PDF + 학생이 틀린 개수 입력) ----------
create table if not exists public.vocab_tests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  class_id uuid references public.classes(id) on delete cascade,
  pdf_path text, pdf_name text,
  total int not null check (total between 1 and 500),
  open_at timestamptz not null default now(),
  due_at timestamptz,
  video_id uuid references public.videos(id) on delete set null,
  require_photo boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.vocab_results (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.vocab_tests(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  wrong int not null check (wrong >= 0),
  files jsonb not null default '[]'::jsonb,
  memo text,
  submitted_at timestamptz not null default now(),
  unique (test_id, user_id)
);
create index if not exists idx_vocab_results_test on public.vocab_results(test_id);
grant select, insert, update, delete on public.vocab_tests, public.vocab_results to authenticated;
alter table public.vocab_tests enable row level security;
alter table public.vocab_results enable row level security;
drop policy if exists vocab_tests_select on public.vocab_tests;
drop policy if exists vocab_tests_teacher_all on public.vocab_tests;
drop policy if exists vocab_results_select on public.vocab_results;
drop policy if exists vocab_results_insert_own on public.vocab_results;
drop policy if exists vocab_results_update_own on public.vocab_results;
drop policy if exists vocab_results_teacher_all on public.vocab_results;
create policy vocab_tests_select on public.vocab_tests for select to authenticated
  using (public.is_teacher() or (public.is_approved() and open_at <= now()
         and (class_id is null or class_id = public.my_class_id())));
create policy vocab_tests_teacher_all on public.vocab_tests for all to authenticated
  using (public.is_teacher()) with check (public.is_teacher());
create policy vocab_results_select on public.vocab_results for select to authenticated
  using (user_id = auth.uid() or public.is_teacher());
create policy vocab_results_insert_own on public.vocab_results for insert to authenticated
  with check (user_id = auth.uid() and public.is_approved()
              and exists (select 1 from public.vocab_tests t where t.id = test_id and wrong <= t.total));
create policy vocab_results_update_own on public.vocab_results for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_approved()
              and exists (select 1 from public.vocab_tests t where t.id = test_id and wrong <= t.total));
create policy vocab_results_teacher_all on public.vocab_results for all to authenticated
  using (public.is_teacher()) with check (public.is_teacher());

-- =====================================================================
--  ★ 첫 선생님 계정 만들기
--  1) 사이트에서 선생님 본인 이메일로 회원가입 (반 코드는 비워두기)
--  2) 아래 줄의 이메일을 바꾼 뒤, 앞의 "-- " 를 지우고 이 줄만 실행
-- update public.profiles set role = 'teacher', status = 'approved' where email = 'teacher@example.com';
-- =====================================================================

-- =====================================================================
--  추가 기능 (학부모 계정 · 성적표 · 무료 푸시 알림)
--  ※ 실제 프로젝트에는 이미 적용돼 있어요. 새 프로젝트를 만들 때 참고용입니다.
--  자세한 정의는 Supabase 대시보드 > Database > Migrations 에서
--  parents_reports_push, student_report_fn, enable_cron_net, fix_search_path 를 보세요.
--  - profiles.role 에 'parent' 추가, 학생마다 link_code (자녀 연결 코드)
--  - parent_links: 학부모 ↔ 자녀 연결
--  - 학부모는 my_children() 로 연결된 자녀 기록만 '읽기' 가능 (RLS)
--  - student_report(학생id): 반 평균·석차가 담긴 성적표 (본인/학부모/선생님만)
--  - push_subscriptions, push_log, app_secrets: 푸시 알림 (Edge Function 'push')
--  - pg_cron 'push-daily-reminders': 매일 18:00(한국시간) 자동 알림
-- =====================================================================
-- 추가 (테스트 통합 · 바꿔치기 방지 · 조교)
--  - vocab_tests = 모든 테스트: category(종류), grading('self' 학생 입력 | 'staff' 선생님 입력), use_grade, lock_after_due
--  - vocab_results: score/grade/percentile(선생님 입력), history/edit_count/first_submitted_at/edited_after_due (수정 기록)
--  - submissions: history/edit_count/first_submitted_at/edited_after_due, assignments.lock_after_due
--  - 트리거 track_submission / track_vocab: 학생이 고치면 이전 내용을 history 에 자동 보관
--  - role 'assistant'(조교): is_teacher() 는 선생님+조교, is_head_teacher() 는 원장만 (권한 변경·반 삭제)
--  - Supabase 마이그레이션: staff_history_mock, unified_tests_columns, unified_tests_policies, student_report_categories
