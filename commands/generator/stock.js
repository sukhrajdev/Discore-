const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const supabase = require('../../config/supabase');
const { autocompleteServiceName } = require('../../utils/autocomplete');
const { EMBED_COLORS, buildEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Check the remaining account stock for a specific service')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('service')
        .setDescription('Service name (e.g., mcfa, netflix)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: autocompleteServiceName,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    const serviceName = interaction.options.getString('service', true).trim().toLowerCase();

    // Verify service existence and perform a zero-payload exact HEAD count on `stock`
    const [serviceResult, countResult] = await Promise.all([
      supabase
        .from('services')
        .select('name')
        .eq('name', serviceName)
        .maybeSingle(),
      supabase
        .from('stock')
        .select('*', { count: 'exact', head: true })
        .eq('service_name', serviceName),
    ]);

    if (serviceResult.error) throw serviceResult.error;
    if (countResult.error) throw countResult.error;

    if (!serviceResult.data) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Service Not Found',
            description: `Service \`${serviceName}\` does not exist.`,
          }),
        ],
      });
    }

    const remainingStock = countResult.count ?? 0;
    const canonicalName = serviceResult.data.name;

    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: `Stock Status — ${canonicalName}`,
          description: `There are currently ${remainingStock} accounts in stock for ${canonicalName}.`,
          color: remainingStock > 0 ? EMBED_COLORS.SUCCESS : EMBED_COLORS.WARNING,
          fields: [
            { name: 'Service', value: `\`${canonicalName}\``, inline: true },
            { name: 'Accounts Remaining', value: `\`${remainingStock}\``, inline: true },
          ],
        }),
      ],
    });
  },
};
