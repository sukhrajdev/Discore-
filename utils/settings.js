const { successEmbed } = require('./embeds');

const DEFAULT_SETTINGS = Object.freeze({
  id: 'default',
  restock_channel_id: null,
  restock_ping_role_id: null,
  min_account_age_days: 0,
});

/**
 * Fetches global bot settings from `public.bot_settings` (with safe defaults).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function getBotSettings(supabase) {
  const { data, error } = await supabase
    .from('bot_settings')
    .select('id, restock_channel_id, restock_ping_role_id, min_account_age_days')
    .eq('id', 'default')
    .maybeSingle();

  if (error || !data) {
    return { ...DEFAULT_SETTINGS };
  }

  return {
    id: 'default',
    restock_channel_id: data.restock_channel_id ?? null,
    restock_ping_role_id: data.restock_ping_role_id ?? null,
    min_account_age_days: Number(data.min_account_age_days ?? 0),
  };
}

/**
 * Updates global bot settings in `public.bot_settings`.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Partial<{ restock_channel_id: string|null, restock_ping_role_id: string|null, min_account_age_days: number }>} patch
 */
async function updateBotSettings(supabase, patch) {
  const current = await getBotSettings(supabase);
  const next = {
    id: 'default',
    restock_channel_id:
      patch.restock_channel_id !== undefined
        ? patch.restock_channel_id
        : current.restock_channel_id,
    restock_ping_role_id:
      patch.restock_ping_role_id !== undefined
        ? patch.restock_ping_role_id
        : current.restock_ping_role_id,
    min_account_age_days:
      patch.min_account_age_days !== undefined
        ? patch.min_account_age_days
        : current.min_account_age_days,
  };

  const { error } = await supabase
    .from('bot_settings')
    .upsert(next, { onConflict: 'id' });

  if (error) throw error;
  return next;
}

/**
 * Checks whether a Discord user ID is currently in `public.blacklist`.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} discordId
 */
async function getBlacklistEntry(supabase, discordId) {
  const { data, error } = await supabase
    .from('blacklist')
    .select('discord_id, reason, blacklisted_by, created_at')
    .eq('discord_id', discordId)
    .maybeSingle();

  if (error) return null;
  return data || null;
}

/**
 * Sends a rich Restock Alert Embed to the target or configured restock channel.
 *
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {import('@supabase/supabase-js').SupabaseClient} options.supabase
 * @param {{ name: string, required_role: string, channel_id: string }} options.service
 * @param {number} options.addedCount
 * @param {number} options.totalStock
 * @param {string|null} [options.overrideChannelId]
 * @param {string|null} [options.overridePingRoleId]
 * @returns {Promise<string|null>} Channel ID where alert was posted, or null if skipped/unavailable
 */
async function sendRestockAlert({
  client,
  supabase,
  service,
  addedCount,
  totalStock,
  overrideChannelId = null,
  overridePingRoleId = null,
}) {
  if (!client || addedCount <= 0) return null;

  const settings = await getBotSettings(supabase);
  const targetChannelId = overrideChannelId || settings.restock_channel_id;
  const pingRoleId = overridePingRoleId || settings.restock_ping_role_id;

  if (!targetChannelId) return null;

  try {
    const channel = await client.channels.fetch(targetChannelId);
    if (!channel || typeof channel.send !== 'function') return null;

    const alertEmbed = successEmbed({
      title: `Restock Alert — ${service.name}`,
      description: `**+${addedCount}** fresh account(s) have been added to **${service.name}**!`,
      fields: [
        { name: 'Service', value: `\`${service.name}\``, inline: true },
        { name: 'Added', value: `\`+${addedCount}\``, inline: true },
        { name: 'Total Stock', value: `\`${totalStock}\` available`, inline: true },
        { name: 'Required Role', value: `**${service.required_role}**`, inline: true },
        { name: 'Generate In', value: `<#${service.channel_id}>`, inline: true },
      ],
      footer: `Use /gen service:${service.name} to claim an account!`,
    });

    const messagePayload = {
      embeds: [alertEmbed],
    };

    if (pingRoleId) {
      messagePayload.content = `<@&${pingRoleId}>`;
      messagePayload.allowedMentions = { roles: [pingRoleId] };
    }

    await channel.send(messagePayload);
    return targetChannelId;
  } catch (err) {
    console.warn(`[RestockAlert] Could not post alert to channel ${targetChannelId}:`, err.message);
    return null;
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  getBotSettings,
  updateBotSettings,
  getBlacklistEntry,
  sendRestockAlert,
};
