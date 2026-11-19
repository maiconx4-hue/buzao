DROP POLICY IF EXISTS "achievements public" ON public.achievements;
REVOKE SELECT ON public.achievements FROM anon;
CREATE POLICY "achievements readable by signed-in users" ON public.achievements FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);