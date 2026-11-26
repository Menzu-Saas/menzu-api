create table public.guest_delivery_receipts (
  order_id uuid primary key references public.orders(id) on delete cascade,
  received_at timestamptz not null default now()
);
alter table public.guest_delivery_receipts enable row level security;
revoke all on public.guest_delivery_receipts from public, anon, authenticated;

create table public.order_feedback (
  order_id uuid primary key references public.orders(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  restaurant_stars smallint not null check (restaurant_stars between 1 and 5),
  system_stars smallint not null check (system_stars between 1 and 5),
  restaurant_comment text check (char_length(restaurant_comment) <= 500),
  system_comment text check (char_length(system_comment) <= 500),
  created_at timestamptz not null default now()
);
alter table public.order_feedback enable row level security;
revoke all on public.order_feedback from public, anon, authenticated;
create index order_feedback_restaurant_idx on public.order_feedback (restaurant_id, created_at desc);

create function public.submit_order_feedback(p_order_id uuid, p_token text, p_restaurant_stars integer,
  p_system_stars integer, p_restaurant_comment text, p_system_comment text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_restaurant_stars not between 1 and 5 or p_system_stars not between 1 and 5
    or p_restaurant_stars is null or p_system_stars is null
    or char_length(p_restaurant_comment) > 500 or char_length(p_system_comment) > 500 then
    return false;
  end if;
  insert into public.order_feedback
    (order_id, restaurant_id, restaurant_stars, system_stars, restaurant_comment, system_comment)
  select o.id, o.restaurant_id, p_restaurant_stars, p_system_stars,
    nullif(btrim(p_restaurant_comment), ''), nullif(btrim(p_system_comment), '')
  from public.orders o where o.id = p_order_id and o.public_token::text = p_token
    and (o.status = 'DELIVERED' or (o.type = 'DELIVERY' and o.status = 'OUT_FOR_DELIVERY'))
    and (o.type <> 'DELIVERY' or exists (
      select 1 from public.guest_delivery_receipts r where r.order_id = o.id
    ))
  on conflict (order_id) do nothing;
  return found;
end;
$$;

create function public.restaurant_rating(p_restaurant_id uuid)
returns table (average numeric, total bigint)
language sql stable security definer set search_path = '' as $$
  select round(avg(f.restaurant_stars), 1), count(*)
  from public.order_feedback f where f.restaurant_id = p_restaurant_id;
$$;

create function public.restaurant_feedback(p_restaurant_id uuid)
returns table (stars smallint, comment text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.restaurant_stars, f.restaurant_comment, f.created_at
  from public.order_feedback f where f.restaurant_id = p_restaurant_id
    and public.menzu_has_role(p_restaurant_id, array['OWNER','MANAGER']::public.member_role[])
  order by f.created_at desc limit 20;
$$;

revoke all on function public.submit_order_feedback(uuid,text,integer,integer,text,text),
  public.restaurant_rating(uuid), public.restaurant_feedback(uuid) from public, anon, authenticated;
grant execute on function public.submit_order_feedback(uuid,text,integer,integer,text,text),
  public.restaurant_rating(uuid) to anon, authenticated;
grant execute on function public.restaurant_feedback(uuid) to authenticated;
