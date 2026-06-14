-- PIPSILY — Migration : table payments + activation automatique PayPal
-- À exécuter dans : Supabase Dashboard → SQL Editor

-- ── 1. Table des paiements ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  txn_id      text        UNIQUE,                          -- ID transaction PayPal
  payer_email text        NOT NULL,                        -- Email PayPal du client
  amount      numeric     NOT NULL,                        -- Montant reçu (42 ou 53)
  plan        text        NOT NULL,                        -- 'active' ou 'unlimited'
  user_id     uuid        REFERENCES auth.users(id),       -- Lié au compte PIPSILY
  status      text        DEFAULT 'completed',
  expires_at  timestamptz,                                 -- Expiration dans 1 an
  created_at  timestamptz DEFAULT now()
);


-- Ajouter les colonnes manquantes sur une table payments deja existante
DO $$
BEGIN
  BEGIN ALTER TABLE public.payments ADD COLUMN txn_id      text        UNIQUE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE public.payments ADD COLUMN payer_email text        NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE public.payments ADD COLUMN amount      numeric     NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE public.payments ADD COLUMN plan        text        NOT NULL DEFAULT 'active'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE public.payments ADD COLUMN user_id     uuid        REFERENCES auth.users(id); EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE public.payments ADD COLUMN status      text        DEFAULT 'completed'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE public.payments ADD COLUMN expires_at  timestamptz; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE public.payments ADD COLUMN created_at  timestamptz DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

CREATE INDEX IF NOT EXISTS payments_email_idx
  ON public.payments (lower(payer_email));

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- L'admin PIPSILY peut tout lire
CREATE POLICY "admin_read_payments" ON public.payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND plan = 'admin'
    )
  );

-- ── 2. Fonction SQL : retrouver un user par email ─────────────────────────
-- Utilisée par l'Edge Function (pas d'accès direct à auth.users via JS)
CREATE OR REPLACE FUNCTION public.get_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM auth.users
  WHERE lower(email) = lower(p_email)
  LIMIT 1;
$$;

-- ── 3. Trigger : activation automatique à l'inscription ──────────────────
-- Si le client paie AVANT de créer son compte, le trigger l'active
-- automatiquement dès qu'il s'inscrit et que son profil est créé.
CREATE OR REPLACE FUNCTION public.auto_activate_from_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_email   text;
  v_payment record;
BEGIN
  -- Récupérer l'email depuis auth.users
  SELECT email INTO v_email
  FROM auth.users WHERE id = NEW.id;

  -- Chercher un paiement non encore lié à ce compte
  SELECT * INTO v_payment
  FROM public.payments
  WHERE lower(payer_email) = lower(v_email)
    AND user_id IS NULL
    AND status = 'completed'
  ORDER BY created_at DESC
  LIMIT 1;

  -- Si paiement trouvé : activer le plan
  IF FOUND THEN
    NEW.plan       := v_payment.plan;
    NEW.expires_at := v_payment.expires_at;

    -- Lier le paiement au nouveau compte
    UPDATE public.payments
    SET user_id = NEW.id
    WHERE id = v_payment.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Attacher le trigger sur la création de profil
DROP TRIGGER IF EXISTS trg_auto_activate ON public.profiles;
CREATE TRIGGER trg_auto_activate
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_activate_from_payment();
