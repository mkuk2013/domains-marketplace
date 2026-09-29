begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function public.sync_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_profile_sync
  after insert or update of email on auth.users
  for each row execute function public.sync_profile_from_auth();

create table public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  max_uses integer not null check (max_uses between 1 and 10000),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  active boolean not null default true,
  expires_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.subdomain_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (label = lower(label) and length(label) between 1 and 63 and label ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment','payment_submitted','review_pending','approved','denied','cancelled')),
  payment_status text not null default 'not_submitted' check (payment_status in ('not_submitted','submitted','verified','rejected','waived')),
  price_pkr integer not null default 300 check (price_pkr in (0,300)),
  promo_code_id uuid references public.promo_codes(id),
  payment_reference text check (payment_reference is null or length(payment_reference) between 3 and 120),
  payment_submitted_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 500),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  approved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index subdomain_requests_active_label_uq
  on public.subdomain_requests (label)
  where status not in ('denied','cancelled');
create index subdomain_requests_user_created_idx
  on public.subdomain_requests (user_id, created_at desc);
create index subdomain_requests_status_created_idx
  on public.subdomain_requests (status, created_at desc);

create table public.dns_records (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.subdomain_requests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (record_type in ('A','AAAA','CNAME','TXT','MX')),
  host text not null check (length(host) between 1 and 190),
  value text not null check (length(value) between 1 and 2000),
  ttl integer not null default 3600 check (ttl between 60 and 86400),
  priority integer check (priority is null or priority between 0 and 65535),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dns_records_mx_priority_chk check ((record_type = 'MX' and priority is not null) or (record_type <> 'MX' and priority is null))
);
create index dns_records_request_idx on public.dns_records (request_id, created_at);

create table public.request_reviews (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.subdomain_requests(id) on delete cascade,
  admin_id uuid not null references auth.users(id),
  decision text not null check (decision in ('approved','denied')),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now()
);
create index request_reviews_request_idx on public.request_reviews (request_id, created_at desc);

create or replace function public.is_marketplace_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and lower(u.email) = 'mkuk2013@gmail.com'
      and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_marketplace_admin() from public, anon;
grant execute on function public.is_marketplace_admin() to authenticated;

create or replace function public.check_subdomain_availability(p_label text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text := lower(btrim(coalesce(p_label, '')));
  v_reserved text[] := array['admin','api','autoconfig','autodiscover','cpanel','domains','ftp','imap','mail','ns1','ns2','root','smtp','webmail','www'];
  v_available boolean;
begin
  if length(v_label) < 1 or length(v_label) > 63 or v_label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' or v_label = any(v_reserved) then
    return jsonb_build_object('available', false, 'reason', 'invalid_or_reserved');
  end if;
  select not exists (
    select 1 from public.subdomain_requests r
    where r.label = v_label and r.status not in ('denied','cancelled')
  ) into v_available;
  return jsonb_build_object('available', v_available, 'label', v_label);
end;
$$;
revoke all on function public.check_subdomain_availability(text) from public;
grant execute on function public.check_subdomain_availability(text) to anon, authenticated, service_role;

create or replace function public.create_marketplace_request(
  p_user_id uuid,
  p_label text,
  p_code_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text := lower(btrim(coalesce(p_label, '')));
  v_reserved text[] := array['admin','api','autoconfig','autodiscover','cpanel','domains','ftp','imap','mail','ns1','ns2','root','smtp','webmail','www'];
  v_promo_id uuid;
  v_price integer := 300;
  v_status text := 'awaiting_payment';
  v_payment text := 'not_submitted';
  v_id uuid;
begin
  if p_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if length(v_label) < 1 or length(v_label) > 63 or v_label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' or v_label = any(v_reserved) then
    raise exception 'INVALID_LABEL';
  end if;

  if exists (select 1 from public.subdomain_requests r where r.label = v_label and r.status not in ('denied','cancelled')) then
    raise exception 'LABEL_TAKEN';
  end if;

  if p_code_hash is not null then
    select p.id into v_promo_id
      from public.promo_codes p
      where p.code_hash = p_code_hash
        and p.active
        and p.uses < p.max_uses
        and (p.expires_at is null or p.expires_at > now())
      for update;
    if v_promo_id is null then raise exception 'INVALID_OR_EXPIRED_PROMO'; end if;
    update public.promo_codes set uses = uses + 1 where id = v_promo_id;
    v_price := 0;
    v_status := 'review_pending';
    v_payment := 'waived';
  end if;

  insert into public.subdomain_requests (user_id, label, status, payment_status, price_pkr, promo_code_id)
  values (p_user_id, v_label, v_status, v_payment, v_price, v_promo_id)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'label', v_label, 'status', v_status, 'price_pkr', v_price, 'payment_status', v_payment);
exception
  when unique_violation then raise exception 'LABEL_TAKEN';
end;
$$;
revoke all on function public.create_marketplace_request(uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_marketplace_request(uuid,text,text) to service_role;

create or replace function public.admin_review_request(
  p_admin_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email text;
  v_confirmed timestamptz;
  v_request public.subdomain_requests%rowtype;
  v_new_status text;
  v_new_payment text;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  select lower(email), email_confirmed_at into v_email, v_confirmed
    from auth.users where id = p_admin_id;
  if v_email <> 'mkuk2013@gmail.com' or v_confirmed is null then raise exception 'ADMIN_REQUIRED'; end if;
  if p_decision not in ('approve','deny') then raise exception 'INVALID_DECISION'; end if;

  select * into v_request from public.subdomain_requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_request.status in ('approved','denied','cancelled') then raise exception 'REQUEST_ALREADY_REVIEWED'; end if;

  if p_decision = 'approve' then
    if not ((v_request.status = 'payment_submitted' and v_request.payment_status = 'submitted' and v_request.payment_reference is not null)
         or (v_request.status = 'review_pending' and v_request.payment_status = 'waived' and v_request.price_pkr = 0)) then
      raise exception 'PAYMENT_NOT_SUBMITTED_OR_PROMO_NOT_VALID';
    end if;
    v_new_status := 'approved';
    v_new_payment := case when v_request.payment_status = 'waived' then 'waived' else 'verified' end;
  else
    v_new_status := 'denied';
    v_new_payment := case when v_request.payment_status = 'submitted' then 'rejected' else v_request.payment_status end;
    if v_request.payment_status = 'waived' and v_request.promo_code_id is not null then
      update public.promo_codes set uses = greatest(0, uses - 1) where id = v_request.promo_code_id;
    end if;
  end if;

  update public.subdomain_requests
    set status = v_new_status,
        payment_status = v_new_payment,
        reviewed_by = p_admin_id,
        reviewed_at = now(),
        approved_at = case when v_new_status = 'approved' then now() else null end,
        expires_at = case when v_new_status = 'approved' then now() + interval '365 days' else null end,
        review_note = v_note,
        updated_at = now()
    where id = p_request_id;

  insert into public.request_reviews (request_id, admin_id, decision, note)
  values (p_request_id, p_admin_id, case when p_decision = 'approve' then 'approved' else 'denied' end, v_note);

  return jsonb_build_object('id', p_request_id, 'status', v_new_status, 'payment_status', v_new_payment);
end;
$$;
revoke all on function public.admin_review_request(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.admin_review_request(uuid,uuid,text,text) to service_role;

alter table public.profiles enable row level security;
alter table public.promo_codes enable row level security;
alter table public.subdomain_requests enable row level security;
alter table public.dns_records enable row level security;
alter table public.request_reviews enable row level security;

create policy profiles_read_self_or_admin on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_marketplace_admin());
create policy requests_read_self_or_admin on public.subdomain_requests
  for select to authenticated using (user_id = auth.uid() or public.is_marketplace_admin());
create policy dns_read_owner_or_admin on public.dns_records
  for select to authenticated using (
    user_id = auth.uid() and exists (
      select 1 from public.subdomain_requests r where r.id = request_id and r.status = 'approved'
    )
    or public.is_marketplace_admin()
  );
create policy reviews_read_admin on public.request_reviews
  for select to authenticated using (public.is_marketplace_admin());

revoke all on public.profiles, public.promo_codes, public.subdomain_requests, public.dns_records, public.request_reviews from anon, authenticated;
grant select on public.profiles, public.subdomain_requests, public.dns_records, public.request_reviews to authenticated;

commit;
