const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { getRoleByName, isAdmin } = require('../../utils/rba');
const { autocompleteRoleName } = require('../../utils/autocomplete');
const {
  parseDurationInput,
  formatDuration,
  generateLicenseKeyCode,
} = require('../../utils/duration');
const { successEmbed, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('createkey')
    .setDescription('[Admin] Generate 1–25 redeemable license keys for any RBA role')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('role')
        .setDescription('RBA role granted when this key is redeemed (e.g., Premium, VIP)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('Subscription duration (e.g., 1d, 7d, 30d, 12h, or lifetime)')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Number of keys to generate (1–25; default 1)')
        .setMinValue(1)
        .setMaxValue(25)
        .setRequired(false)
    ),

  autocomplete: autocompleteRoleName,

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

    const rawRole = interaction.options.getString('role', true).trim();
    const rawDuration = interaction.options.getString('duration', true).trim();
    const amount = interaction.options.getInteger('amount') ?? 1;

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

    if (resolvedRole.name.toLowerCase() === 'free') {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid Target Role',
            description: 'All users already have **Free** access by default.',
          }),
        ],
      });
    }

    const parsedDuration = parseDurationInput(rawDuration, {
      allowZero: false,
      allowLifetime: true,
    });

    if (!parsedDuration.ok) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid Duration',
            description:
              parsedDuration.error ||
              'Use formats like `12h`, `7d`, `30d`, or `lifetime`.',
          }),
        ],
      });
    }

    const generatedKeys = new Set();
    while (generatedKeys.size < amount) {
      generatedKeys.add(generateLicenseKeyCode());
    }

    const rows = Array.from(generatedKeys).map((key) => ({
      key,
      role_name: resolvedRole.name,
      duration_seconds: parsedDuration.seconds,
      created_by: interaction.user.id,
      redeemed_by: null,
      redeemed_at: null,
    }));

    const { error } = await supabase.from('license_keys').insert(rows);
    if (error) throw error;

    const keyListBlock = `\`\`\`\n${Array.from(generatedKeys).join('\n')}\n\`\`\``;

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'License Key(s) Generated',
          description: `Generated **${rows.length}** key(s) for **${resolvedRole.name}**.\n${keyListBlock}`,
          fields: [
            { name: 'Granted Role', value: `**${resolvedRole.name}**`, inline: true },
            {
              name: 'Duration',
              value: `\`${formatDuration(parsedDuration.seconds)}\``,
              inline: true,
            },
            { name: 'Quantity', value: `\`${rows.length}\``, inline: true },
          ],
          footer: 'Users can claim keys anytime via /redeem [key].',
        }),
      ],
    });
  },
};
