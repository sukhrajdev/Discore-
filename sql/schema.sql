-- ============================================================================
-- Account Generator Bot (Gen Bot) - Supabase PostgreSQL Schema & Atomic RPCs
-- Run this entire script in the Supabase SQL Editor (safe for fresh & existing DBs).
-- ============================================================================

-- Ensure pgcrypto is enabled for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Roles Table (Built-In + Custom RBA Roles)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roles (
    name TEXT PRIMARY KEY,
    priority INTEGER NOT NULL DEFAULT 25,
    channel_id TEXT NULL,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed core roles (Free = 1, Premium = 50, Admin = 100)
INSERT INTO public.roles (name, priority, channel_id, is_system)
VALUES
    ('Free', 1, NULL, TRUE),
    ('Premium', 50, NULL, FALSE),
    ('Admin', 100, NULL, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Users Table (User Role Assignments)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
    discord_id TEXT PRIMARY KEY,
    rba_role TEXT NOT NULL DEFAULT 'Free',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Remove legacy hardcoded check constraint if upgrading from an earlier schema
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_rba_role_check;

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
-- 3. Services Table (Generator Services Configuration)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.services (
    name TEXT PRIMARY KEY,
    required_role TEXT NOT NULL DEFAULT 'Free',
    channel_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Remove legacy hardcoded check constraint if upgrading from an earlier schema
ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_required_role_check;

-- Backfill any pre-existing custom role names before adding foreign keys
INSERT INTO public.roles (name, priority)
SELECT DISTINCT rba_role, 25
FROM public.users
WHERE rba_role IS NOT NULL
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.roles (name, priority)
SELECT DISTINCT required_role, 25
FROM public.services
WHERE required_role IS NOT NULL
ON CONFLICT (name) DO NOTHING;

-- Link users.rba_role and services.required_role to roles.name with ON UPDATE CASCADE
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_rba_role'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT fk_users_rba_role
            FOREIGN KEY (rba_role) REFERENCES public.roles(name)
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_services_required_role'
    ) THEN
        ALTER TABLE public.services
            ADD CONSTRAINT fk_services_required_role
            FOREIGN KEY (required_role) REFERENCES public.roles(name)
            ON UPDATE CASCADE;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Stock (Accounts) Table (Ephemeral Account Pool - Deleted Upon Generation)
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
-- 5. Row Level Security (Lock out public anon key; service_role bypasses RLS)
-- ----------------------------------------------------------------------------
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 6. Atomic Account Claim & Delete RPC (Eliminates Race Conditions)
-- ----------------------------------------------------------------------------
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

REVOKE ALL ON FUNCTION public.claim_stock_account(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stock_account(TEXT) TO service_role;

-- ----------------------------------------------------------------------------
-- 7. Aggregated Service Stock Counts RPC (Powers /stocks in a single query)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_all_service_stocks()
RETURNS TABLE (
    name TEXT,
    required_role TEXT,
    channel_id TEXT,
    stock_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        sv.name,
        sv.required_role,
        sv.channel_id,
        COUNT(st.id)::BIGINT AS stock_count
    FROM public.services AS sv
    LEFT JOIN public.stock AS st ON st.service_name = sv.name
    GROUP BY sv.name, sv.required_role, sv.channel_id
    ORDER BY sv.name ASC;
$$;

REVOKE ALL ON FUNCTION public.get_all_service_stocks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_service_stocks() TO service_role;

-- ----------------------------------------------------------------------------
-- 8. Optional: Bootstrap Your Initial Admin User
-- Replace YOUR_DISCORD_USER_ID with your 18/19-digit Discord Snowflake ID
-- ----------------------------------------------------------------------------
-- INSERT INTO public.users (discord_id, rba_role)
-- VALUES ('YOUR_DISCORD_USER_ID', 'Admin')
-- ON CONFLICT (discord_id) DO UPDATE SET rba_role = 'Admin';
