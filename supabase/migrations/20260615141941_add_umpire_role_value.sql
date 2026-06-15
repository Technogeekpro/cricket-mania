-- New 'umpire' role. Admins assign it; umpires can run matches (create, move
-- players between teams, score) but not the admin-only powers. Enum value must be
-- added in its own transaction before anything references it.

alter type public.app_role add value if not exists 'umpire';
