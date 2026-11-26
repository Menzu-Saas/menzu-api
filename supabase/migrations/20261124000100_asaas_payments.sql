-- Asaas online payments (PIX and hosted card page). Applied to the project on 2026-11-24.
-- Adds new service-role-only functions and extends one availability check. Existing Mercado Pago and
-- development functions are left untouched.

-- 1) Registers the Asaas charge (PIX or hosted card page) on a pending payment. Fee is the fixed online payment fee (bps),
--    estimated on the gross amount here and corrected from the net amount when the payment settles.
create or replace function public.set_asaas_payment_data(
  p_payment_id uuid, p_token text, p_provider_payment_id text, p_status public.payment_status,
  p_pix_qr_code text, p_pix_qr_base64 text, p_checkout_url text, p_raw jsonb, p_fee_bps integer
) returns void
language plpgsql security definer set search_path to ''
as $$
declare
  p public.payments%rowtype;
  v_token text;
  v_pid text := nullif(left(btrim(coalesce(p_provider_payment_id, '')), 200), '');
  v_url text := nullif(btrim(coalesce(p_checkout_url, '')), '');
  v_host text;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if found then select public_token into v_token from public.orders where id = p.order_id; end if;
  if not found or p_token is null or v_token is distinct from p_token then
    perform public.menzu_raise('PAYMENT_NOT_FOUND', 'Pagamento não encontrado.');
  end if;
  if p.provider <> 'pending' or p.status <> 'PENDING' or p.method not in ('PIX', 'CARD_ONLINE')
     or p_status not in ('PENDING', 'PROCESSING') or v_pid is null
     or p_fee_bps is null or p_fee_bps < 0 or p_fee_bps > 10000 then
    perform public.menzu_raise('PAYMENT_NOT_ALLOWED', 'Operação de pagamento não permitida.');
  end if;
  -- A link (Asaas hosted card page) is only valid for cards; a card charged inside Menzu has none.
  -- PIX never carries a link.
  if v_url is not null and p.method <> 'CARD_ONLINE' then
    perform public.menzu_raise('PAYMENT_NOT_ALLOWED', 'Operação de pagamento não permitida.');
  end if;
  if v_url is not null then
    v_host := lower(substring(v_url from '^[Hh][Tt][Tt][Pp][Ss]://([A-Za-z0-9.-]+)(?::[0-9]{1,5})?(?:[/?#]|$)'));
    if v_host is null or not (v_host in ('asaas.com', 'www.asaas.com', 'sandbox.asaas.com') or v_host like '%.asaas.com')
       or v_url ~ '^[Hh][Tt][Tt][Pp][Ss]://[^/?#]*@' then
      perform public.menzu_raise('PAYMENT_NOT_ALLOWED', 'Endereço de pagamento não permitido.');
    end if;
  end if;
  update public.payments
  set provider = 'asaas',
      provider_payment_id = v_pid,
      status = p_status,
      pix_qr_code = left(p_pix_qr_code, 4000),
      pix_qr_base64 = left(p_pix_qr_base64, 200000),
      checkout_url = left(v_url, 2000),
      raw = coalesce(p_raw, '{}'::jsonb),
      gross_amount_cents = amount_cents,
      commission_bps = p_fee_bps,
      fee_collection = 'split',
      platform_fee_cents = (amount_cents::bigint * p_fee_bps / 10000)::integer
  where id = p.id;
end;
$$;

-- 2) Applies a confirmed Asaas state. Idempotent per event id; a settled payment never regresses.
create or replace function public.apply_asaas_payment_update(
  p_payment_id uuid, p_event_id text, p_status public.payment_status, p_provider_payment_id text,
  p_raw jsonb, p_gateway_fee_cents integer default null, p_platform_fee_cents integer default null
) returns boolean
language plpgsql security definer set search_path to ''
as $$
declare
  p public.payments%rowtype;
  v_event_id uuid;
  v_apply boolean;
  v_gateway integer;
  v_platform integer;
  v_net integer;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if not found or p.provider <> 'asaas' then
    perform public.menzu_raise('PAYMENT_NOT_FOUND', 'Pagamento não encontrado.');
  end if;
  if (p_gateway_fee_cents is not null and p_gateway_fee_cents < 0)
     or (p_platform_fee_cents is not null and (p_platform_fee_cents < 0 or p_platform_fee_cents > coalesce(p.gross_amount_cents, p.amount_cents))) then
    perform public.menzu_raise('PAYMENT_NOT_ALLOWED', 'Tarifa inválida.');
  end if;

  insert into public.payment_events (restaurant_id, provider, event_id, payment_id, payload, processed_at)
  values (p.restaurant_id, 'asaas', p_event_id, p.id, coalesce(p_raw, '{}'::jsonb), now())
  on conflict (provider, event_id) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return false; -- duplicate delivery
  end if;

  v_apply := case
    when p_status in ('PAID', 'REFUNDED') then true
    when p.status in ('PENDING', 'PROCESSING') then true
    else false
  end;

  v_gateway := coalesce(p_gateway_fee_cents, p.gateway_fee_cents);
  v_platform := coalesce(p_platform_fee_cents, p.platform_fee_cents);
  if v_gateway is not null then
    v_net := coalesce(p.gross_amount_cents, p.amount_cents) - v_platform - v_gateway;
    if v_net < 0 then
      insert into public.audit_logs (restaurant_id, actor_id, action, entity, entity_id, data)
      values (p.restaurant_id, null, 'payment.fee_mismatch', 'payments', p.id,
        jsonb_build_object('event_id', p_event_id, 'status', p_status,
                           'platform_fee_cents', v_platform, 'gateway_fee_cents', v_gateway));
      v_apply := false;
    end if;
  end if;

  if v_apply then
    update public.payments
    set provider_payment_id = coalesce(nullif(left(p_provider_payment_id, 200), ''), provider_payment_id),
        status = p_status,
        paid_at = case when p_status = 'PAID' then coalesce(paid_at, now()) else paid_at end,
        raw = coalesce(p_raw, raw),
        platform_fee_cents = v_platform,
        gateway_fee_cents = v_gateway,
        restaurant_net_amount_cents = coalesce(v_net, restaurant_net_amount_cents)
    where id = p.id;
  end if;

  insert into public.audit_logs (restaurant_id, actor_id, action, entity, entity_id, data)
  values (p.restaurant_id, null, 'payment.provider_update', 'payments', p.id,
    jsonb_build_object('provider', 'asaas', 'event_id', p_event_id, 'from', p.status,
                       'to', p_status, 'applied', v_apply));
  return true;
end;
$$;

revoke all on function public.set_asaas_payment_data(uuid, text, text, public.payment_status, text, text, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.apply_asaas_payment_update(uuid, text, public.payment_status, text, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.set_asaas_payment_data(uuid, text, text, public.payment_status, text, text, text, jsonb, integer) to service_role;
grant execute on function public.apply_asaas_payment_update(uuid, text, public.payment_status, text, jsonb, integer, integer) to service_role;

-- 3) A restaurant may take online payments with a connected Mercado Pago account (as before) OR with an
--    Asaas subaccount. Both still require the global switch `online_payments_enabled`.
create or replace function public.menzu_restaurant_online_payments_allowed(p_restaurant_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $$
  select coalesce(
    (select (s.value)::boolean from public.menzu_settings s
     where s.key = 'allow_development_payments' and jsonb_typeof(s.value) = 'boolean'), false)
  or (
    coalesce(
      (select (s.value)::boolean from public.menzu_settings s
       where s.key = 'online_payments_enabled' and jsonb_typeof(s.value) = 'boolean'), false)
    and (
      exists (select 1 from public.restaurant_payment_accounts a
              where a.restaurant_id = p_restaurant_id and a.status = 'connected')
      or exists (select 1 from public.asaas_accounts a where a.restaurant_id = p_restaurant_id)));
$$;

