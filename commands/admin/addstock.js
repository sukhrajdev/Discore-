const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { isAdmin } = require('../../utils/rba');
const { autocompleteServiceName } = require('../../utils/autocomplete');
const { sendRestockAlert } = require('../../utils/settings');
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

    // Trigger Restock Alert if a restock channel is configured in /settings
    const [{ data: svcRow }, { count: totalStock }] = await Promise.all([
      supabase
        .from('services')
        .select('name, required_role, channel_id')
        .eq('name', data.service_name)
        .maybeSingle(),
      supabase
        .from('stock')
        .select('*', { count: 'exact', head: true })
        .eq('service_name', data.service_name),
    ]);

    if (svcRow) {
      await sendRestockAlert({
        client: interaction.client,
        supabase,
        service: svcRow,
        addedCount: 1,
        totalStock: totalStock ?? 1,
      });
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
