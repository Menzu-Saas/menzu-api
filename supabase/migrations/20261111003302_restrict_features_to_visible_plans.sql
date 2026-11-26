DROP POLICY features_public_read ON public.features;
CREATE POLICY features_visible_plan_read ON public.features
  FOR SELECT TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM public.plan_features AS pf WHERE pf.feature_key = features.key));
CREATE POLICY features_platform_admin_read ON public.features
  FOR SELECT TO authenticated
  USING ((SELECT public.menzu_is_platform_admin()));
