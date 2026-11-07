/**
 * Role-Based Access (RBA) hierarchy and database role helpers.
 * Higher numeric weight = greater privilege.
 */
const ROLE_HIERARCHY = Object.freeze({
  Free: 1,
  Premium: 2,
  Admin: 3,
});

const VALID_ROLES = Object.freeze(Object.keys(ROLE_HIERARCHY));

const ROLE_CHOICES = Object.freeze(
  VALID_ROLES.map((role) => ({ name: role, value: role }))
);

/**
 * Normalizes a role string case-insensitively to its canonical name
 * ('Free', 'Premium', or 'Admin'), or returns null if invalid.
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
 * Checks whether a user's RBA role meets or exceeds a service's required_role.
 * Fails closed (returns false) if either role is unrecognized.
 *
 * @param {string} userRole
 * @param {string} requiredRole
 * @returns {boolean}
 */
function hasRequiredRole(userRole, requiredRole) {
  const normalizedUserRole = normalizeRole(userRole);
  const normalizedRequiredRole = normalizeRole(requiredRole);

  if (!normalizedUserRole || !normalizedRequiredRole) {
    return false;
  }

  return ROLE_HIERARCHY[normalizedUserRole] >= ROLE_HIERARCHY[normalizedRequiredRole];
}

/**
 * Fetches a user's rba_role from the `users` table.
 * If the user does not exist yet, registers them with the default 'Free' role
 * (using ignoreDuplicates so concurrent inserts never overwrite an upgraded role).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} discordId
 * @returns {Promise<'Free' | 'Premium' | 'Admin'>}
 */
async function getOrCreateUserRole(supabase, discordId) {
  const { data, error } = await supabase
    .from('users')
    .select('rba_role')
    .eq('discord_id', discordId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data && data.rba_role) {
    return normalizeRole(data.rba_role) || 'Free';
  }

  // Register first-time user with default 'Free' role without clobbering concurrent updates
  const { error: upsertError } = await supabase
    .from('users')
    .upsert(
      { discord_id: discordId, rba_role: 'Free' },
      { onConflict: 'discord_id', ignoreDuplicates: true }
    );

  if (upsertError) {
    throw upsertError;
  }

  return 'Free';
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
  return role === 'Admin';
}

module.exports = {
  ROLE_HIERARCHY,
  VALID_ROLES,
  ROLE_CHOICES,
  normalizeRole,
  hasRequiredRole,
  getOrCreateUserRole,
  isAdmin,
};
