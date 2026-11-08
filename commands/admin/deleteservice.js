const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { isAdmin } = require('../../utils/rba');
const { autocompleteServiceName } = require('../../utils/autocomplete');
const { successEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('deleteservice')
    .setDescription('[Admin] Delete an existing generator service and its remaining stock')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Name of the service to delete (e.g., mcfa, netflix)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: autocompleteServiceName,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const hasAdminAccess = await isAdmin(
      supabase,
      interaction.user.id,
      interaction.member
    );
    if (!hasAdminAccess) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Access Denied',
            description: 'You need the **Admin** RBA role to use this command.',
          }),
        ],
      });
    }

    const serviceName = interaction.options.getString('name', true).trim().toLowerCase();

    const { data: existing, error: findErr } = await supabase
      .from('services')
      .select('name')
      .eq('name', serviceName)
      .maybeSingle();

    if (findErr) throw findErr;

    if (!existing) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Service Not Found',
            description: `Service \`${serviceName}\` does not exist.`,
          }),
        ],
      });
    }

    const { count: stockRemoved } = await supabase
      .from('stock')
      .select('*', { count: 'exact', head: true })
      .eq('service_name', existing.name);

    await supabase.from('stock').delete().eq('service_name', existing.name);
    const { error: deleteErr } = await supabase
      .from('services')
      .delete()
      .eq('name', existing.name);

    if (deleteErr) throw deleteErr;

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'Service Deleted',
          description: `Service **${existing.name}** has been permanently deleted.`,
          fields: [
            { name: 'Deleted Service', value: `\`${existing.name}\``, inline: true },
            {
              name: 'Stock Removed',
              value: `\`${stockRemoved ?? 0}\` account(s)`,
              inline: true,
            },
          ],
        }),
      ],
    });
  },
};
