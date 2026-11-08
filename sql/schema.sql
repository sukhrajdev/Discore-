-- ============================================================================
-- Account Generator Bot (Gen Bot) - Supabase PostgreSQL Schema & Atomic RPCs
-- Run this entire script in the Supabase SQL Editor (safe for fresh & existing DBs).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Roles Table (Built-In + Custom RBA Roles, Cooldowns, & Discord Role Sync)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roles (
    name TEXT PRIMARY KEY,
    priority INTEGER NOT NULL DEFAULT 25,
    channel_id TEXT NULL,
    cooldown_seconds INTEGER NOT NULL DEFAULT 300 CHECK (cooldown_seconds >= 0),
    discord_role_id TEXT NULL,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column upgrades for existing databases
ALTER TABLE public.roles
    ADD COLUMN IF NOT EXISTS cooldown_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE public.roles
    ADD COLUMN IF NOT EXISTS discord_role_id TEXT NULL;

-- Seed core roles (Free = 30m cooldown, Premium = 5m cooldown, Admin = 0s cooldown)
INSERT INTO public.roles (name, priority, channel_id, cooldown_seconds, discord_role_id, is_system)
VALUES
    ('Free', 1, NULL, 1800, NULL, TRUE),
    ('Premium', 50, NULL, 300, NULL, FALSE),
    ('Admin', 100, NULL, 0, NULL, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Users Table (Role Assignments, Timed Subscriptions, & Cooldown Tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
    discord_id TEXT PRIMARY KEY,
    rba_role TEXT NOT NULL DEFAULT 'Free',
    role_expires_at TIMESTAMPTZ NULL,
    last_gen_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_rba_role_check;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role_expires_at TIMESTAMPTZ NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_gen_at TIMESTAMPTZ NULL;

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

ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_required_role_check;

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

CREATE INDEX IF NOT EXISTS idx_stock_service_name_created_at
    ON public.stock (service_name, created_at ASC, id ASC);

-- ----------------------------------------------------------------------------
-- 5. License Keys Table (Redeemable Timed & Lifetime Role Keys)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.license_keys (
    key TEXT PRIMARY KEY,
    role_name TEXT NOT NULL REFERENCES public.roles(name) ON DELETE CASCADE ON UPDATE CASCADE,
    duration_seconds BIGINT NULL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    created_by TEXT NOT NULL,
    redeemed_by TEXT NULL,
    redeemed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_license_keys_unredeemed
    ON public.license_keys (key)
    WHERE redeemed_by IS NULL;

-- ----------------------------------------------------------------------------
-- 6. Blacklist & Bot Settings Tables (Moderation, Alt-Protection, & Restocks)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blacklist (
    discord_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT 'No reason provided',
    blacklisted_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.bot_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    restock_channel_id TEXT NULL,
    restock_ping_role_id TEXT NULL,
    min_account_age_days INTEGER NOT NULL DEFAULT 0 CHECK (min_account_age_days >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.bot_settings (id, min_account_age_days)
VALUES ('default', 0)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. Row Level Security (Lock out public anon key; service_role bypasses RLS)
-- ----------------------------------------------------------------------------
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.license_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blacklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 8. Atomic Account Claim & Delete RPC (Eliminates /gen Race Conditions)
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
-- 9. Aggregated Service Stock Counts RPC (Powers /stocks)
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
-- 10. Atomic License Key Redemption RPC (Prevents Concurrent Key Double-Spend)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_license_key(p_key TEXT, p_discord_id TEXT)
RETURNS TABLE (
    role_name TEXT,
    duration_seconds BIGINT,
    new_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_key RECORD;
    v_user RECORD;
    v_expires TIMESTAMPTZ;
BEGIN
    -- Atomically lock the key row if it exists and is unredeemed
    SELECT lk.key, lk.role_name, lk.duration_seconds
    INTO v_key
    FROM public.license_keys AS lk
    WHERE lk.key = p_key AND lk.redeemed_by IS NULL
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Mark key as redeemed
    UPDATE public.license_keys
    SET redeemed_by = p_discord_id,
        redeemed_at = NOW()
    WHERE key = v_key.key;

    -- Fetch existing user state to support time stacking on identical active roles
    SELECT u.rba_role, u.role_expires_at
    INTO v_user
    FROM public.users AS u
    WHERE u.discord_id = p_discord_id
    FOR UPDATE;

    IF v_key.duration_seconds IS NULL THEN
        v_expires := NULL;
    ELSIF FOUND
          AND lower(v_user.rba_role) = lower(v_key.role_name)
          AND v_user.role_expires_at IS NOT NULL
          AND v_user.role_expires_at > NOW() THEN
        v_expires := v_user.role_expires_at + make_interval(secs => v_key.duration_seconds::DOUBLE PRECISION);
    ELSE
        v_expires := NOW() + make_interval(secs => v_key.duration_seconds::DOUBLE PRECISION);
    END IF;

    INSERT INTO public.users (discord_id, rba_role, role_expires_at)
    VALUES (p_discord_id, v_key.role_name, v_expires)
    ON CONFLICT (discord_id) DO UPDATE
        SET rba_role = EXCLUDED.rba_role,
            role_expires_at = EXCLUDED.role_expires_at;

    RETURN QUERY SELECT v_key.role_name, v_key.duration_seconds, v_expires;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_license_key(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_license_key(TEXT, TEXT) TO service_role;
