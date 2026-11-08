const supabase = require('../config/supabase');
const { getAllRoles } = require('./rba');

/**
 * Shared autocomplete responder for the `service` string option.
 * Suggests up to 25 matching service names from the `services` table.
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
async function autocompleteServiceName(interaction) {
  try {
    const focusedValue = interaction.options.getFocused().trim().toLowerCase();

    let query = supabase
      .from('services')
      .select('name')
      .order('name', { ascending: true })
      .limit(25);

    if (focusedValue.length > 0) {
      query = query.ilike('name', `%${focusedValue}%`);
    }

    const { data, error } = await query;
    if (error || !Array.isArray(data)) {
      await interaction.respond([]);
      return;
    }

    await interaction.respond(
      data.map((service) => ({
        name: service.name,
        value: service.name,
      }))
    );
  } catch {
    // Autocomplete failures should never crash the bot process
  }
}

/**
 * Shared autocomplete responder for RBA role options (including custom roles).
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {{ excludeSystem?: boolean }} [options]
 */
async function autocompleteRoleName(interaction, { excludeSystem = false } = {}) {
  try {
    const focusedValue = interaction.options.getFocused().trim().toLowerCase();
    let roles = await getAllRoles(supabase);

    if (excludeSystem) {
      roles = roles.filter((r) => !r.is_system);
    }

    if (focusedValue.length > 0) {
      roles = roles.filter((r) => r.name.toLowerCase().includes(focusedValue));
    }

    await interaction.respond(
      roles.slice(0, 25).map((r) => ({
        name: `${r.name} (Priority: ${r.priority}${r.channel_id ? ' • Channel Linked' : ''})`,
        value: r.name,
      }))
    );
  } catch {
    // Autocomplete failures should never crash the bot process
  }
}

module.exports = {
  autocompleteServiceName,
  autocompleteRoleName,
};
