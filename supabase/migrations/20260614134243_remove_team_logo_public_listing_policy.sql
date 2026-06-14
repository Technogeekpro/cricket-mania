-- Public bucket URLs work without a broad SELECT policy, and dropping this
-- prevents clients from listing every logo object in the bucket.

drop policy if exists "team_logos_select_public" on storage.objects;
