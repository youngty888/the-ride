-- Undo shop-012: buyers can no longer see their payment plan in the app.
-- Removes one function only. Plans and payments are not touched.
drop function if exists public.shop_my_payment_plans();
