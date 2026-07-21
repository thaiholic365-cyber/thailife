-- ============================================
-- 타이라이프 데이터베이스 스키마
-- Supabase SQL Editor에 통째로 붙여넣고 RUN
-- ============================================

-- 1. 회원 프로필 (auth.users와 1:1 연결)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nick text unique not null,
  name text not null,
  phone text not null,
  level int not null default 1,
  blocked boolean not null default false,
  posts int not null default 0,
  chats int not null default 0,
  logins int not null default 0,
  last_seen timestamptz default now(),
  created_at timestamptz default now()
);

-- 2. 채팅
create table if not exists chats (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  nick text not null,
  text text not null,
  notice boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists chat_replies (
  id bigserial primary key,
  chat_id bigint references chats(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  nick text not null,
  text text not null,
  is_admin boolean not null default false,
  created_at timestamptz default now()
);

-- 3. 게시판 (정모/뉴스/맛집/제휴/갤러리 통합)
create table if not exists posts (
  id bigserial primary key,
  board text not null,              -- meet | news | food | partner | gallery
  user_id uuid references auth.users(id) on delete set null,
  author text not null,
  title text,
  body text,
  region text,
  cat text,
  kind text,
  date text,
  time text,
  place text,
  price text,
  link text,
  map text,
  img text,
  benefit text,
  soon boolean default false,
  joiners jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

-- 4. 알림
create table if not exists notifications (
  id bigserial primary key,
  target text not null,             -- 닉네임 | @all | @admin
  icon text,
  title text not null,
  body text,
  created_at timestamptz default now()
);

create table if not exists notif_reads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_read timestamptz default now()
);

-- 5. 쿠폰
create table if not exists coupons (
  id bigserial primary key,
  nick text not null,
  title text not null,
  partner text,
  descr text,
  code text,
  used boolean not null default false,
  created_at timestamptz default now()
);

-- 6. 사이트 설정 (금지어, 고객센터, 지도 관리)
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- 7. 관리자 지정
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);

-- ============================================
-- 인덱스
-- ============================================
create index if not exists idx_chats_created on chats(created_at desc);
create index if not exists idx_replies_chat on chat_replies(chat_id);
create index if not exists idx_posts_board on posts(board, created_at desc);
create index if not exists idx_notif_target on notifications(target, created_at desc);
create index if not exists idx_coupons_nick on coupons(nick, created_at desc);

-- ============================================
-- 관리자 판별 함수
-- ============================================
create or replace function is_admin()
returns boolean language sql security definer stable as $$
  select exists(select 1 from admins where user_id = auth.uid());
$$;

-- 차단 여부
create or replace function is_blocked()
returns boolean language sql security definer stable as $$
  select coalesce((select blocked from profiles where id = auth.uid()), false);
$$;

-- ============================================
-- RLS (Row Level Security) — 보안 핵심
-- ============================================
alter table profiles       enable row level security;
alter table chats          enable row level security;
alter table chat_replies   enable row level security;
alter table posts          enable row level security;
alter table notifications  enable row level security;
alter table notif_reads    enable row level security;
alter table coupons        enable row level security;
alter table settings       enable row level security;
alter table admins         enable row level security;

-- profiles: 공개 정보만 조회, 본인/관리자만 수정
drop policy if exists p_sel on profiles;
create policy p_sel on profiles for select using (true);
drop policy if exists p_ins on profiles;
create policy p_ins on profiles for insert with check (auth.uid() = id);
drop policy if exists p_upd on profiles;
create policy p_upd on profiles for update using (auth.uid() = id or is_admin());

-- chats: 모두 읽기, 로그인+미차단만 쓰기, 본인/관리자 삭제
drop policy if exists c_sel on chats;
create policy c_sel on chats for select using (true);
drop policy if exists c_ins on chats;
create policy c_ins on chats for insert with check (
  auth.uid() is not null and not is_blocked()
  and (notice = false or is_admin())
  and (is_admin = false or is_admin())
);
drop policy if exists c_del on chats;
create policy c_del on chats for delete using (auth.uid() = user_id or is_admin());

-- chat_replies
drop policy if exists cr_sel on chat_replies;
create policy cr_sel on chat_replies for select using (true);
drop policy if exists cr_ins on chat_replies;
create policy cr_ins on chat_replies for insert with check (auth.uid() is not null and not is_blocked());
drop policy if exists cr_del on chat_replies;
create policy cr_del on chat_replies for delete using (auth.uid() = user_id or is_admin());

-- posts: 뉴스는 관리자만 작성
drop policy if exists po_sel on posts;
create policy po_sel on posts for select using (true);
drop policy if exists po_ins on posts;
create policy po_ins on posts for insert with check (
  auth.uid() is not null and not is_blocked()
  and (board <> 'news' or is_admin())
);
drop policy if exists po_upd on posts;
create policy po_upd on posts for update using (auth.uid() = user_id or is_admin());
drop policy if exists po_del on posts;
create policy po_del on posts for delete using (auth.uid() = user_id or is_admin());

-- notifications: 본인 대상 + 전체공지만 조회, 관리자만 발송
drop policy if exists n_sel on notifications;
create policy n_sel on notifications for select using (
  target = '@all'
  or target = (select nick from profiles where id = auth.uid())
  or (target = '@admin' and is_admin())
);
drop policy if exists n_ins on notifications;
create policy n_ins on notifications for insert with check (auth.uid() is not null);
drop policy if exists n_del on notifications;
create policy n_del on notifications for delete using (is_admin());

-- notif_reads: 본인만
drop policy if exists nr_all on notif_reads;
create policy nr_all on notif_reads for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- coupons: 본인 쿠폰만 조회, 관리자만 발급
drop policy if exists cp_sel on coupons;
create policy cp_sel on coupons for select using (
  nick = (select nick from profiles where id = auth.uid()) or is_admin()
);
drop policy if exists cp_ins on coupons;
create policy cp_ins on coupons for insert with check (is_admin());
drop policy if exists cp_upd on coupons;
create policy cp_upd on coupons for update using (is_admin());

-- settings: 모두 읽기, 관리자만 수정
drop policy if exists s_sel on settings;
create policy s_sel on settings for select using (true);
drop policy if exists s_ins on settings;
create policy s_ins on settings for insert with check (is_admin());
drop policy if exists s_upd on settings;
create policy s_upd on settings for update using (is_admin());

-- admins: 관리자만 조회
drop policy if exists a_sel on admins;
create policy a_sel on admins for select using (is_admin());

-- ============================================
-- 실시간 활성화 (채팅용)
-- ============================================
alter publication supabase_realtime add table chats;
alter publication supabase_realtime add table chat_replies;
alter publication supabase_realtime add table notifications;

-- ============================================
-- 초기 설정값
-- ============================================
insert into settings(key, value) values
  ('banned', '[]'::jsonb),
  ('support', '{}'::jsonb),
  ('map_places', '[]'::jsonb),
  ('map_hidden', '[]'::jsonb),
  ('map_bookings', '{}'::jsonb)
on conflict (key) do nothing;

-- ============================================
-- 가입 시 프로필 자동 생성
-- ============================================
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles(id, nick, name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nick', split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'phone', '')
  );
  insert into public.notifications(target, icon, title, body)
  values (
    coalesce(new.raw_user_meta_data->>'nick',''),
    '🎉', '타이라이프 가입을 환영합니다!',
    '정모·번개에 참여하고 제휴업체 예약 시 쿠폰 혜택도 받아보세요. 🎟'
  );
  insert into public.notifications(target, icon, title, body)
  values ('@admin','👤','신규 회원 가입',
    coalesce(new.raw_user_meta_data->>'nick','') || ' 님이 가입했습니다.');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
