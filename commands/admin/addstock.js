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
    .setName('addstock')
    .setDescription('[Admin] Add an account to the Stock table for a service')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('service')
        .setDescription('Target service name (e.g., mcfa, netflix)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName('email')
        .setDescription('Account email or username')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('password')
        .setDescription('Account password')
        .setRequired(true)
    ),

  autocomplete: autocompleteServiceName,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Ephemeral embed reply ensures credentials/admin confirmations never leak to public chat
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Enforce Admin RBA role
    const hasAdminAccess = await isAdmin(supabase, interaction.user.id);
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

    const serviceName = interaction.options.getString('service', true).trim().toLowerCase();
    const email = interaction.options.getString('email', true).trim();
    const password = interaction.options.getString('password', true);

    if (!email || !password) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid Credentials',
            description: 'Both `email` and `password` must be non-empty.',
          }),
        ],
      });
    }

    const { data, error } = await supabase
      .from('stock')
      .insert({
        service_name: serviceName,
        email,
        password,
      })
      .select('id, service_name')
      .single();

    if (error) {
      // PostgreSQL foreign_key_violation (service_name not in `services`)
      if (error.code === '23503') {
        return interaction.editReply({
          embeds: [
            errorEmbed({
              title: 'Service Not Found',
              description: `Service **${serviceName}** does not exist. Create it first using \`/createservice\`.`,
            }),
          ],
        });
      }
      throw error;
    }

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'Stock Added',
          description: `Successfully added 1 account to **${data.service_name}** stock.`,
          fields: [
            { name: 'Service', value: `\`${data.service_name}\``, inline: true },
            { name: 'Stock ID', value: `\`${data.id}\``, inline: true },
          ],
        }),
      ],
    });
  },
};
