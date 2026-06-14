-- Public RPC wrappers call app_private helper functions for authorization.
-- The helper functions are still in an unexposed schema, but authenticated users
-- need schema USAGE so Postgres can resolve those function calls at runtime.

revoke all on schema app_private from public;
revoke all on schema app_private from anon;
grant usage on schema app_private to authenticated;
