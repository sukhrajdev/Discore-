const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const supabase = require('../../config/supabase');
const {
  resolveEffectiveUserState,
  getRoleByName,
  hasRequiredRole,
} = require('../../utils/rba');
const { getBotSettings, getBlacklistEntry } = require('../../utils/settings');
const { getDiscordUserCreatedTimestamp } = require('../../utils/duration');
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
    await interaction.deferReply();

    if (!interaction.inGuild()) {
      return interaction.editReply(createUnavailableReply());
    }

    const serviceInput = interaction.options.getString('service', true).trim().toLowerCase();

    // Fetch effective user state (with Discord Role Auto-Sync & subscription expiry),
    // blacklist status, bot settings, and service record in parallel
    const [userState, blacklistEntry, botSettings, serviceResult] = await Promise.all([
      resolveEffectiveUserState(supabase, interaction.user.id, interaction.member),
      getBlacklistEntry(supabase, interaction.user.id),
      getBotSettings(supabase),
      supabase
        .from('services')
        .select('name, required_role, channel_id')
        .eq('name', serviceInput)
        .maybeSingle(),
    ]);

    if (serviceResult.error) {
      throw serviceResult.error;
    }

    const userRoleRecord = userState.role;
    const isUserAdmin = userRoleRecord.name.toLowerCase() === 'admin';

    // 1. Blacklist Protection
    if (blacklistEntry && !isUserAdmin) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Access Restricted',
            description: `You are blacklisted from using the generator.\n**Reason:** ${blacklistEntry.reason}`,
          }),
        ],
      });
    }

    // 2. Alt-Account Age Protection (applies to Free tier when min_account_age_days > 0)
    if (
      botSettings.min_account_age_days > 0 &&
      userRoleRecord.name.toLowerCase() === 'free'
    ) {
      const createdMs = getDiscordUserCreatedTimestamp(interaction.user);
      if (createdMs !== null) {
        const ageDays = (Date.now() - createdMs) / 86_400_000;
        if (ageDays < botSettings.min_account_age_days) {
          return interaction.editReply({
            embeds: [
              warningEmbed({
                title: 'Account Too New',
                description: `Your Discord account must be at least **${botSettings.min_account_age_days}** day(s) old to use Free generator services.`,
              }),
            ],
          });
        }
      }
    }

    const service = serviceResult.data;

    // 3. Check if the service exists in the Services table
    if (!service) {
      return interaction.editReply(createUnavailableReply());
    }

    const requiredRoleRecord = await getRoleByName(supabase, service.required_role);

    // 4. Check if command was used in the allowed channel
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

    // 5. Check if the user's effective RBA role matches or exceeds required_role
    if (!hasRequiredRole(userRoleRecord, requiredRoleRecord || service.required_role)) {
      return interaction.editReply(createUnavailableReply());
    }

    // 6. Enforce Per-Role Cooldown (Admin has 0 cooldown)
    const cooldownSeconds = isUserAdmin
      ? 0
      : Number(userRoleRecord.cooldown_seconds ?? 0);

    if (cooldownSeconds > 0 && userState.user.last_gen_at) {
      const lastGenMs = new Date(userState.user.last_gen_at).getTime();
      const nextAllowedMs = lastGenMs + cooldownSeconds * 1000;

      if (Date.now() < nextAllowedMs) {
        const readyUnix = Math.ceil(nextAllowedMs / 1000);
        return interaction.editReply({
          embeds: [
            warningEmbed({
              title: 'Cooldown Active',
              description: `Please wait before generating another account with your **${userRoleRecord.name}** role.\nAvailable again <t:${readyUnix}:R> (<t:${readyUnix}:T>).`,
            }),
          ],
        });
      }
    }

    // 7. Atomically SELECT (FOR UPDATE SKIP LOCKED) and DELETE one account row via RPC
    const { data: claimedRows, error: claimError } = await supabase.rpc(
      'claim_stock_account',
      { p_service_name: service.name }
    );

    if (claimError) {
      throw claimError;
    }

    // 8. If 0 rows returned (out of stock), reply publicly with unavailable embed
    if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
      return interaction.editReply(createUnavailableReply());
    }

    const account = claimedRows[0];

    // 9. Deliver credentials via Direct Message Embed (with compensating rollback if DMs disabled)
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

    // 10. Record last_gen_at AFTER successful DM delivery so failed attempts don't trigger cooldown
    if (cooldownSeconds > 0) {
      await supabase
        .from('users')
        .update({ last_gen_at: new Date().toISOString() })
        .eq('discord_id', interaction.user.id);
    }

    // 11. Reply publicly in the channel with an embed
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
