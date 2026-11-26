-- Cards charged through the API (data goes server -> Asaas only) and saved cards for signed-in buyers.
-- Applied 2026-11-25. Only the Asaas token is stored (encrypted), never the number or the CVV.

-- 1) Hosted card page is gone: a card payment is registered without a link. A link, when present, must
--    still be https on an Asaas host.
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

-- 2) Saved cards. A token only works for the Asaas customer that created it, so the customer id is kept
--    and the card is only usable at the same restaurant.
create table public.buyer_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  environment text not null check (environment in ('sandbox', 'production')),
  asaas_customer_id text not null,
  encrypted_token text not null,
  brand text not null check (length(brand) between 1 and 30),
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  exp_month smallint not null check (exp_month between 1 and 12),
  exp_year smallint not null check (exp_year between 2000 and 2100),
  created_at timestamptz not null default now(),
  unique (user_id, restaurant_id, environment, brand, last4)
);
create index buyer_cards_user_idx on public.buyer_cards (user_id, restaurant_id);
alter table public.buyer_cards enable row level security;
revoke all on public.buyer_cards from anon, authenticated;
grant select, insert, update, delete on public.buyer_cards to service_role;
