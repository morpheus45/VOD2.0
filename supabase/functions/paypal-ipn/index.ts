// PIPSILY — PayPal IPN Webhook
// Déclenché par PayPal à chaque paiement reçu sur paypal.me/pipsily
// Vérifie le paiement, détermine le plan (Solo 42€ / Multi 53€),
// et active automatiquement le compte Supabase correspondant.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const IPN_VERIFY_URL = "https://ipnpb.paypal.com/cgi-bin/webscr";
// Pour les tests sandbox PayPal, remplacer par :
// const IPN_VERIFY_URL = "https://ipnpb.sandbox.paypal.com/cgi-bin/webscr";

serve(async (req: Request) => {
  // PayPal envoie uniquement des POST
  if (req.method !== "POST") {
    return new Response("nok", { status: 405 });
  }

  const raw = await req.text();

  // ── 1. Vérification IPN auprès de PayPal ──────────────────────────────────
  // PayPal exige qu'on renvoie exactement ce qu'il nous a envoyé, précédé de
  // "cmd=_notify-validate&", et il répond "VERIFIED" ou "INVALID".
  const verifyResp = await fetch(IPN_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "cmd=_notify-validate&" + raw,
  });
  const verified = await verifyResp.text();
  if (verified !== "VERIFIED") {
    console.warn("IPN rejeté :", verified);
    return new Response("nok", { status: 400 });
  }

  // ── 2. Extraction des données ─────────────────────────────────────────────
  const p           = new URLSearchParams(raw);
  const status      = p.get("payment_status");
  const payer_email = (p.get("payer_email") ?? "").toLowerCase().trim();
  const gross       = parseFloat(p.get("mc_gross") ?? "0");
  const currency    = p.get("mc_currency");
  const txn_id      = p.get("txn_id") ?? "";

  // Ignorer tout ce qui n'est pas un paiement complété en EUR
  if (status !== "Completed" || currency !== "EUR") {
    console.log("Ignoré — status:", status, "currency:", currency);
    return new Response("ok", { status: 200 });
  }

  // ── 3. Détermination du plan ──────────────────────────────────────────────
  // On tolère ±1€ pour couvrir d'éventuels arrondis de change
  let plan: string | null = null;
  if (Math.abs(gross - 42) <= 1) plan = "active";       // Solo — 1 écran
  if (Math.abs(gross - 53) <= 1) plan = "unlimited";    // Multi — 3 écrans

  if (!plan || !payer_email) {
    console.log("Montant non reconnu :", gross, "€ —", payer_email);
    return new Response("ok", { status: 200 });
  }

  // ── 4. Date d'expiration : 1 an à partir d'aujourd'hui ───────────────────
  const expires_at = new Date();
  expires_at.setFullYear(expires_at.getFullYear() + 1);

  // ── 5. Client Supabase avec droits admin ──────────────────────────────────
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // ── 6. Rechercher l'utilisateur par email (via fonction SQL) ──────────────
  const { data: userId } = await supa.rpc("get_user_id_by_email", {
    p_email: payer_email,
  });

  // ── 7. Activer le profil si l'utilisateur existe déjà ────────────────────
  if (userId) {
    const { error } = await supa.from("profiles").update({
      plan,
      expires_at: expires_at.toISOString(),
    }).eq("id", userId);
    if (error) console.error("Erreur update profil :", error.message);
    else console.log(`✅ Activé : ${payer_email} → plan ${plan}`);
  } else {
    // L'utilisateur n'existe pas encore — le trigger SQL activera le compte
    // dès qu'il créera son profil après inscription.
    console.log(`📥 Paiement stocké, user pas encore inscrit : ${payer_email}`);
  }

  // ── 8. Enregistrement du paiement (idempotent via txn_id) ────────────────
  const { error: payErr } = await supa.from("payments").upsert({
    txn_id,
    payer_email,
    amount:     gross,
    plan,
    user_id:    userId ?? null,
    status:     "completed",
    expires_at: expires_at.toISOString(),
  }, { onConflict: "txn_id" });

  if (payErr) console.error("Erreur insert payment :", payErr.message);

  return new Response("ok", { status: 200 });
});
