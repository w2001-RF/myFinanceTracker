-- Privacy / compliance check: an admin must NOT be able to read other users' content.
-- Run in the Supabase SQL editor AFTER applying the migrations. Read-only; it rolls back.
--
-- 1. Replace <ADMIN_UUID> with the owner's auth.users id.
-- 2. Every query in section B must return 0 rows / count 0.
--    Section A must return exactly the admin's own rows only.

begin;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<ADMIN_UUID>","role":"authenticated"}', true);

-- A. The admin sees their own data (and only theirs)
select 'own transactions' as check, count(*) from public.general_transactions where user_id = '<ADMIN_UUID>';

-- B. The admin must see nothing that belongs to anyone else (all must be 0)
select 'other users general_transactions' as check, count(*) from public.general_transactions where user_id <> '<ADMIN_UUID>'
union all select 'other users rental_records',      count(*) from public.rental_records      where user_id <> '<ADMIN_UUID>'
union all select 'other users savings_records',     count(*) from public.savings_records     where user_id <> '<ADMIN_UUID>'
union all select 'other users transaction_templates', count(*) from public.transaction_templates where user_id <> '<ADMIN_UUID>'
union all select 'other users user_settings',       count(*) from public.user_settings       where user_id <> '<ADMIN_UUID>'
union all select 'other users savings_milestones',  count(*) from public.savings_milestones  where user_id <> '<ADMIN_UUID>';

-- C. The admin cannot add other admins or tamper with the audit log (each must fail with "permission denied")
-- insert into public.app_admins (user_id) values ('<ADMIN_UUID>');
-- delete from public.admin_audit_log;

-- D. What the admin CAN do: read/update app_settings, read the audit log, call admin_overview() (counts only)
select public.admin_overview();

rollback;
