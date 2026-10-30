-- Shop staff access. NOT run automatically. Run step 1, confirm the three
-- accounts with Tyler, then run step 2 with the exact emails filled in.
-- Never add an account that has not been confirmed.

-- Step 1: find the Ride accounts (read-only).
select id, email, created_at, last_sign_in_at
from auth.users
order by created_at;

-- Current staff list (read-only).
select s.user_id, u.email, s.display_name, s.active
from public.shop_staff s join auth.users u on u.id = s.user_id;

-- Step 2: add staff by EXACT email. Garrett is filled in; replace the other
-- placeholders and uncomment them once confirmed. Each insert adds
-- nothing if the email has no Ride account, so check the row count it reports.
-- insert into public.shop_staff (user_id, display_name)
--   select id, 'Tyler' from auth.users where lower(email) = lower('<tyler-email>')
--   on conflict (user_id) do update set active = true, display_name = excluded.display_name;
-- Garrett: email confirmed by Tyler on 2026-10-30.
insert into public.shop_staff (user_id, display_name)
  select id, 'Garrett' from auth.users where lower(email) = lower('garchapman@gmail.com')
  on conflict (user_id) do update set active = true, display_name = excluded.display_name;
-- insert into public.shop_staff (user_id, display_name)
--   select id, 'Fang' from auth.users where lower(email) = lower('<fang-email>')
--   on conflict (user_id) do update set active = true, display_name = excluded.display_name;

-- To remove someone later (keeps their history): 
-- update public.shop_staff set active = false where user_id = '<user-id>';
