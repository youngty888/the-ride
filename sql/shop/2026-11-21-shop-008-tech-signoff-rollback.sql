-- Rollback for shop-008-tech-signoff.sql (drops sign-offs and the login log).
drop function if exists public.shop_log_login();
drop function if exists public.shop_settle_step(text, text, jsonb);
drop function if exists public.shop_dispute_step(text, text, text);
drop function if exists public.shop_sign_step(text, text, text);
drop function if exists public.shop_step_bid_hours(text, text);
drop function if exists public.shop_is_payroll_manager();
drop table if exists public.shop_staff_logins;
drop table if exists public.shop_labor_signoffs;
alter table public.shop_staff drop column if exists payroll_manager;
