const {
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { isAdmin } = require('../../utils/rba');
const { autocompleteServiceName } = require('../../utils/autocomplete');
const { sendRestockAlert } = require('../../utils/settings');
const { successEmbed, warningEmbed, errorEmbed } = require('../../utils/embeds');

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB safety cap
const INSERT_BATCH_SIZE = 500;

let attachmentDownloader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment (HTTP ${response.status})`);
  }
  return response.text();
};

/**
 * Allows injecting a mock attachment fetcher during automated tests.
 */
function setAttachmentDownloader(customFn) {
  attachmentDownloader = customFn;
}

/**
 * Parses `email:password` lines from raw `.txt` content, skipping blank lines
 * and `#` comments, and deduplicating entries within the file.
 *
 * @param {string} rawText
 */
function parseStockTextContent(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const uniqueCombos = new Set();
  const parsed = [];
  let invalidCount = 0;
  let duplicateInFileCount = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0 || colonIdx === trimmed.length - 1) {
      invalidCount++;
      continue;
    }

    const email = trimmed.slice(0, colonIdx).trim();
    const password = trimmed.slice(colonIdx + 1);

    if (!email || !password) {
      invalidCount++;
      continue;
    }

    const comboKey = `${email.toLowerCase()}:${password}`;
    if (uniqueCombos.has(comboKey)) {
      duplicateInFileCount++;
      continue;
    }

    uniqueCombos.add(comboKey);
    parsed.push({ email, password });
  }

  return { parsed, invalidCount, duplicateInFileCount };
}

module.exports = {
  setAttachmentDownloader,
  parseStockTextContent,

  data: new SlashCommandBuilder()
    .setName('restock')
    .setDescription('[Admin] Bulk restock a service from a .txt file (email:password per line)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('service')
        .setDescription('Target generator service name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addAttachmentOption((option) =>
      option
        .setName('file')
        .setDescription('.txt file containing email:password accounts (1 per line)')
        .setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName('announce')
        .setDescription('Post a Restock Alert embed in the restock channel (default: true)')
        .setRequired(false)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Optional override channel for this Restock Alert')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    )
    .addRoleOption((option) =>
      option
        .setName('ping_role')
        .setDescription('Optional override Discord role to ping for this Restock Alert')
        .setRequired(false)
    ),

  autocomplete: autocompleteServiceName,

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

    const serviceName = interaction.options.getString('service', true).trim().toLowerCase();
    const attachment = interaction.options.getAttachment('file', true);
    const shouldAnnounce = interaction.options.getBoolean('announce') ?? true;
    const overrideChannel = interaction.options.getChannel('channel', false);
    const overridePingRole = interaction.options.getRole('ping_role', false);

    // 1. Validate service exists
    const { data: service, error: svcErr } = await supabase
      .from('services')
      .select('name, required_role, channel_id')
      .eq('name', serviceName)
      .maybeSingle();

    if (svcErr) throw svcErr;
    if (!service) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Service Not Found',
            description: `Service \`${serviceName}\` does not exist. Create it first with \`/createservice\`.`,
          }),
        ],
      });
    }

    // 2. Validate attachment type & size
    const fileName = String(attachment.name || '').toLowerCase();
    const contentType = String(attachment.contentType || '').toLowerCase();

    if (
      !fileName.endsWith('.txt') &&
      contentType &&
      !contentType.includes('text/plain')
    ) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'Invalid File Type',
            description: 'Please upload a plain `.txt` file containing `email:password` per line.',
          }),
        ],
      });
    }

    if (typeof attachment.size === 'number' && attachment.size > MAX_ATTACHMENT_BYTES) {
      return interaction.editReply({
        embeds: [
          errorEmbed({
            title: 'File Too Large',
            description: 'Maximum restock file size is **5 MB**.',
          }),
        ],
      });
    }

    // 3. Download and parse accounts
    const rawContent = await attachmentDownloader(attachment.url);
    const { parsed, invalidCount, duplicateInFileCount } =
      parseStockTextContent(rawContent);

    if (parsed.length === 0) {
      return interaction.editReply({
        embeds: [
          warningEmbed({
            title: 'No Valid Accounts Found',
            description:
              'Could not parse any valid `email:password` lines from the uploaded file.',
            fields: [
              { name: 'Invalid Lines Skipped', value: `\`${invalidCount}\``, inline: true },
            ],
          }),
        ],
      });
    }

    // 4. Filter out accounts already in stock for this service
    const { data: existingStock } = await supabase
      .from('stock')
      .select('email, password')
      .eq('service_name', service.name);

    const existingCombos = new Set(
      (existingStock || []).map((row) => `${row.email.toLowerCase()}:${row.password}`)
    );

    const freshRows = [];
    let existingDuplicatesSkipped = 0;

    for (const item of parsed) {
      const key = `${item.email.toLowerCase()}:${item.password}`;
      if (existingCombos.has(key)) {
        existingDuplicatesSkipped++;
      } else {
        freshRows.push({
          service_name: service.name,
          email: item.email,
          password: item.password,
        });
      }
    }

    const totalDuplicatesSkipped = duplicateInFileCount + existingDuplicatesSkipped;

    if (freshRows.length === 0) {
      return interaction.editReply({
        embeds: [
          warningEmbed({
            title: 'All Accounts Already Stocked',
            description: `Every valid account in **${attachment.name}** is already in **${service.name}** stock.`,
            fields: [
              {
                name: 'Duplicates Skipped',
                value: `\`${totalDuplicatesSkipped}\``,
                inline: true,
              },
              { name: 'Invalid Lines', value: `\`${invalidCount}\``, inline: true },
            ],
          }),
        ],
      });
    }

    // 5. Insert in chunks of 500 rows
    for (let i = 0; i < freshRows.length; i += INSERT_BATCH_SIZE) {
      const batch = freshRows.slice(i, i + INSERT_BATCH_SIZE);
      const { error: insertErr } = await supabase.from('stock').insert(batch);
      if (insertErr) throw insertErr;
    }

    // 6. Query updated total stock count
    const { count: updatedStockCount } = await supabase
      .from('stock')
      .select('*', { count: 'exact', head: true })
      .eq('service_name', service.name);

    const totalStock = updatedStockCount ?? freshRows.length;

    // 7. Broadcast Restock Alert if enabled
    let alertedChannelId = null;
    if (shouldAnnounce) {
      alertedChannelId = await sendRestockAlert({
        client: interaction.client,
        supabase,
        service,
        addedCount: freshRows.length,
        totalStock,
        overrideChannelId: overrideChannel?.id || null,
        overridePingRoleId: overridePingRole?.id || null,
      });
    }

    return interaction.editReply({
      embeds: [
        successEmbed({
          title: `Restock Complete — ${service.name}`,
          description: `Successfully imported **${freshRows.length}** fresh account(s) from **${attachment.name}**.`,
          fields: [
            { name: 'Added', value: `\`+${freshRows.length}\``, inline: true },
            { name: 'Total Stock Now', value: `\`${totalStock}\``, inline: true },
            {
              name: 'Duplicates Skipped',
              value: `\`${totalDuplicatesSkipped}\``,
              inline: true,
            },
            { name: 'Invalid Lines', value: `\`${invalidCount}\``, inline: true },
            {
              name: 'Restock Alert',
              value: alertedChannelId
                ? `Posted in <#${alertedChannelId}>`
                : '*Not configured (use /settings)*',
              inline: true,
            },
          ],
        }),
      ],
    });
  },
};
