-- Undo shop-012 (customer "My loan" sign-in). Staff payment plans are untouched.
drop function if exists public.shop_my_payment_plans();
