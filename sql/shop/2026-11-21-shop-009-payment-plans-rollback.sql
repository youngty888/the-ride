-- Undo shop-009 (payment plans). Deletes every payment plan and payment recorded.
drop function if exists public.shop_delete_plan_payment(text);
drop function if exists public.shop_record_plan_payment(text, jsonb);
drop function if exists public.shop_save_payment_plan(text, jsonb);
drop function if exists public.shop_save_customer(text, jsonb, text, jsonb);
-- Customers and bikes added through shop_save_customer stay (they may have estimates too).
drop view if exists public.shop_payment_plan_summary;
drop table if exists public.shop_plan_payments;
drop table if exists public.shop_payment_plans;
