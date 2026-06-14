-- RLS policies on public tables call app_private.is_admin / is_captain / can_manage_match_team.
-- A prior migration revoked EXECUTE from authenticated to keep the helpers off the PostgREST API,
-- but that also broke the policies themselves (Postgres still requires EXECUTE on the function to
-- evaluate the policy). Functions stay in the unexposed app_private schema, so granting EXECUTE
-- back to authenticated does not expose them as callable RPCs.

grant execute on function app_private.is_admin() to authenticated;
grant execute on function app_private.is_captain() to authenticated;
grant execute on function app_private.can_manage_match_team(uuid, text) to authenticated;
