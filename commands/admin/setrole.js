const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { ROLE_CHOICES, normalizeRole, isAdmin } = require('../../utils/rba');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setrole')
    .setDescription("[Admin] Update a user's RBA role in the Users table")
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
        .setDescription('The RBA role to assign')
        .setRequired(true)
        .addChoices(...ROLE_CHOICES)
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

    const targetUser = interaction.options.getUser('user', true);
    const rawRole = interaction.options.getString('role', true);
    const normalizedRole = normalizeRole(rawRole);

    if (!normalizedRole) {
      return interaction.editReply('Invalid RBA role specified.');
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

    return interaction.editReply(
      `Updated <@${data.discord_id}>'s RBA role to **${data.rba_role}**.`
    );
  },
};
