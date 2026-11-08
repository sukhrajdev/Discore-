const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { isAdmin } = require('../../utils/rba');
const { infoEmbed, successEmbed, warningEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('[Admin] Manage generator blacklist (add, remove, or list blocked users)')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Block a user from generating accounts and redeeming keys')
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('Discord user to blacklist')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('reason')
            .setDescription('Reason for blacklisting this user')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a user from the blacklist')
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('Discord user to unblacklist')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List all currently blacklisted users')
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

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const targetUser = interaction.options.getUser('user', true);
      const reason =
        interaction.options.getString('reason')?.trim() || 'No reason provided';

      if (targetUser.id === interaction.user.id) {
        return interaction.editReply({
          embeds: [
            warningEmbed({
              title: 'Invalid Action',
              description: 'You cannot blacklist yourself.',
            }),
          ],
        });
      }

      const targetIsAdmin = await isAdmin(supabase, targetUser.id);
      if (targetIsAdmin) {
        return interaction.editReply({
          embeds: [
            warningEmbed({
              title: 'Cannot Blacklist Admin',
              description: `<@${targetUser.id}> holds the **Admin** role and cannot be blacklisted.`,
            }),
          ],
        });
      }

      const { error } = await supabase.from('blacklist').upsert(
        {
          discord_id: targetUser.id,
          reason,
          blacklisted_by: interaction.user.id,
        },
        { onConflict: 'discord_id' }
      );
      if (error) throw error;

      return interaction.editReply({
        embeds: [
          successEmbed({
            title: 'User Blacklisted',
            description: `<@${targetUser.id}> has been blocked from using the generator.`,
            fields: [
              { name: 'User', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
              { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Reason', value: reason, inline: false },
            ],
          }),
        ],
      });
    }

    if (subcommand === 'remove') {
      const targetUser = interaction.options.getUser('user', true);

      const { data: existing } = await supabase
        .from('blacklist')
        .select('discord_id')
        .eq('discord_id', targetUser.id)
        .maybeSingle();

      if (!existing) {
        return interaction.editReply({
          embeds: [
            warningEmbed({
              title: 'Not Blacklisted',
              description: `<@${targetUser.id}> is not currently on the blacklist.`,
            }),
          ],
        });
      }

      const { error } = await supabase
        .from('blacklist')
        .delete()
        .eq('discord_id', targetUser.id);
      if (error) throw error;

      return interaction.editReply({
        embeds: [
          successEmbed({
            title: 'User Unblacklisted',
            description: `<@${targetUser.id}> has been removed from the blacklist and can generate accounts again.`,
          }),
        ],
      });
    }

    if (subcommand === 'list') {
      const { data: entries, error } = await supabase
        .from('blacklist')
        .select('discord_id, reason, blacklisted_by, created_at')
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (!Array.isArray(entries) || entries.length === 0) {
        return interaction.editReply({
          embeds: [
            infoEmbed({
              title: 'Generator Blacklist',
              description: 'No users are currently blacklisted.',
            }),
          ],
        });
      }

      const lines = entries.slice(0, 25).map(
        (entry) =>
          `• <@${entry.discord_id}> (\`${entry.discord_id}\`) — *${entry.reason}*`
      );

      return interaction.editReply({
        embeds: [
          infoEmbed({
            title: 'Generator Blacklist',
            description: lines.join('\n'),
            fields: [
              { name: 'Total Blacklisted', value: `\`${entries.length}\``, inline: true },
            ],
          }),
        ],
      });
    }
  },
};
