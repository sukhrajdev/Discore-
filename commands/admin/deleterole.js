const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { isAdmin, deleteRoleSafely } = require('../../utils/rba');
const { autocompleteRoleName } = require('../../utils/autocomplete');
const { successEmbed, warningEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('deleterole')
    .setDescription('[Admin] Delete a custom RBA role')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Name of the custom role to delete')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    return autocompleteRoleName(interaction, { excludeSystem: true });
  },

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

    const inputName = interaction.options.getString('name', true).trim();
    const result = await deleteRoleSafely(supabase, inputName);

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return interaction.editReply({
          embeds: [
            errorEmbed({
              title: 'Role Not Found',
              description: `Role \`${inputName}\` does not exist.`,
            }),
          ],
        });
      }

      if (result.reason === 'system_protected') {
        return interaction.editReply({
          embeds: [
            warningEmbed({
              title: 'System Role Protected',
              description: `The core **${result.role.name}** role is required by the system and cannot be deleted.`,
            }),
          ],
        });
      }
    }

    const fields = [
      { name: 'Deleted Role', value: `**${result.role.name}**`, inline: true },
      {
        name: 'Users Reset to Free',
        value: `\`${result.reassignedUsersCount}\``,
        inline: true,
      },
      {
        name: 'Services Locked to Admin',
        value:
          result.lockedServices.length > 0
            ? result.lockedServices.map((s) => `\`${s}\``).join(', ')
            : '*None*',
        inline: true,
      },
    ];

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'Role Deleted',
          description: `Role **${result.role.name}** has been permanently deleted.`,
          fields,
        }),
      ],
    });
  },
};
