create function public.guest_order_review_state(p_order_id uuid, p_token text, p_confirm boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_type public.orders.type%type;
begin
  select o.type into v_type from public.orders o
  where o.id = p_order_id and o.public_token::text = p_token
    and (o.status = 'DELIVERED' or (o.type = 'DELIVERY' and o.status = 'OUT_FOR_DELIVERY'))
  for share;
  if not found then return 'unavailable'; end if;
  if exists (select 1 from public.order_feedback where order_id = p_order_id) then return 'reviewed'; end if;
  if v_type = 'DELIVERY' then
    if p_confirm then
      insert into public.guest_delivery_receipts (order_id) values (p_order_id)
      on conflict (order_id) do nothing;
    end if;
    if not exists (select 1 from public.guest_delivery_receipts where order_id = p_order_id) then
      return 'awaiting_receipt';
    end if;
  end if;
  return 'ready';
end;
$$;

revoke all on function public.guest_order_review_state(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.guest_order_review_state(uuid,text,boolean) to anon, authenticated;

