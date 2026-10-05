-- Rollback for shop-001-core.sql. Run shop-002-writes-rollback.sql first
-- (the write functions reference these tables).
drop table if exists public.shop_part_orders;
drop table if exists public.shop_job_line_items;
drop table if exists public.shop_jobs;
drop table if exists public.shop_bikes;
drop table if exists public.shop_customers;
drop table if exists public.shop_audit_log;
drop function if exists public.shop_has_staff_access();
drop table if exists public.shop_staff;
