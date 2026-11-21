-- Rollback for shop-010 (rewards points + Dollars for Dads).
-- WARNING: this DELETES every rewards entry and every D4D donation record.
-- Only use it before real customers or donations are in. Once real data is in,
-- turn rewards off instead: update public.shop_settings set rewards_enabled = false;
drop trigger if exists shop_jobs_rewards_sync on public.shop_jobs;
drop function if exists public.shop_rewards_sync_job();
drop function if exists public.shop_rewards_redeem(text, text, integer, text, text);
drop function if exists public.shop_rewards_adjust(text, text, integer, text);
drop function if exists public.shop_update_reward_settings(jsonb);
drop function if exists public.shop_rewards_backfill(date);
drop function if exists public.shop_reward_balance(text);
drop view if exists public.shop_reward_balances;
drop function if exists public.shop_rewards_target(public.shop_jobs);
drop table if exists public.shop_reward_entries;
drop function if exists public.shop_d4d_save_donation(text, jsonb);
drop function if exists public.shop_d4d_refund(text, text);
drop function if exists public.shop_d4d_mark_forwarded(jsonb, date, text);
drop function if exists public.shop_d4d_give_prize(text, text, text, text);
drop function if exists public.shop_d4d_undo_prize(text, text, text, text);
drop view if exists public.shop_d4d_campaign_summary;
drop view if exists public.shop_d4d_donor_totals;
drop function if exists public.shop_d4d_donor_key(text, text, text, text);
drop table if exists public.shop_d4d_prizes_given;
drop table if exists public.shop_d4d_donations;
alter table public.shop_settings drop constraint if exists shop_settings_rewards_rate_check;
alter table public.shop_settings drop column if exists rewards_enabled;
alter table public.shop_settings drop column if exists rewards_points_per_dollar;
alter table public.shop_settings drop column if exists rewards_point_value_cents;
alter table public.shop_settings drop column if exists rewards_start_date;
-- Give the two old functions back to app accounts (only if something needs them).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('shop_submit_estimate', 'shop_set_job_line_items') loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
