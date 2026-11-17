-- Rollback for shop-006-payment-status.sql (existing payment_status values stay).
drop function if exists public.shop_set_payment_status(text, text);
