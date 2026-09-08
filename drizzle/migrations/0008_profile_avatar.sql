-- 0008 PROFILE AVATAR
--
-- Personal account settings need a profile picture per console account.
-- Stored as a public URL (uploaded to the "Avatars" bucket, same as org
-- logos) so the Members list and sidebar can render it without extra joins.
-- Existing SELECT/UPDATE policies ("read own or same organization",
-- "update own or manage member") already cover the new column — no policy
-- change needed.
-- Apply in the Supabase SQL editor.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url text;
