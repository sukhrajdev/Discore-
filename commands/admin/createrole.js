const {
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const {
  DEFAULT_CUSTOM_PRIORITY,
  DEFAULT_CUSTOM_COOLDOWN,
  isValidRoleNameFormat,
  getRoleByName,
  isAdmin,
} = require('../../utils/rba');
const { formatDuration } = require('../../utils/duration');
const { successEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('createrole')
    .setDescription('[Admin] Create a custom RBA role with optional channel, cooldown, & Discord role sync')
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
    )
    .addIntegerOption((option) =>
      option
        .setName('cooldown')
        .setDescription('Optional /gen cooldown in seconds (0 = no cooldown; default 300s)')
        .setMinValue(0)
        .setMaxValue(86400)
        .setRequired(false)
    )
    .addRoleOption((option) =>
      option
        .setName('discord_role')
        .setDescription('Optional Discord server role that automatically grants this RBA role')
        .setRequired(false)
    ),

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

    const roleName = interaction.options.getString('name', true).trim();
    const channel = interaction.options.getChannel('channel', false);
    const priority =
      interaction.options.getInteger('priority', false) ?? DEFAULT_CUSTOM_PRIORITY;
    const cooldownSeconds =
      interaction.options.getInteger('cooldown', false) ?? DEFAULT_CUSTOM_COOLDOWN;
    const discordRole = interaction.options.getRole('discord_role', false);

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
        cooldown_seconds: cooldownSeconds,
        discord_role_id: discordRole ? discordRole.id : null,
        is_system: false,
      })
      .select('name, priority, channel_id, cooldown_seconds, discord_role_id')
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
          description: `Custom RBA role **${data.name}** is ready for \`/setrole\`, \`/createkey\`, and \`/createservice\`.`,
          fields: [
            { name: 'Role Name', value: `**${data.name}**`, inline: true },
            { name: 'Priority Tier', value: `\`${data.priority}\``, inline: true },
            {
              name: 'Gen Cooldown',
              value: `\`${formatDuration(data.cooldown_seconds)}\``,
              inline: true,
            },
            {
              name: 'Linked Channel',
              value: data.channel_id ? `<#${data.channel_id}>` : '*None (Service Default)*',
              inline: true,
            },
            {
              name: 'Synced Discord Role',
              value: data.discord_role_id ? `<@&${data.discord_role_id}>` : '*None*',
              inline: true,
            },
          ],
          footer: 'Tip: Run /editrole to adjust cooldown, Discord role sync, priority, or channel anytime.',
        }),
      ],
    });
  },
};
