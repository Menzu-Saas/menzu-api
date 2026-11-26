-- These public endpoints enforce publication independently of the legacy table policies.
CREATE FUNCTION public.menzu_public_catalog(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH menus AS (
    SELECT m.id, m.name, m.position
    FROM public.menus AS m
    JOIN public.restaurants AS r ON r.id = m.restaurant_id
    WHERE r.id = p_restaurant_id AND r.onboarding_completed AND m.is_active
  ), categories AS (
    SELECT c.id, c.menu_id, c.name, c.description, c.position
    FROM public.categories AS c
    JOIN menus AS m ON m.id = c.menu_id
    WHERE c.restaurant_id = p_restaurant_id AND c.is_active
  ), products AS (
    SELECT p.id, p.category_id, p.name, p.description, p.image_url, p.price_cents,
           p.promo_price_cents, p.position,
           (p.is_available AND (p.stock_quantity IS NULL OR p.stock_quantity > 0)) AS available
    FROM public.products AS p
    JOIN categories AS c ON c.id = p.category_id
    WHERE p.restaurant_id = p_restaurant_id AND p.status = 'ACTIVE'
  ), variants AS (
    SELECT v.id, v.product_id, v.name, v.price_cents, v.is_available, v.position
    FROM public.product_variants AS v
    JOIN products AS p ON p.id = v.product_id
    WHERE v.restaurant_id = p_restaurant_id
  ), links AS (
    SELECT l.product_id, l.addon_group_id, l.position
    FROM public.product_addon_groups AS l
    JOIN products AS p ON p.id = l.product_id
    JOIN public.addon_groups AS g ON g.id = l.addon_group_id
    WHERE l.restaurant_id = p_restaurant_id AND g.restaurant_id = p_restaurant_id
  ), groups AS (
    SELECT g.id, g.name, g.min_select, g.max_select, g.is_required
    FROM public.addon_groups AS g
    WHERE g.restaurant_id = p_restaurant_id AND EXISTS (
      SELECT 1 FROM links AS l WHERE l.addon_group_id = g.id
    )
  ), options AS (
    SELECT o.id, o.addon_group_id, o.name, o.price_cents, o.is_available, o.max_quantity, o.position
    FROM public.addon_options AS o
    JOIN groups AS g ON g.id = o.addon_group_id
    WHERE o.restaurant_id = p_restaurant_id
  )
  SELECT jsonb_build_object(
    'menus', COALESCE((SELECT jsonb_agg(m ORDER BY m.position, m.id) FROM menus AS m), '[]'),
    'categories', COALESCE((SELECT jsonb_agg(c ORDER BY c.position, c.id) FROM categories AS c), '[]'),
    'products', COALESCE((SELECT jsonb_agg(p ORDER BY p.position, p.id) FROM products AS p), '[]'),
    'variants', COALESCE((SELECT jsonb_agg(v ORDER BY v.position, v.id) FROM variants AS v), '[]'),
    'links', COALESCE((SELECT jsonb_agg(l ORDER BY l.position, l.addon_group_id) FROM links AS l), '[]'),
    'groups', COALESCE((SELECT jsonb_agg(g ORDER BY g.id) FROM groups AS g), '[]'),
    'options', COALESCE((SELECT jsonb_agg(o ORDER BY o.position, o.id) FROM options AS o), '[]')
  );
$$;

CREATE FUNCTION public.menzu_public_table_exists(p_restaurant_id uuid, p_table_number integer)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.restaurant_tables AS t
    JOIN public.restaurants AS r ON r.id = t.restaurant_id
    WHERE r.id = p_restaurant_id AND r.onboarding_completed AND r.accepts_dine_in
      AND t.number = p_table_number
  );
$$;

REVOKE ALL ON FUNCTION public.menzu_public_catalog(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menzu_public_table_exists(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.menzu_public_catalog(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.menzu_public_table_exists(uuid, integer) TO anon, authenticated;
