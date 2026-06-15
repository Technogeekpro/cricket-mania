import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.108.1";
import webpush from "npm:web-push@3.6.7";

type PushSubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const appOrigin = Deno.env.get("APP_ORIGIN") ?? "https://cricket-mania-tau.vercel.app";

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return json({ error: "Push notification secrets are not configured." }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Missing authorization header." }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const jwt = authHeader.replace("Bearer ", "");
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) {
    return json({ error: "Invalid session." }, 401);
  }

  const { data: roleRow, error: roleError } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (roleError) {
    return json({ error: roleError.message }, 500);
  }

  if (roleRow?.role !== "admin") {
    return json({ error: "Admin access required." }, 403);
  }

  const { matchId } = await req.json().catch(() => ({ matchId: "" }));
  if (!matchId || typeof matchId !== "string") {
    return json({ error: "matchId is required." }, 400);
  }

  const { data: match, error: matchError } = await admin
    .from("matches")
    .select("id,title,venue,team_a_name,team_b_name,total_overs,team_size")
    .eq("id", matchId)
    .single();

  if (matchError || !match) {
    return json({ error: matchError?.message ?? "Match not found." }, 404);
  }

  const { data: roleRows, error: rolesError } = await admin
    .from("user_roles")
    .select("user_id,role")
    .in("role", ["player", "captain"]);

  if (rolesError) {
    return json({ error: rolesError.message }, 500);
  }

  const candidateUserIds = [...new Set((roleRows ?? []).map((row) => row.user_id))];
  if (candidateUserIds.length === 0) {
    return json({ sent: 0, failed: 0, skipped: 0 });
  }

  const { data: profiles, error: profilesError } = await admin
    .from("profiles")
    .select("id,is_banned")
    .in("id", candidateUserIds);

  if (profilesError) {
    return json({ error: profilesError.message }, 500);
  }

  const activeUserIds = new Set((profiles ?? []).filter((profile) => !profile.is_banned).map((profile) => profile.id));
  if (activeUserIds.size === 0) {
    return json({ sent: 0, failed: 0, skipped: candidateUserIds.length });
  }

  const { data: subscriptions, error: subscriptionsError } = await admin
    .from("push_subscriptions")
    .select("id,user_id,endpoint,p256dh,auth")
    .in("user_id", [...activeUserIds]);

  if (subscriptionsError) {
    return json({ error: subscriptionsError.message }, 500);
  }

  const targetUrl = new URL("/", appOrigin);
  targetUrl.searchParams.set("match", match.id);

  const payload = JSON.stringify({
    title: "New match created",
    body: `${match.team_a_name} vs ${match.team_b_name} · ${match.title} at ${match.venue}`,
    tag: `match-created-${match.id}`,
    url: targetUrl.toString(),
  });

  webpush.setVapidDetails("mailto:admin@cricket-mania.app", vapidPublicKey, vapidPrivateKey);

  let sent = 0;
  let failed = 0;
  const expiredSubscriptionIds: string[] = [];

  await Promise.all(
    ((subscriptions ?? []) as PushSubscriptionRow[]).map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          payload,
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
        if (statusCode === 404 || statusCode === 410) {
          expiredSubscriptionIds.push(subscription.id);
        }
      }
    }),
  );

  if (expiredSubscriptionIds.length > 0) {
    await admin.from("push_subscriptions").delete().in("id", expiredSubscriptionIds);
  }

  return json({
    sent,
    failed,
    removed: expiredSubscriptionIds.length,
    skipped: Math.max(0, candidateUserIds.length - activeUserIds.size),
  });
});
