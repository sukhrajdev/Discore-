const {
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { getRoleByName, isAdmin } = require('../../utils/rba');
const { autocompleteRoleName } = require('../../utils/autocomplete');
const { successEmbed, errorEmbed } = require('../../utils/embeds');

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
        .setDescription('Minimum RBA role required (supports built-in & custom roles)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Discord channel where this service can be generated (or inherits role channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    ),

  autocomplete: autocompleteRoleName,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Enforce Admin RBA role
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
    const rawRole = interaction.options.getString('role', true).trim();
    const explicitChannel = interaction.options.getChannel('channel', false);

    if (!serviceName || !/^[a-z0-9_-]{1,50}$/.test(serviceName)) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid Service Name',
            description:
              'Use 1–50 lowercase alphanumeric characters, hyphens, or underscores (e.g., `mcfa`, `netflix`).',
          }),
        ],
      });
    }

    const resolvedRole = await getRoleByName(supabase, rawRole);
    if (!resolvedRole) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Role Not Found',
            description: `Role \`${rawRole}\` does not exist. Create custom roles first with \`/createrole\`.`,
          }),
        ],
      });
    }

    const targetChannelId = explicitChannel?.id || resolvedRole.channel_id;
    if (!targetChannelId) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Channel Required',
            description: `Role **${resolvedRole.name}** does not have a default channel linked. Please specify the \`channel\` option.`,
          }),
        ],
      });
    }

    const { data, error } = await supabase
      .from('services')
      .insert({
        name: serviceName,
        required_role: resolvedRole.name,
        channel_id: targetChannelId,
      })
      .select('name, required_role, channel_id')
      .single();

    if (error) {
      // PostgreSQL unique_violation
      if (error.code === '23505') {
        return interaction.editReply({
          embeds: [
            errorEmbed({
              title: 'Service Already Exists',
              description: `A service named **${serviceName}** already exists. Use \`/editservice\` to modify it.`,
            }),
          ],
        });
      }
      throw error;
    }

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'Service Created',
          description: `Generator service **${data.name}** has been created.`,
          fields: [
            { name: 'Service Name', value: `\`${data.name}\``, inline: true },
            { name: 'Required RBA Role', value: `**${data.required_role}**`, inline: true },
            { name: 'Generator Channel', value: `<#${data.channel_id}>`, inline: true },
          ],
          footer: 'Tip: Run /editservice to manage settings or bulk-add stock anytime.',
        }),
      ],
    });
  },
};
