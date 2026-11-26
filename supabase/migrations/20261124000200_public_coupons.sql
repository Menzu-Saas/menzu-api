-- Coupons the restaurant chooses to show at checkout. Default false: no existing coupon becomes visible.
alter table public.coupons add column is_public boolean not null default false;

-- Public list for a restaurant's checkout: only coupons marked public, active, inside their validity
-- window and not exhausted. Never returns internal data (used_count, ids of redemptions, customers).
create or replace function public.public_coupons(p_slug text)
returns jsonb
language sql stable security definer set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'code', c.code::text,
      'description', c.description,
      'type', c.type,
      'value', c.value,
      'min_order_cents', c.min_order_cents,
      'max_discount_cents', c.max_discount_cents,
      'ends_at', c.ends_at,
      'per_customer_limit', c.per_customer_limit
    ) order by c.created_at desc), '[]'::jsonb)
  from public.coupons c
  join public.restaurants r on r.id = c.restaurant_id
  where r.slug operator(extensions.=) (nullif(btrim(p_slug), ''))::extensions.citext
    and r.onboarding_completed
    and c.is_public and c.is_active
    and (c.starts_at is null or c.starts_at <= now())
    and (c.ends_at is null or c.ends_at > now())
    and (c.usage_limit is null or c.used_count < c.usage_limit);
$$;

revoke all on function public.public_coupons(text) from public;
grant execute on function public.public_coupons(text) to anon, authenticated, service_role;
