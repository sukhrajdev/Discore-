const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const supabase = require('../../config/supabase');
const {
  getUserRoleRecord,
  getRoleByName,
  hasRequiredRole,
} = require('../../utils/rba');
const { autocompleteServiceName } = require('../../utils/autocomplete');
const { successEmbed, warningEmbed, errorEmbed } = require('../../utils/embeds');

const UNAVAILABLE_MESSAGE = 'Currently not available for you.';
const SUCCESS_CHANNEL_MESSAGE = 'Check your DMs! I have sent you the account.';

function createUnavailableReply() {
  return {
    embeds: [
      errorEmbed({
        title: 'Generation Unavailable',
        description: UNAVAILABLE_MESSAGE,
      }),
    ],
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gen')
    .setDescription('Generate an account from the requested service')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('service')
        .setDescription('The service to generate an account for (e.g., mcfa, netflix)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: autocompleteServiceName,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Public embed reply (not ephemeral) per specification
    await interaction.deferReply();

    if (!interaction.inGuild()) {
      return interaction.editReply(createUnavailableReply());
    }

    const serviceInput = interaction.options.getString('service', true).trim().toLowerCase();

    // 1 & 2. Fetch the user's RBA role record and the requested service in parallel
    const [userRoleRecord, serviceResult] = await Promise.all([
      getUserRoleRecord(supabase, interaction.user.id),
      supabase
        .from('services')
        .select('name, required_role, channel_id')
        .eq('name', serviceInput)
        .maybeSingle(),
    ]);

    if (serviceResult.error) {
      throw serviceResult.error;
    }

    const service = serviceResult.data;

    // 2. Check if the service exists in the Services table
    if (!service) {
      return interaction.editReply(createUnavailableReply());
    }

    // Resolve the service's required role (supports built-in & custom roles)
    const requiredRoleRecord = await getRoleByName(supabase, service.required_role);

    // 3. Check if the command was used in the allowed channel
    // Accepts the service's designated channel OR a custom role's dedicated channel_id if set
    const allowedChannels = new Set([service.channel_id]);
    if (userRoleRecord?.channel_id) {
      allowedChannels.add(userRoleRecord.channel_id);
    }
    if (requiredRoleRecord?.channel_id) {
      allowedChannels.add(requiredRoleRecord.channel_id);
    }

    if (!allowedChannels.has(interaction.channelId)) {
      return interaction.editReply(createUnavailableReply());
    }

    // 4. Check if the user's rba_role matches or exceeds required_role
    if (!hasRequiredRole(userRoleRecord, requiredRoleRecord || service.required_role)) {
      return interaction.editReply(createUnavailableReply());
    }

    // 6 & 7. Atomically SELECT (FOR UPDATE SKIP LOCKED) and DELETE one account row via RPC
    const { data: claimedRows, error: claimError } = await supabase.rpc(
      'claim_stock_account',
      { p_service_name: service.name }
    );

    if (claimError) {
      throw claimError;
    }

    // 5. If 0 rows returned (out of stock), reply publicly with unavailable embed
    if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
      return interaction.editReply(createUnavailableReply());
    }

    const account = claimedRows[0];

    // 8. Deliver credentials via Direct Message Embed (with compensating rollback if user has DMs disabled)
    const dmEmbed = successEmbed({
      title: `Account Generated — ${service.name}`,
      description: [
        `Congratulations you got a ${service.name} account here:`,
        `Email: ${account.email}`,
        `Pass: ${account.password}`,
      ].join('\n'),
      fields: [
        { name: 'Service', value: `\`${service.name}\``, inline: true },
        { name: 'Email', value: `\`${account.email}\``, inline: true },
        { name: 'Password', value: `\`${account.password}\``, inline: true },
      ],
      footer: 'Keep your credentials safe and do not share them publicly.',
    });

    try {
      await interaction.user.send({ embeds: [dmEmbed] });
    } catch (dmError) {
      console.warn(
        `[GEN] Could not DM user ${interaction.user.id}; rolling back claimed stock ${account.id}:`,
        dmError.message
      );

      const { error: rollbackError } = await supabase.from('stock').insert({
        id: account.id,
        service_name: account.service_name,
        email: account.email,
        password: account.password,
      });

      if (rollbackError) {
        console.error(
          `[GEN] CRITICAL: Failed to restore stock row ${account.id} after DM failure:`,
          rollbackError
        );
      }

      return interaction.editReply({
        embeds: [
          warningEmbed({
            title: 'Direct Messages Disabled',
            description:
              'Unable to send you a Direct Message! Please enable Direct Messages from server members in your privacy settings and try again.\n\n*Your claimed account has been safely returned to stock.*',
          }),
        ],
      });
    }

    // 9. Reply publicly in the channel with an embed
    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'Account Sent',
          description: SUCCESS_CHANNEL_MESSAGE,
        }),
      ],
    });
  },
};
