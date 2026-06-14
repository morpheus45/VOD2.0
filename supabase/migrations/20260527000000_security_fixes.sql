-- PIPSILY — Migration correctifs SQL + sécurité Supabase
-- Coller dans : Supabase Dashboard > SQL Editor > Run
-- ou : supabase db push

-- ══════════════════════════════════════════════════════════════════
-- 1. TABLE sessions : colonnes manquantes utilisées par auth.js
-- ══════════════════════════════════════════════════════════════════
DO $$
BEGIN
  -- device_name : inséré par auth.js (getDeviceName())
  BEGIN ALTER TABLE public.sessions ADD COLUMN device_name text; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- last_seen : utilisé pour purger les sessions inactives (lt 24h)
  BEGIN ALTER TABLE public.sessions ADD COLUMN last_seen timestamptz DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- token : clé de reconnaissance de session
  BEGIN ALTER TABLE public.sessions ADD COLUMN token text; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

-- Index pour les requêtes de purge (DELETE WHERE last_seen < cutoff)
CREATE INDEX IF NOT EXISTS sessions_user_seen_idx
  ON public.sessions (user_id, last_seen);

-- ══════════════════════════════════════════════════════════════════
-- 2. FONCTION handle_new_user
--    Correctifs : search_path + admin case-insensitive + ON CONFLICT safe
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, plan)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN lower(NEW.email) = lower('cedric.lago@gmail.com') THEN 'admin' ELSE 'pending' END
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$;

-- Trigger functions sont appelées par le moteur PG, pas via RPC
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- S'assurer que le trigger existe
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ══════════════════════════════════════════════════════════════════
-- 3. FONCTION auto_activate_from_payment
--    Correctifs : search_path + NEW.subscription_expires_at (pas NEW.expires_at)
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.auto_activate_from_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email   text;
  v_payment record;
BEGIN
  -- Récupérer l'email depuis auth.users
  SELECT email INTO v_email
  FROM auth.users WHERE id = NEW.id;

  -- Chercher le paiement le plus récent non encore lié
  SELECT * INTO v_payment
  FROM public.payments
  WHERE lower(payer_email) = lower(v_email)
    AND user_id IS NULL
    AND status = 'completed'
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    NEW.plan                    := v_payment.plan;
    -- CORRECTIF : colonne profiles = subscription_expires_at (pas expires_at)
    NEW.subscription_expires_at := v_payment.expires_at;

    -- Lier le paiement au compte créé
    UPDATE public.payments
    SET user_id = NEW.id
    WHERE id = v_payment.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger function — jamais appelée via REST API
REVOKE EXECUTE ON FUNCTION public.auto_activate_from_payment() FROM anon, authenticated;

-- Recréer le trigger
DROP TRIGGER IF EXISTS trg_auto_activate ON public.profiles;
CREATE TRIGGER trg_auto_activate
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_activate_from_payment();

-- ══════════════════════════════════════════════════════════════════
-- 4. FONCTION get_user_id_by_email
--    Déjà correct (search_path). Restreindre aux utilisateurs connectés.
-- ══════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.get_user_id_by_email(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_user_id_by_email(text) TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- 5. FONCTION is_admin — passer en SECURITY INVOKER (lit ses propres données)
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND plan = 'admin'
  );
$$;

-- Seuls les utilisateurs connectés peuvent appeler is_admin()
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- 6. FONCTION rls_auto_enable — bloquer l'accès public
-- ══════════════════════════════════════════════════════════════════
DO $$
DECLARE
  _fn_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable'
      AND pg_get_function_arguments(p.oid) = ''
  ) INTO _fn_exists;

  IF _fn_exists THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════
-- 7. POLITIQUE sessions : l'admin peut tout voir
-- ══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "admin all sessions" ON public.sessions;
CREATE POLICY "admin all sessions" ON public.sessions
  FOR ALL
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND plan = 'admin'
    )
  );

-- ══════════════════════════════════════════════════════════════════
-- 8. Forcer plan = 'admin' pour cedric.lago@gmail.com
--    (au cas où le trigger initial n'avait pas le bon case)
-- ══════════════════════════════════════════════════════════════════
UPDATE public.profiles
SET plan = 'admin', devices_allowed = 999
WHERE lower(email) = lower('cedric.lago@gmail.com')
  AND plan IS DISTINCT FROM 'admin';
