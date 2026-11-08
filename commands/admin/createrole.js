const {
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const {
  DEFAULT_CUSTOM_PRIORITY,
  isValidRoleNameFormat,
  getRoleByName,
  isAdmin,
} = require('../../utils/rba');
const { successEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('createrole')
    .setDescription('[Admin] Create a custom RBA role with an optional dedicated channel')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Custom role name (e.g., VIP, Booster, Gold)')
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Optional Discord channel dedicated to this role')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName('priority')
        .setDescription('Optional tier priority (2–99; Free=1, Default=25, Premium=50, Admin=100)')
        .setMinValue(2)
        .setMaxValue(99)
        .setRequired(false)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    const roleName = interaction.options.getString('name', true).trim();
    const channel = interaction.options.getChannel('channel', false);
    const priority =
      interaction.options.getInteger('priority', false) ?? DEFAULT_CUSTOM_PRIORITY;

    if (!isValidRoleNameFormat(roleName)) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid Role Name',
            description:
              'Use 1–32 characters containing letters, numbers, spaces, hyphens, or underscores (e.g., `VIP`, `Booster`).',
          }),
        ],
      });
    }

    // Case-insensitive duplicate check (prevents 'vip' vs 'VIP' or duplicating 'Admin')
    const existingRole = await getRoleByName(supabase, roleName);
    if (existingRole) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Role Already Exists',
            description: `An RBA role named **${existingRole.name}** already exists. Use \`/editrole\` to modify it.`,
          }),
        ],
      });
    }

    const { data, error } = await supabase
      .from('roles')
      .insert({
        name: roleName,
        priority,
        channel_id: channel ? channel.id : null,
        is_system: false,
      })
      .select('name, priority, channel_id')
      .single();

    if (error) {
      if (error.code === '23505') {
        return interaction.editReply({
          embeds: [
            errorEmbed({
              title: 'Role Already Exists',
              description: `An RBA role named **${roleName}** already exists.`,
            }),
          ],
        });
      }
      throw error;
    }

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'Custom Role Created',
          description: `Custom RBA role **${data.name}** is now ready for use with \`/setrole\` and \`/createservice\`.`,
          fields: [
            { name: 'Role Name', value: `**${data.name}**`, inline: true },
            { name: 'Priority Tier', value: `\`${data.priority}\``, inline: true },
            {
              name: 'Linked Channel',
              value: data.channel_id ? `<#${data.channel_id}>` : '*None (Service Default)*',
              inline: true,
            },
          ],
          footer: 'Tip: Run /editrole to adjust name, priority, or channel anytime.',
        }),
      ],
    });
  },
};
