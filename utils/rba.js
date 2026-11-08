/**
 * Role-Based Access (RBA) hierarchy, custom roles, cooldowns, Discord role auto-sync,
 * and timed subscription expiration helpers.
 */
const DEFAULT_ROLES = Object.freeze({
  Free: Object.freeze({
    name: 'Free',
    priority: 1,
    channel_id: null,
    cooldown_seconds: 1800,
    discord_role_id: null,
    is_system: true,
  }),
  Premium: Object.freeze({
    name: 'Premium',
    priority: 50,
    channel_id: null,
    cooldown_seconds: 300,
    discord_role_id: null,
    is_system: false,
  }),
  Admin: Object.freeze({
    name: 'Admin',
    priority: 100,
    channel_id: null,
    cooldown_seconds: 0,
    discord_role_id: null,
    is_system: true,
  }),
});

const ROLE_HIERARCHY = Object.freeze({
  Free: 1,
  Premium: 50,
  Admin: 100,
});

const DEFAULT_CUSTOM_PRIORITY = 25;
const DEFAULT_CUSTOM_COOLDOWN = 300;
const VALID_ROLES = Object.freeze(Object.keys(DEFAULT_ROLES));
const ROLE_CHOICES = Object.freeze(
  VALID_ROLES.map((role) => ({ name: role, value: role }))
);

function isValidRoleNameFormat(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return /^[a-zA-Z0-9 _-]{1,32}$/.test(trimmed);
}

function normalizeRole(role) {
  if (typeof role !== 'string') return null;
  const trimmed = role.trim().toLowerCase();
  for (const validRole of VALID_ROLES) {
    if (validRole.toLowerCase() === trimmed) {
      return validRole;
    }
  }
  return null;
}

/**
 * Extracts a Set of Discord Role Snowflake IDs from a GuildMember or raw API member object.
 *
 * @param {any} member
 * @returns {Set<string>}
 */
function extractMemberDiscordRoleIds(member) {
  const roleIds = new Set();
  if (!member || !member.roles) return roleIds;

  // Discord.js GuildMemberRoleManager (`member.roles.cache` Collection/Map)
  if (member.roles.cache && typeof member.roles.cache.keys === 'function') {
    for (const id of member.roles.cache.keys()) {
      roleIds.add(String(id));
    }
    return roleIds;
  }

  // Raw API interaction member (`member.roles` string[])
  if (Array.isArray(member.roles)) {
    for (const id of member.roles) {
      roleIds.add(String(id));
    }
  }

  return roleIds;
}

/**
 * Fetches all roles from `public.roles`, merging built-in defaults if unseeded.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function getAllRoles(supabase) {
  const roleMap = new Map();

  roleMap.set('free', { ...DEFAULT_ROLES.Free });
  roleMap.set('admin', { ...DEFAULT_ROLES.Admin });

  const { data, error } = await supabase
    .from('roles')
    .select('name, priority, channel_id, cooldown_seconds, discord_role_id, is_system')
    .order('priority', { ascending: true })
    .order('name', { ascending: true });

  if (!error && Array.isArray(data) && data.length > 0) {
    for (const row of data) {
      const lower = row.name.toLowerCase();
      const defaultCooldown =
        lower === 'admin'
          ? 0
          : lower === 'free'
          ? 1800
          : DEFAULT_CUSTOM_COOLDOWN;

      roleMap.set(lower, {
        name: row.name,
        priority: typeof row.priority === 'number' ? row.priority : DEFAULT_CUSTOM_PRIORITY,
        channel_id: row.channel_id ?? null,
        cooldown_seconds:
          typeof row.cooldown_seconds === 'number'
            ? row.cooldown_seconds
            : defaultCooldown,
        discord_role_id: row.discord_role_id ?? null,
        is_system: Boolean(row.is_system) || ['free', 'admin'].includes(lower),
      });
    }
  } else {
    roleMap.set('premium', { ...DEFAULT_ROLES.Premium });
  }

  return Array.from(roleMap.values()).sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name)
  );
}

/**
 * Resolves a single role by name (case-insensitive) from `public.roles`.
 */
async function getRoleByName(supabase, roleName) {
  if (typeof roleName !== 'string' || !roleName.trim()) return null;
  const target = roleName.trim().toLowerCase();
  const roles = await getAllRoles(supabase);
  return roles.find((r) => r.name.toLowerCase() === target) || null;
}

/**
 * Evaluates whether `userRole` satisfies `requiredRole` across built-in & custom roles.
 */
function hasRequiredRole(userRole, requiredRole) {
  const resolveObj = (input) => {
    if (!input) return null;
    if (typeof input === 'object' && typeof input.name === 'string') {
      return {
        name: input.name,
        priority: typeof input.priority === 'number' ? input.priority : DEFAULT_CUSTOM_PRIORITY,
      };
    }
    if (typeof input === 'string') {
      const builtin = normalizeRole(input);
      if (builtin) return DEFAULT_ROLES[builtin];
      return null;
    }
    return null;
  };

  const userObj = resolveObj(userRole);
  const reqObj = resolveObj(requiredRole);

  if (!userObj || !reqObj) return false;

  const userLower = userObj.name.toLowerCase();
  const reqLower = reqObj.name.toLowerCase();

  if (userLower === 'admin') return true;
  if (userLower === reqLower) return true;
  if (reqLower === 'free') return true;

  return userObj.priority > reqObj.priority;
}

/**
 * Fetches (or initializes) a user's database record, automatically expiring timed
 * subscriptions whose `role_expires_at` timestamp has passed, and combines it with
 * Discord Server Role Auto-Sync (`roles.discord_role_id`) to determine their effective role.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} discordId
 * @param {any} [member] Optional Discord GuildMember / raw interaction.member for role sync
 */
async function resolveEffectiveUserState(supabase, discordId, member = null) {
  const [allRoles, userQuery] = await Promise.all([
    getAllRoles(supabase),
    supabase
      .from('users')
      .select('discord_id, rba_role, role_expires_at, last_gen_at')
      .eq('discord_id', discordId)
      .maybeSingle(),
  ]);

  if (userQuery.error) throw userQuery.error;

  let userRow = userQuery.data;

  if (!userRow) {
    const { error: upsertError } = await supabase
      .from('users')
      .upsert(
        { discord_id: discordId, rba_role: 'Free' },
        { onConflict: 'discord_id', ignoreDuplicates: true }
      );
    if (upsertError) throw upsertError;

    userRow = {
      discord_id: discordId,
      rba_role: 'Free',
      role_expires_at: null,
      last_gen_at: null,
    };
  }

  // Automatic timed subscription expiration check
  if (
    userRow.role_expires_at &&
    new Date(userRow.role_expires_at).getTime() <= Date.now()
  ) {
    await supabase
      .from('users')
      .update({ rba_role: 'Free', role_expires_at: null })
      .eq('discord_id', discordId);

    userRow = {
      ...userRow,
      rba_role: 'Free',
      role_expires_at: null,
    };
  }

  const findRole = (name) =>
    allRoles.find((r) => r.name.toLowerCase() === String(name || 'Free').toLowerCase());

  const dbRole = findRole(userRow.rba_role) || { ...DEFAULT_ROLES.Free };

  // Discord Server Role Auto-Sync: check if member holds any linked Discord server role
  const memberDiscordRoleIds = extractMemberDiscordRoleIds(member);
  let effectiveRole = dbRole;
  let syncedFromDiscordRole = false;

  if (memberDiscordRoleIds.size > 0) {
    for (const candidateRole of allRoles) {
      if (
        candidateRole.discord_role_id &&
        memberDiscordRoleIds.has(String(candidateRole.discord_role_id)) &&
        candidateRole.priority > effectiveRole.priority
      ) {
        effectiveRole = candidateRole;
        syncedFromDiscordRole = true;
      }
    }
  }

  return {
    user: userRow,
    dbRole,
    role: effectiveRole,
    syncedFromDiscordRole,
  };
}

/**
 * Fetches a user's effective canonical role name (including expiry & Discord Role Auto-Sync).
 */
async function getOrCreateUserRole(supabase, discordId, member = null) {
  const state = await resolveEffectiveUserState(supabase, discordId, member);
  return state.role.name;
}

/**
 * Fetches the effective role record for a Discord user.
 */
async function getUserRoleRecord(supabase, discordId, member = null) {
  const state = await resolveEffectiveUserState(supabase, discordId, member);
  return state.role;
}

/**
 * Checks whether a Discord user holds the 'Admin' RBA role (via DB or synced Discord Role).
 */
async function isAdmin(supabase, discordId, member = null) {
  const roleName = await getOrCreateUserRole(supabase, discordId, member);
  return roleName.toLowerCase() === 'admin';
}

/**
 * Safely deletes a custom role, resetting assigned users to 'Free' and locking dependent services to 'Admin'.
 */
async function deleteRoleSafely(supabase, roleName) {
  const role = await getRoleByName(supabase, roleName);
  if (!role) {
    return { ok: false, reason: 'not_found' };
  }

  if (role.is_system || ['free', 'admin'].includes(role.name.toLowerCase())) {
    return { ok: false, reason: 'system_protected', role };
  }

  const { data: updatedUsers, error: userErr } = await supabase
    .from('users')
    .update({ rba_role: 'Free', role_expires_at: null })
    .eq('rba_role', role.name)
    .select('discord_id');

  if (userErr) throw userErr;

  const { data: updatedServices, error: svcErr } = await supabase
    .from('services')
    .update({ required_role: 'Admin' })
    .eq('required_role', role.name)
    .select('name');

  if (svcErr) throw svcErr;

  const { error: deleteErr } = await supabase
    .from('roles')
    .delete()
    .eq('name', role.name);

  if (deleteErr) throw deleteErr;

  return {
    ok: true,
    role,
    reassignedUsersCount: Array.isArray(updatedUsers) ? updatedUsers.length : 0,
    lockedServices: Array.isArray(updatedServices)
      ? updatedServices.map((s) => s.name)
      : [],
  };
}

module.exports = {
  DEFAULT_ROLES,
  ROLE_HIERARCHY,
  DEFAULT_CUSTOM_PRIORITY,
  DEFAULT_CUSTOM_COOLDOWN,
  VALID_ROLES,
  ROLE_CHOICES,
  isValidRoleNameFormat,
  normalizeRole,
  extractMemberDiscordRoleIds,
  getAllRoles,
  getRoleByName,
  hasRequiredRole,
  resolveEffectiveUserState,
  getOrCreateUserRole,
  getUserRoleRecord,
  isAdmin,
  deleteRoleSafely,
};
