const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { ROLE_CHOICES, normalizeRole, isAdmin } = require('../../utils/rba');
const { successEmbed, warningEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setrole')
    .setDescription("[Admin] Update a user's RBA role (Free, Premium, or grant Admin)")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The Discord user whose RBA role should be updated')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('role')
        .setDescription('The RBA role to assign (including promoting another user to Admin)')
        .setRequired(true)
        .addChoices(...ROLE_CHOICES)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Enforce Admin RBA role — any existing Admin can grant Free, Premium, or Admin to another user
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

    const targetUser = interaction.options.getUser('user', true);
    const rawRole = interaction.options.getString('role', true);
    const normalizedRole = normalizeRole(rawRole);

    if (!normalizedRole) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid Role',
            description: 'Invalid RBA role specified.',
          }),
        ],
      });
    }

    if (targetUser.bot) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid Target User',
            description: 'Cannot assign RBA roles to Discord bot accounts.',
          }),
        ],
      });
    }

    // Prevent an Admin from accidentally demoting themselves and losing Admin access
    if (targetUser.id === interaction.user.id && normalizedRole !== 'Admin') {
      return interaction.editReply({
        embeds: [
          warningEmbed({
            title: 'Self-Demotion Blocked',
            description:
              'You cannot remove your own **Admin** role to prevent accidental lockout.',
          }),
        ],
      });
    }

    const { data, error } = await supabase
      .from('users')
      .upsert(
        {
          discord_id: targetUser.id,
          rba_role: normalizedRole,
        },
        { onConflict: 'discord_id' }
      )
      .select('discord_id, rba_role')
      .single();

    if (error) {
      throw error;
    }

    const isAdminPromotion = data.rba_role === 'Admin';

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: isAdminPromotion ? 'Admin Role Granted' : 'User Role Updated',
          description: isAdminPromotion
            ? `<@${data.discord_id}> has been granted the **Admin** RBA role and can now manage services, stock, and user roles.`
            : `Updated <@${data.discord_id}>'s RBA role to **${data.rba_role}**.`,
          fields: [
            { name: 'User', value: `<@${data.discord_id}>`, inline: true },
            { name: 'Assigned Role', value: `**${data.rba_role}**`, inline: true },
            { name: 'Updated By', value: `<@${interaction.user.id}>`, inline: true },
          ],
        }),
      ],
    });
  },
};
