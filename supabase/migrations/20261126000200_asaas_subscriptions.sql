-- Monthly plan (mensalidade) billed by the Menzu Asaas account. Applied 2026-11-26.
-- The existing plan/feature model is kept: a new plan only takes effect after its first confirmed payment
-- (pending_* columns), and the usual grace period / suspension rules apply afterwards.

alter table public.restaurant_subscriptions drop constraint restaurant_subscriptions_provider_check;
alter table public.restaurant_subscriptions add constraint restaurant_subscriptions_provider_check
  check (provider = any (array['mercadopago'::text, 'manual'::text, 'development'::text, 'asaas'::text]));
alter table public.subscription_payments drop constraint subscription_payments_provider_check;
alter table public.subscription_payments add constraint subscription_payments_provider_check
  check (provider = any (array['mercadopago'::text, 'manual'::text, 'development'::text, 'asaas'::text]));

-- Records the Asaas subscription created for a plan. Features do not change yet.
create or replace function public.begin_asaas_subscription(
  p_restaurant_id uuid, p_plan_id uuid, p_provider_subscription_id text
) returns void
language plpgsql security definer set search_path to ''
as $$
declare
  v_plan public.plans%rowtype;
  v_sub public.restaurant_subscriptions%rowtype;
  v_id text := nullif(left(btrim(coalesce(p_provider_subscription_id, '')), 200), '');
begin
  select * into v_plan from public.plans where id = p_plan_id and is_active and is_public;
  if not found or v_id is null then
    perform public.menzu_raise('INVALID_INPUT', 'Plano ou assinatura inválidos.');
  end if;
  select * into v_sub from public.restaurant_subscriptions where restaurant_id = p_restaurant_id for update;
  if not found then
    insert into public.restaurant_subscriptions (restaurant_id, plan_id, status, billing_cycle, provider, price_cents, trial_ends_at)
    values (p_restaurant_id, v_plan.id, 'trialing', 'monthly', 'manual', v_plan.price_monthly_cents, now())
    returning * into v_sub;
  end if;
  update public.restaurant_subscriptions
  set pending_plan_id = v_plan.id, pending_billing_cycle = 'monthly',
      pending_price_cents = v_plan.price_monthly_cents, pending_provider_subscription_id = v_id, updated_at = now()
  where id = v_sub.id;
  insert into public.subscription_events (restaurant_id, subscription_id, event, to_plan_id, data)
  values (p_restaurant_id, v_sub.id, 'subscription_created', v_plan.id,
    jsonb_build_object('provider', 'asaas', 'provider_subscription_id', v_id, 'price_cents', v_plan.price_monthly_cents));
end;
$$;

-- Applies one subscription payment state confirmed with Asaas. Idempotent per event id; a payment only
-- extends the period once, when it first becomes approved.
create or replace function public.apply_asaas_subscription_payment(
  p_provider_subscription_id text, p_provider_payment_id text, p_status text,
  p_amount_cents integer, p_event_id text, p_raw jsonb
) returns text
language plpgsql security definer set search_path to ''
as $$
declare
  s public.restaurant_subscriptions%rowtype;
  v_prev text;
  v_pending boolean;
begin
  if p_status not in ('pending', 'approved', 'rejected', 'refunded', 'cancelled')
     or p_amount_cents is null or p_amount_cents < 0 then
    perform public.menzu_raise('INVALID_INPUT', 'Pagamento de assinatura inválido.');
  end if;
  select * into s from public.restaurant_subscriptions
  where provider_subscription_id = p_provider_subscription_id or pending_provider_subscription_id = p_provider_subscription_id
  for update;
  if not found then
    return 'unknown_subscription';
  end if;

  insert into public.billing_events (provider, event_id, restaurant_id, subscription_id, payload, result, processed_at)
  values ('asaas', left(p_event_id, 200), s.restaurant_id, s.id, coalesce(p_raw, '{}'::jsonb), p_status, now())
  on conflict (provider, event_id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  select status into v_prev from public.subscription_payments where provider = 'asaas' and provider_payment_id = p_provider_payment_id;
  insert into public.subscription_payments (subscription_id, restaurant_id, provider, provider_payment_id, amount_cents, status, paid_at, raw)
  values (s.id, s.restaurant_id, 'asaas', p_provider_payment_id, p_amount_cents, p_status,
          case when p_status = 'approved' then now() end, coalesce(p_raw, '{}'::jsonb))
  on conflict (provider, provider_payment_id) do update
  set status = excluded.status, amount_cents = excluded.amount_cents, raw = excluded.raw,
      paid_at = coalesce(public.subscription_payments.paid_at, excluded.paid_at), updated_at = now();

  v_pending := s.pending_provider_subscription_id = p_provider_subscription_id;
  if p_status = 'approved' and v_prev is distinct from 'approved' then
    update public.restaurant_subscriptions
    set plan_id = case when v_pending then pending_plan_id else plan_id end,
        price_cents = case when v_pending then pending_price_cents else price_cents end,
        billing_cycle = case when v_pending then coalesce(pending_billing_cycle, 'monthly') else billing_cycle end,
        provider = 'asaas',
        provider_subscription_id = p_provider_subscription_id,
        pending_plan_id = case when v_pending then null else pending_plan_id end,
        pending_billing_cycle = case when v_pending then null else pending_billing_cycle end,
        pending_price_cents = case when v_pending then null else pending_price_cents end,
        pending_provider_subscription_id = case when v_pending then null else pending_provider_subscription_id end,
        status = 'active',
        current_period_start = now(),
        current_period_end = greatest(coalesce(current_period_end, now()), now()) + interval '1 month',
        past_due_since = null, grace_ends_at = null, suspended_at = null, updated_at = now()
    where id = s.id;
    insert into public.subscription_events (restaurant_id, subscription_id, event, to_plan_id, data)
    values (s.restaurant_id, s.id, case when v_pending then 'subscription_upgraded' else 'subscription_renewed' end,
      case when v_pending then s.pending_plan_id else s.plan_id end,
      jsonb_build_object('provider_payment_id', p_provider_payment_id, 'amount_cents', p_amount_cents));
  elsif p_status = 'rejected' and not v_pending and s.status = 'active' then
    update public.restaurant_subscriptions
    set status = 'past_due', past_due_since = coalesce(past_due_since, now()), updated_at = now()
    where id = s.id;
    insert into public.subscription_events (restaurant_id, subscription_id, event, data)
    values (s.restaurant_id, s.id, 'subscription_past_due', jsonb_build_object('provider_payment_id', p_provider_payment_id));
  end if;
  return p_status;
end;
$$;

revoke all on function public.begin_asaas_subscription(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.apply_asaas_subscription_payment(text, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.begin_asaas_subscription(uuid, uuid, text) to service_role;
grant execute on function public.apply_asaas_subscription_payment(text, text, text, integer, text, jsonb) to service_role;
