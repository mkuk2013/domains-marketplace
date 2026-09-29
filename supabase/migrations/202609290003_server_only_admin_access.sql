begin;

-- Admin operations are authorized in the Edge Function using the confirmed owner email.
-- The browser never needs direct admin table access; service_role bypasses RLS there.
revoke all on function public.is_marketplace_admin() from public, anon, authenticated;
revoke all on public.promo_codes, public.request_reviews from anon, authenticated;

drop policy if exists profiles_read_self_or_admin on public.profiles;
drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists requests_read_self_or_admin on public.subdomain_requests;
drop policy if exists requests_read_self on public.subdomain_requests;
create policy requests_read_self on public.subdomain_requests
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists dns_read_owner_or_admin on public.dns_records;
drop policy if exists dns_read_owner on public.dns_records;
create policy dns_read_owner on public.dns_records
  for select to authenticated using (
    user_id = (select auth.uid()) and exists (
      select 1 from public.subdomain_requests r where r.id = request_id and r.status = 'approved'
    )
  );

drop policy if exists reviews_read_admin on public.request_reviews;
drop policy if exists request_reviews_deny_direct_access on public.request_reviews;
create policy request_reviews_deny_direct_access on public.request_reviews
  for all to authenticated using (false) with check (false);

drop policy if exists promo_codes_deny_direct_access on public.promo_codes;
create policy promo_codes_deny_direct_access on public.promo_codes
  for all to authenticated using (false) with check (false);

commit;
