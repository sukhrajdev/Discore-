const supabase = require('../config/supabase');

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

module.exports = {
  autocompleteServiceName,
};
