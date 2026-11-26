-- Guest checkout, readiness and tenant-scoped reconciliation.
create table public.guest_order_attempts (
  request_id uuid primary key,
  payload_hash text not null,
  order_id uuid references public.orders(id) on delete cascade,
  result jsonb,
  created_at timestamptz not null default now()
);
alter table public.guest_order_attempts enable row level security;
revoke all on public.guest_order_attempts from public, anon, authenticated;
create index guest_order_attempts_reference_idx on public.guest_order_attempts ((right(request_id::text, 12)));

-- The publishable key alone cannot create an order: a server-only key is mandatory.
create function public.create_guest_order(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key uuid;
  v_hash text;
  v_attempt public.guest_order_attempts%rowtype;
  v_result jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or not coalesce(public.menzu_order_key_valid(p_payload ->> 'server_key'), false) then
    perform public.menzu_raise('FORBIDDEN', 'Pedidos só podem ser enviados pelo cardápio do restaurante.');
  end if;
  if coalesce(p_payload ->> 'idempotency_key', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform public.menzu_raise('INVALID_PAYLOAD', 'Tentativa de pedido inválida.');
  end if;
  if coalesce(p_payload ->> 'payment_method', '') <> 'CASH' then
    perform public.menzu_raise('PAYMENT_METHOD_DISABLED', 'Nesta BETA, escolha pagamento presencial.');
  end if;
  v_key := (p_payload ->> 'idempotency_key')::uuid;
  v_hash := encode(pg_catalog.sha256(convert_to((p_payload - 'server_key' - 'client_fingerprint' - 'idempotency_key' - 'buyer_user_id')::text, 'UTF8')), 'hex');
  insert into public.guest_order_attempts(request_id, payload_hash) values (v_key, v_hash)
    on conflict do nothing;
  select * into strict v_attempt from public.guest_order_attempts where request_id = v_key for update;
  if v_attempt.payload_hash <> v_hash then
    perform public.menzu_raise('IDEMPOTENCY_CONFLICT', 'Esta tentativa já foi usada com outro pedido.');
  end if;
  if v_attempt.result is not null then
    return v_attempt.result || jsonb_build_object('replayed', true);
  end if;
  -- Reuse price, tenant, stock, availability, coupon and abuse validations atomically.
  v_result := public.menzu_create_order_with_limits(p_payload - 'idempotency_key' - 'buyer_user_id');
  update public.guest_order_attempts
    set order_id = (v_result ->> 'order_id')::uuid, result = v_result
    where request_id = v_key;
  return v_result || jsonb_build_object('replayed', false);
end;
$$;
revoke all on function public.create_guest_order(jsonb) from public, anon, authenticated;
grant execute on function public.create_guest_order(jsonb) to anon;

create function public.menzu_guest_order_ready(p_server_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.menzu_order_key_valid(p_server_key), false);
$$;
revoke all on function public.menzu_guest_order_ready(text) from public, anon, authenticated;
grant execute on function public.menzu_guest_order_ready(text) to anon;

-- The short reference is for staff lookup only, never a receipt or polling credential.
create function public.find_guest_order_attempt(p_restaurant_id uuid, p_reference text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'created_at', o.created_at)
    order by o.created_at desc
  ), '[]'::jsonb)
  from public.guest_order_attempts a
  join public.orders o on o.id = a.order_id
  where o.restaurant_id = p_restaurant_id
    and public.menzu_has_role(p_restaurant_id, array['OWNER','MANAGER','ATTENDANT']::public.member_role[])
    and p_reference ~* '^[0-9a-f]{12}$'
    and right(a.request_id::text, 12) = lower(p_reference);
$$;
revoke all on function public.find_guest_order_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.find_guest_order_attempt(uuid, text) to authenticated;
