-- ============================================================================
-- Account Generator Bot (Gen Bot) - Supabase PostgreSQL Schema & Atomic RPC
-- Run this entire script in the Supabase SQL Editor.
-- ============================================================================

-- Ensure pgcrypto is enabled for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Users Table (Role-Based Access Control)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
    discord_id TEXT PRIMARY KEY,
    rba_role TEXT NOT NULL DEFAULT 'Free' CHECK (rba_role IN ('Free', 'Premium', 'Admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Automatically update updated_at on row changes
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_updated_at ON public.users;
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Services Table (Generator Services Configuration)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.services (
    name TEXT PRIMARY KEY,
    required_role TEXT NOT NULL DEFAULT 'Free' CHECK (required_role IN ('Free', 'Premium', 'Admin')),
    channel_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 3. Stock (Accounts) Table (Ephemeral Account Pool - Deleted Upon Generation)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name TEXT NOT NULL REFERENCES public.services(name) ON DELETE CASCADE ON UPDATE CASCADE,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite index for fast FIFO claiming and exact per-service stock counting
CREATE INDEX IF NOT EXISTS idx_stock_service_name_created_at
    ON public.stock (service_name, created_at ASC, id ASC);

-- ----------------------------------------------------------------------------
-- 4. Row Level Security (Lock out public anon key; service_role bypasses RLS)
-- ----------------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5. Atomic Account Claim & Delete RPC (Eliminates Race Conditions)
-- ----------------------------------------------------------------------------
-- Uses SELECT ... FOR UPDATE SKIP LOCKED + DELETE ... RETURNING inside a single
-- atomic statement so concurrent /gen requests at the exact same millisecond
-- can NEVER claim the same account or block each other.
CREATE OR REPLACE FUNCTION public.claim_stock_account(p_service_name TEXT)
RETURNS TABLE (
    id UUID,
    service_name TEXT,
    email TEXT,
    password TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH claimed AS (
        SELECT s.id
        FROM public.stock AS s
        WHERE s.service_name = p_service_name
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.stock AS st
    USING claimed
    WHERE st.id = claimed.id
    RETURNING st.id, st.service_name, st.email, st.password;
END;
$$;

-- Restrict RPC execution strictly to the backend service_role key
REVOKE ALL ON FUNCTION public.claim_stock_account(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stock_account(TEXT) TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Optional: Bootstrap Your Initial Admin User
-- Replace YOUR_DISCORD_USER_ID with your 18/19-digit Discord Snowflake ID
-- ----------------------------------------------------------------------------
-- INSERT INTO public.users (discord_id, rba_role)
-- VALUES ('YOUR_DISCORD_USER_ID', 'Admin')
-- ON CONFLICT (discord_id) DO UPDATE SET rba_role = 'Admin';
