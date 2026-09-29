begin;

-- Public name checks are served through the Edge Function using service_role.
-- Keep the underlying SECURITY DEFINER RPC out of direct REST access.
revoke all on function public.check_subdomain_availability(text) from public, anon, authenticated;
grant execute on function public.check_subdomain_availability(text) to service_role;

-- This is an auth.users trigger function, not a user-callable RPC.
revoke all on function public.sync_profile_from_auth() from public, anon, authenticated;

-- Cover the foreign keys flagged by the post-migration advisor.
create index if not exists dns_records_user_id_idx on public.dns_records (user_id);
create index if not exists promo_codes_created_by_idx on public.promo_codes (created_by);
create index if not exists request_reviews_admin_id_idx on public.request_reviews (admin_id);
create index if not exists subdomain_requests_promo_code_id_idx on public.subdomain_requests (promo_code_id);
create index if not exists subdomain_requests_reviewed_by_idx on public.subdomain_requests (reviewed_by);

-- Evaluate JWT helpers once per statement rather than once per row.
drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select public.is_marketplace_admin()));

drop policy if exists requests_read_self_or_admin on public.subdomain_requests;
create policy requests_read_self_or_admin on public.subdomain_requests
  for select to authenticated using (user_id = (select auth.uid()) or (select public.is_marketplace_admin()));

drop policy if exists dns_read_owner_or_admin on public.dns_records;
create policy dns_read_owner_or_admin on public.dns_records
  for select to authenticated using (
    (user_id = (select auth.uid()) and exists (
      select 1 from public.subdomain_requests r where r.id = request_id and r.status = 'approved'
    ))
    or (select public.is_marketplace_admin())
  );

drop policy if exists reviews_read_admin on public.request_reviews;
create policy reviews_read_admin on public.request_reviews
  for select to authenticated using ((select public.is_marketplace_admin()));

commit;
