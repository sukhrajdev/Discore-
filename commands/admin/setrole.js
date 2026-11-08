const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { getRoleByName, isAdmin } = require('../../utils/rba');
const { autocompleteRoleName } = require('../../utils/autocomplete');
const { successEmbed, warningEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setrole')
    .setDescription("[Admin] Update a user's RBA role (built-in, custom role, or grant Admin)")
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
        .setDescription('The RBA role to assign (supports custom roles & promoting to Admin)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: autocompleteRoleName,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Enforce Admin RBA role — any existing Admin can grant Free, Premium, custom roles, or Admin
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
    const rawRole = interaction.options.getString('role', true).trim();
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
    if (
      targetUser.id === interaction.user.id &&
      resolvedRole.name.toLowerCase() !== 'admin'
    ) {
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
          rba_role: resolvedRole.name,
        },
        { onConflict: 'discord_id' }
      )
      .select('discord_id, rba_role')
      .single();

    if (error) {
      throw error;
    }

    const isAdminPromotion = data.rba_role.toLowerCase() === 'admin';

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: isAdminPromotion ? 'Admin Role Granted' : 'User Role Updated',
          description: isAdminPromotion
            ? `<@${data.discord_id}> has been granted the **Admin** RBA role and can now manage roles, services, stock, and users.`
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
