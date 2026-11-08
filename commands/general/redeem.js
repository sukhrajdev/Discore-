const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { getBlacklistEntry } = require('../../utils/settings');
const { formatDuration } = require('../../utils/duration');
const { successEmbed, errorEmbed } = require('../../utils/embeds');

/**
 * Redeems a license key via the atomic `redeem_license_key` RPC, with a safe
 * fallback if the RPC hasn't been deployed yet.
 */
async function claimLicenseKeyAtomically(keyCode, discordId) {
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    'redeem_license_key',
    {
      p_key: keyCode,
      p_discord_id: discordId,
    }
  );

  if (!rpcError && Array.isArray(rpcRows)) {
    if (rpcRows.length === 0) return null;
    return {
      role_name: rpcRows[0].role_name,
      duration_seconds:
        rpcRows[0].duration_seconds !== null
          ? Number(rpcRows[0].duration_seconds)
          : null,
      new_expires_at: rpcRows[0].new_expires_at || null,
    };
  }

  // Fallback path if RPC is not available
  const { data: keyRow, error: keyErr } = await supabase
    .from('license_keys')
    .select('key, role_name, duration_seconds, redeemed_by')
    .eq('key', keyCode)
    .maybeSingle();

  if (keyErr) throw keyErr;
  if (!keyRow || keyRow.redeemed_by) return null;

  const { data: existingUser } = await supabase
    .from('users')
    .select('rba_role, role_expires_at')
    .eq('discord_id', discordId)
    .maybeSingle();

  let newExpiresAt = null;
  if (keyRow.duration_seconds !== null && keyRow.duration_seconds !== undefined) {
    const nowMs = Date.now();
    const currentExpiryMs =
      existingUser &&
      existingUser.rba_role &&
      existingUser.rba_role.toLowerCase() === keyRow.role_name.toLowerCase() &&
      existingUser.role_expires_at
        ? new Date(existingUser.role_expires_at).getTime()
        : 0;

    const baseMs = Math.max(nowMs, currentExpiryMs);
    newExpiresAt = new Date(baseMs + Number(keyRow.duration_seconds) * 1000).toISOString();
  }

  const { error: markErr } = await supabase
    .from('license_keys')
    .update({
      redeemed_by: discordId,
      redeemed_at: new Date().toISOString(),
    })
    .eq('key', keyCode);
  if (markErr) throw markErr;

  const { error: userErr } = await supabase
    .from('users')
    .upsert(
      {
        discord_id: discordId,
        rba_role: keyRow.role_name,
        role_expires_at: newExpiresAt,
      },
      { onConflict: 'discord_id' }
    );
  if (userErr) throw userErr;

  return {
    role_name: keyRow.role_name,
    duration_seconds: keyRow.duration_seconds,
    new_expires_at: newExpiresAt,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('redeem')
    .setDescription('Redeem a license key to unlock an RBA role subscription')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('key')
        .setDescription('Your license key (e.g., DISC-XXXX-XXXX-XXXX)')
        .setRequired(true)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Ephemeral so license keys are never exposed in public chat
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const blacklistEntry = await getBlacklistEntry(supabase, interaction.user.id);
    if (blacklistEntry) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Account Blacklisted',
            description: `You are restricted from redeeming keys.\n**Reason:** ${blacklistEntry.reason}`,
          }),
        ],
      });
    }

    const keyCode = interaction.options.getString('key', true).trim().toUpperCase();
    const claimed = await claimLicenseKeyAtomically(keyCode, interaction.user.id);

    if (!claimed) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid or Already Redeemed Key',
            description:
              'That license key does not exist or has already been claimed.',
          }),
        ],
      });
    }

    const expiryUnix = claimed.new_expires_at
      ? Math.floor(new Date(claimed.new_expires_at).getTime() / 1000)
      : null;

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: 'License Key Redeemed!',
          description: `Congratulations! Your account has been upgraded to **${claimed.role_name}**.`,
          fields: [
            { name: 'Unlocked Role', value: `**${claimed.role_name}**`, inline: true },
            {
              name: 'Key Duration',
              value: `\`${formatDuration(claimed.duration_seconds)}\``,
              inline: true,
            },
            {
              name: 'Expires',
              value: expiryUnix
                ? `<t:${expiryUnix}:F> (<t:${expiryUnix}:R>)`
                : '`Never (Lifetime)`',
              inline: false,
            },
          ],
        }),
      ],
    });
  },
};
