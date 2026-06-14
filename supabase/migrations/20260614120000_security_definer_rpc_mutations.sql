-- These RPCs already authorize the caller via app_private.can_manage_match_team
-- (captain branding) or app_private.is_admin() (scoring / undo) and then run an
-- UPDATE on public.matches. RLS on matches only permits admin UPDATEs, so when a
-- captain calls update_match_team_branding the inner UPDATE silently affects zero
-- rows, RETURNING * INTO leaves the rowtype null, and the function raises
-- "Match not found" (P0001). Promote to SECURITY DEFINER so the upfront role
-- check is what actually gates access.

alter function public.update_match_team_branding(uuid, text, text, text, text)
  security definer
  set search_path = public;

alter function public.score_match_delivery(uuid, integer, text, boolean)
  security definer
  set search_path = public;

alter function public.undo_last_match_delivery(uuid)
  security definer
  set search_path = public;
