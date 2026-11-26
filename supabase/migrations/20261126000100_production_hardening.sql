-- Production hardening (applied 2026-11-26).
-- 1) Demonstration payments off: with it on, every restaurant counts as able to take online payments and
--    owners/managers can mark "development" payments as paid.
update public.menzu_settings set value = 'false'::jsonb where key = 'allow_development_payments';

-- 2) The development-only functions stop being callable from browser sessions.
revoke execute on function public.dev_simulate_payment(uuid, public.payment_status) from public, anon, authenticated;
revoke execute on function public.set_development_payment_data(uuid, text, text, text, public.payment_status, text, jsonb) from public, anon, authenticated;
grant execute on function public.dev_simulate_payment(uuid, public.payment_status) to service_role;
grant execute on function public.set_development_payment_data(uuid, text, text, text, public.payment_status, text, jsonb) to service_role;

-- 3) Platform-admin views (one reads auth.users). They already return rows only to platform admins, but no
--    browser role needs them: this app does not use them.
revoke all on public.admin_restaurants_overview, public.admin_plan_stats from anon, authenticated;
grant select on public.admin_restaurants_overview, public.admin_plan_stats to service_role;
