-- Schema is applied to the connected Supabase project.
-- This repository copy documents the database foundation for Kotoha AI.

-- Tables
-- profiles, conversations, messages, usage_daily,
-- usage_policies, special_periods, admin_logs

-- Important security decisions:
-- * RLS is enabled on every public table.
-- * General users only access their own profile/conversations/messages/usage.
-- * Admin checks use a server-side profiles.role value.
-- * Editable auth user metadata is never used for authorization.
-- * usage_daily and admin_logs are server-managed.
-- * AI provider credentials are not stored in this database migration.
