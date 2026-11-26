create or replace function public.guest_order_review_state(p_order_id uuid, p_token text, p_confirm boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
begin
  select * into o from public.orders
  where id = p_order_id and public_token::text = p_token
    and (status = 'DELIVERED' or (type = 'DELIVERY' and status = 'OUT_FOR_DELIVERY'));
  if not found then return 'unavailable'; end if;

  if o.type = 'DELIVERY' and p_confirm then
    -- Serialize confirmation with restaurant updates and cancellations.
    select * into o from public.orders
    where id = p_order_id and public_token::text = p_token
      and type = 'DELIVERY' and status in ('OUT_FOR_DELIVERY', 'DELIVERED')
    for update;
    if not found then return 'unavailable'; end if;

    insert into public.guest_delivery_receipts (order_id) values (o.id)
    on conflict (order_id) do nothing;

    if o.status = 'OUT_FOR_DELIVERY' then
      update public.orders set status = 'DELIVERED', delivered_at = now() where id = o.id;
      insert into public.order_status_history (restaurant_id, order_id, from_status, to_status, note)
      values (o.restaurant_id, o.id, o.status, 'DELIVERED', 'Recebimento confirmado pelo cliente.');
      insert into public.audit_logs (restaurant_id, action, entity, entity_id, data)
      values (o.restaurant_id, 'order.status_changed', 'orders', o.id,
        jsonb_build_object('from', o.status, 'to', 'DELIVERED', 'source', 'guest_receipt'));
    end if;
  end if;

  if exists (select 1 from public.order_feedback where order_id = o.id) then return 'reviewed'; end if;
  if o.type = 'DELIVERY'
    and not exists (select 1 from public.guest_delivery_receipts where order_id = o.id) then
    return 'awaiting_receipt';
  end if;
  return 'ready';
end;
$$;

revoke all on function public.guest_order_review_state(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.guest_order_review_state(uuid,text,boolean) to anon, authenticated;
