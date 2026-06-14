-- PIPSILY — Schéma initial Supabase

-- ① Profils utilisateurs
create table if not exists profiles (
  id                      uuid references auth.users primary key,
  email                   text,
  plan                    text default 'pending',
  subscription_expires_at timestamptz,
  devices_allowed         integer default 1,
  parental_pin            text,
  created_at              timestamptz default now()
);

-- ② Appareils
create table if not exists devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  device_id   text,
  device_name text,
  monthly_fee numeric default 0,
  last_seen   timestamptz default now(),
  created_at  timestamptz default now(),
  unique(user_id, device_id)
);

-- ③ Sessions (1 connexion simultanée)
create table if not exists sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete cascade,
  device_id  text,
  token      text,
  created_at timestamptz default now()
);

-- ④ Paiements (suivi manuel)
create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references profiles(id) on delete cascade,
  amount       numeric,
  type         text default 'subscription',
  period_start date,
  period_end   date,
  confirmed_at timestamptz,
  confirmed_by uuid,
  notes        text,
  created_at   timestamptz default now()
);

-- ⑤ Trigger auto-création profil
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, plan)
  values (new.id, new.email,
    case when new.email = 'cedric.lago@gmail.com' then 'admin' else 'pending' end);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ⑥ RLS
alter table profiles enable row level security;
alter table devices  enable row level security;
alter table sessions enable row level security;
alter table payments enable row level security;

drop policy if exists "own profile"          on profiles;
drop policy if exists "admin all profiles"   on profiles;
drop policy if exists "own devices"          on devices;
drop policy if exists "own sessions"         on sessions;
drop policy if exists "own payments"         on payments;
drop policy if exists "admin all devices"    on devices;
drop policy if exists "admin all payments"   on payments;
drop policy if exists "admin all sessions"   on sessions;

create policy "own profile"        on profiles for all using (auth.uid() = id);
create policy "admin all profiles" on profiles for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
create policy "own devices"        on devices  for all using (auth.uid() = user_id);
create policy "own sessions"       on sessions for all using (auth.uid() = user_id);
create policy "own payments"       on payments for all using (auth.uid() = user_id);
create policy "admin all devices"  on devices  for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
create policy "admin all payments" on payments for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
create policy "admin all sessions" on sessions for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
