/**
 * Role-Based Access (RBA) hierarchy, custom roles management, and database helpers.
 *
 * Built-in tiers:
 *   Free = 1 (system protected)
 *   Custom Roles = 25 by default (configurable 2–99)
 *   Premium = 50
 *   Admin = 100 (system protected)
 */
const DEFAULT_ROLES = Object.freeze({
  Free: Object.freeze({
    name: 'Free',
    priority: 1,
    channel_id: null,
    is_system: true,
  }),
  Premium: Object.freeze({
    name: 'Premium',
    priority: 50,
    channel_id: null,
    is_system: false,
  }),
  Admin: Object.freeze({
    name: 'Admin',
    priority: 100,
    channel_id: null,
    is_system: true,
  }),
});

const ROLE_HIERARCHY = Object.freeze({
  Free: 1,
  Premium: 50,
  Admin: 100,
});

const DEFAULT_CUSTOM_PRIORITY = 25;
const VALID_ROLES = Object.freeze(Object.keys(DEFAULT_ROLES));
const ROLE_CHOICES = Object.freeze(
  VALID_ROLES.map((role) => ({ name: role, value: role }))
);

/**
 * Validates whether a proposed role name is syntactically safe.
 * Disallows colons so component customIds (`editrole:<action>:<name>`) never collide.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidRoleNameFormat(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return /^[a-zA-Z0-9 _-]{1,32}$/.test(trimmed);
}

/**
 * Normalizes built-in role names case-insensitively ('Free', 'Premium', 'Admin'),
 * or returns null if not one of the three built-in defaults.
 *
 * @param {string} role
 * @returns {'Free' | 'Premium' | 'Admin' | null}
 */
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
 * Fetches all roles from `public.roles`, merging built-in defaults if the table
 * has not been seeded yet.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Array<{ name: string, priority: number, channel_id: string|null, is_system: boolean }>>}
 */
async function getAllRoles(supabase) {
  const roleMap = new Map();

  // Seed map with core system defaults so Free & Admin always exist
  roleMap.set('free', { ...DEFAULT_ROLES.Free });
  roleMap.set('admin', { ...DEFAULT_ROLES.Admin });

  const { data, error } = await supabase
    .from('roles')
    .select('name, priority, channel_id, is_system')
    .order('priority', { ascending: true })
    .order('name', { ascending: true });

  if (!error && Array.isArray(data) && data.length > 0) {
    for (const row of data) {
      roleMap.set(row.name.toLowerCase(), {
        name: row.name,
        priority: typeof row.priority === 'number' ? row.priority : DEFAULT_CUSTOM_PRIORITY,
        channel_id: row.channel_id ?? null,
        is_system: Boolean(row.is_system) || ['free', 'admin'].includes(row.name.toLowerCase()),
      });
    }
  } else {
    // Fallback if `roles` table hasn't been migrated yet
    roleMap.set('premium', { ...DEFAULT_ROLES.Premium });
  }

  return Array.from(roleMap.values()).sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name)
  );
}

/**
 * Resolves a single role by name (case-insensitive) from `public.roles`.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roleName
 * @returns {Promise<{ name: string, priority: number, channel_id: string|null, is_system: boolean } | null>}
 */
async function getRoleByName(supabase, roleName) {
  if (typeof roleName !== 'string' || !roleName.trim()) return null;
  const target = roleName.trim().toLowerCase();
  const roles = await getAllRoles(supabase);
  return roles.find((r) => r.name.toLowerCase() === target) || null;
}

/**
 * Evaluates whether `userRole` satisfies `requiredRole` across both built-in and custom roles:
 *   1. 'Admin' satisfies every role.
 *   2. Exact role match (case-insensitive) satisfies the requirement.
 *   3. 'Free' is satisfied by any valid role.
 *   4. Otherwise, userRole must have a strictly higher priority tier than requiredRole
 *      (so two peer custom roles at the same default priority remain isolated).
 *
 * Accepts either role objects `{ name, priority }` or role name strings.
 *
 * @param {string | { name: string, priority: number }} userRole
 * @param {string | { name: string, priority: number }} requiredRole
 * @returns {boolean}
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
 * Fetches a user's canonical role name from `users` (auto-registering with 'Free' if absent).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} discordId
 * @returns {Promise<string>}
 */
async function getOrCreateUserRole(supabase, discordId) {
  const { data, error } = await supabase
    .from('users')
    .select('rba_role')
    .eq('discord_id', discordId)
    .maybeSingle();

  if (error) throw error;

  if (data && data.rba_role) {
    const resolved = await getRoleByName(supabase, data.rba_role);
    return resolved ? resolved.name : data.rba_role;
  }

  const { error: upsertError } = await supabase
    .from('users')
    .upsert(
      { discord_id: discordId, rba_role: 'Free' },
      { onConflict: 'discord_id', ignoreDuplicates: true }
    );

  if (upsertError) throw upsertError;

  return 'Free';
}

/**
 * Fetches the full role record (`{ name, priority, channel_id, is_system }`) for a Discord user.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} discordId
 * @returns {Promise<{ name: string, priority: number, channel_id: string|null, is_system: boolean }>}
 */
async function getUserRoleRecord(supabase, discordId) {
  const roleName = await getOrCreateUserRole(supabase, discordId);
  const roleRecord = await getRoleByName(supabase, roleName);
  return roleRecord || { ...DEFAULT_ROLES.Free };
}

/**
 * Checks whether a Discord user holds the 'Admin' RBA role in Supabase.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} discordId
 * @returns {Promise<boolean>}
 */
async function isAdmin(supabase, discordId) {
  const role = await getOrCreateUserRole(supabase, discordId);
  return role.toLowerCase() === 'admin';
}

/**
 * Safely deletes a custom role:
 *   - Blocks deleting system roles ('Free', 'Admin')
 *   - Reassigns users holding the deleted role back to 'Free'
 *   - Locks any services requiring the deleted role to 'Admin' (preventing free leaks)
 *   - Deletes the role row from `public.roles`
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roleName
 */
async function deleteRoleSafely(supabase, roleName) {
  const role = await getRoleByName(supabase, roleName);
  if (!role) {
    return { ok: false, reason: 'not_found' };
  }

  if (role.is_system || ['free', 'admin'].includes(role.name.toLowerCase())) {
    return { ok: false, reason: 'system_protected', role };
  }

  // 1. Reset affected users to 'Free'
  const { data: updatedUsers, error: userErr } = await supabase
    .from('users')
    .update({ rba_role: 'Free' })
    .eq('rba_role', role.name)
    .select('discord_id');

  if (userErr) throw userErr;

  // 2. Lock affected services to 'Admin' so restricted stock is never leaked to 'Free'
  const { data: updatedServices, error: svcErr } = await supabase
    .from('services')
    .update({ required_role: 'Admin' })
    .eq('required_role', role.name)
    .select('name');

  if (svcErr) throw svcErr;

  // 3. Delete the role from `roles`
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
  VALID_ROLES,
  ROLE_CHOICES,
  isValidRoleNameFormat,
  normalizeRole,
  getAllRoles,
  getRoleByName,
  hasRequiredRole,
  getOrCreateUserRole,
  getUserRoleRecord,
  isAdmin,
  deleteRoleSafely,
};
