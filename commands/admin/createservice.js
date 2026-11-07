const {
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { ROLE_CHOICES, normalizeRole, isAdmin } = require('../../utils/rba');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('createservice')
    .setDescription('[Admin] Create a new account generator service')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Unique service name (e.g., mcfa, netflix)')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('role')
        .setDescription('Minimum RBA role required to generate this service')
        .setRequired(true)
        .addChoices(...ROLE_CHOICES)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Discord channel where this service can be generated')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Enforce Admin RBA role
    const hasAdminAccess = await isAdmin(supabase, interaction.user.id);
    if (!hasAdminAccess) {
      return interaction.editReply(
        'Access denied. You need the **Admin** RBA role to use this command.'
      );
    }

    const serviceName = interaction.options.getString('name', true).trim().toLowerCase();
    const rawRole = interaction.options.getString('role', true);
    const channel = interaction.options.getChannel('channel', true);

    if (!serviceName || !/^[a-z0-9_-]{1,50}$/.test(serviceName)) {
      return interaction.editReply(
        'Invalid service name. Use 1–50 alphanumeric characters, hyphens, or underscores (e.g., `mcfa`, `netflix`).'
      );
    }

    const requiredRole = normalizeRole(rawRole);
    if (!requiredRole) {
      return interaction.editReply('Invalid RBA role specified.');
    }

    const { data, error } = await supabase
      .from('services')
      .insert({
        name: serviceName,
        required_role: requiredRole,
        channel_id: channel.id,
      })
      .select('name, required_role, channel_id')
      .single();

    if (error) {
      // PostgreSQL unique_violation
      if (error.code === '23505') {
        return interaction.editReply(
          `A service named **${serviceName}** already exists.`
        );
      }
      throw error;
    }

    return interaction.editReply(
      `Service **${data.name}** created!\n• Required RBA Role: **${data.required_role}**\n• Generator Channel: <#${data.channel_id}>`
    );
  },
};
