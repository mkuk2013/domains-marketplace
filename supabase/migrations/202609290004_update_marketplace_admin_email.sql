begin;

-- Keep the database-side admin check aligned with the Edge Function authorization.
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
      and lower(u.email) = 'weblitexagency@gmail.com'
      and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_marketplace_admin() from public, anon, authenticated;

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
  if v_email <> 'weblitexagency@gmail.com' or v_confirmed is null then raise exception 'ADMIN_REQUIRED'; end if;
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

commit;
