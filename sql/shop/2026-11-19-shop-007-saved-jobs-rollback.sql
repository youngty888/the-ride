-- Rollback for shop-007-saved-jobs.sql (drops the saved job list).
drop function if exists public.shop_remember_jobs(jsonb);
drop table if exists public.shop_saved_jobs;
