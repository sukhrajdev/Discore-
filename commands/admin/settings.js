const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { isAdmin } = require('../../utils/rba');
const { getBotSettings, updateBotSettings } = require('../../utils/settings');
const { EMBED_COLORS, buildEmbed, errorEmbed } = require('../../utils/embeds');

const COMPONENT_PREFIX = 'settings:';

/**
 * Builds the interactive Bot Settings Control Panel (Restock Alerts & Alt-Account Protection).
 *
 * @param {{ notice?: string, mode?: 'default' | 'pick_channel' | 'pick_ping_role' }} [uiState]
 */
async function buildSettingsPanel(uiState = {}) {
  const { notice = null, mode = 'default' } = uiState;
  const settings = await getBotSettings(supabase);

  const descriptionParts = [
    'Configure automatic Restock Alert broadcasts and Alt-Account Protection below.',
  ];
  if (notice) {
    descriptionParts.unshift(`**Update:** ${notice}\n`);
  }

  const embed = buildEmbed({
    title: 'Bot Security & Restock Settings',
    description: descriptionParts.join('\n'),
    color: notice ? EMBED_COLORS.SUCCESS : EMBED_COLORS.PRIMARY,
    fields: [
      {
        name: 'Restock Alert Channel',
        value: settings.restock_channel_id
          ? `<#${settings.restock_channel_id}>`
          : '*Disabled*',
        inline: true,
      },
      {
        name: 'Restock Ping Role',
        value: settings.restock_ping_role_id
          ? `<@&${settings.restock_ping_role_id}>`
          : '*None*',
        inline: true,
      },
      {
        name: 'Min Account Age (Free Tier)',
        value:
          settings.min_account_age_days > 0
            ? `\`${settings.min_account_age_days}\` day(s)`
            : '*Disabled (0 days)*',
        inline: true,
      },
    ],
    footer: 'Alt-account age protection applies to Free users to block alt farming.',
  });

  const primaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_channel`)
      .setLabel('Set Restock Channel')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_pingrole`)
      .setLabel('Set Restock Ping Role')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_minage`)
      .setLabel('Set Min Account Age')
      .setStyle(ButtonStyle.Primary)
  );

  const secondaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_clearchannel`)
      .setLabel('Clear Channel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!settings.restock_channel_id),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_clearping`)
      .setLabel('Clear Ping Role')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!settings.restock_ping_role_id),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}refresh`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [primaryRow, secondaryRow];

  if (mode === 'pick_channel') {
    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`${COMPONENT_PREFIX}select_channel`)
          .setPlaceholder('Select a channel for automatic Restock Alerts...')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(1)
          .setMaxValues(1)
      )
    );
  }

  if (mode === 'pick_ping_role') {
    components.push(
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`${COMPONENT_PREFIX}select_pingrole`)
          .setPlaceholder('Select a Discord role to ping on restocks...')
          .setMinValues(1)
          .setMaxValues(1)
      )
    );
  }

  return { embeds: [embed], components };
}

async function respondWithUpdatedPanel(interaction, panelPayload) {
  if (typeof interaction.isFromMessage === 'function' && interaction.isFromMessage()) {
    return interaction.update(panelPayload);
  }
  if (typeof interaction.update === 'function' && !interaction.isModalSubmit()) {
    return interaction.update(panelPayload);
  }
  return interaction.reply({ ...panelPayload, flags: MessageFlags.Ephemeral });
}

module.exports = {
  componentPrefix: COMPONENT_PREFIX,

  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('[Admin] Configure Restock Alert channel, ping role, and alt-account age protection')
    .setContexts(InteractionContextType.Guild),

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

    const panel = await buildSettingsPanel();
    return interaction.editReply(panel);
  },

  async handleComponent(interaction) {
    const hasAdminAccess = await isAdmin(
      supabase,
      interaction.user.id,
      interaction.member
    );
    if (!hasAdminAccess) {
      return interaction.reply({
        embeds: [
          errorEmbed({
            title: 'Access Denied',
            description: 'You need the **Admin** RBA role to use these controls.',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const action = interaction.customId.slice(COMPONENT_PREFIX.length);

    if (interaction.isButton() && action === 'btn_channel') {
      return interaction.update(await buildSettingsPanel({ mode: 'pick_channel' }));
    }

    if (interaction.isButton() && action === 'btn_pingrole') {
      return interaction.update(await buildSettingsPanel({ mode: 'pick_ping_role' }));
    }

    if (interaction.isButton() && action === 'btn_clearchannel') {
      await updateBotSettings(supabase, { restock_channel_id: null });
      return interaction.update(
        await buildSettingsPanel({ notice: 'Disabled automatic Restock Alert channel.' })
      );
    }

    if (interaction.isButton() && action === 'btn_clearping') {
      await updateBotSettings(supabase, { restock_ping_role_id: null });
      return interaction.update(
        await buildSettingsPanel({ notice: 'Cleared Restock Alert ping role.' })
      );
    }

    if (interaction.isButton() && action === 'refresh') {
      return interaction.update(await buildSettingsPanel());
    }

    if (interaction.isButton() && action === 'btn_minage') {
      const current = await getBotSettings(supabase);
      const modal = new ModalBuilder()
        .setCustomId(`${COMPONENT_PREFIX}modal_minage`)
        .setTitle('Alt-Account Age Protection');

      const ageInput = new TextInputBuilder()
        .setCustomId('min_age_days')
        .setLabel('Minimum Discord Account Age in Days (0–365)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(3)
        .setValue(String(current.min_account_age_days))
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(ageInput));
      return interaction.showModal(modal);
    }

    if (interaction.isChannelSelectMenu() && action === 'select_channel') {
      const channelId = interaction.values[0];
      await updateBotSettings(supabase, { restock_channel_id: channelId });
      return interaction.update(
        await buildSettingsPanel({
          notice: `Restock Alert channel set to <#${channelId}>.`,
        })
      );
    }

    if (
      typeof interaction.isRoleSelectMenu === 'function' &&
      interaction.isRoleSelectMenu() &&
      action === 'select_pingrole'
    ) {
      const roleId = interaction.values[0];
      await updateBotSettings(supabase, { restock_ping_role_id: roleId });
      return interaction.update(
        await buildSettingsPanel({
          notice: `Restock Alert ping role set to <@&${roleId}>.`,
        })
      );
    }

    if (interaction.isModalSubmit() && action === 'modal_minage') {
      const raw = interaction.fields.getTextInputValue('min_age_days').trim();
      const parsed = Number.parseInt(raw, 10);

      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
        return respondWithUpdatedPanel(
          interaction,
          await buildSettingsPanel({
            notice: 'Enter a whole number of days between **0** and **365**.',
          })
        );
      }

      await updateBotSettings(supabase, { min_account_age_days: parsed });
      return respondWithUpdatedPanel(
        interaction,
        await buildSettingsPanel({
          notice:
            parsed > 0
              ? `Minimum Discord account age set to **${parsed}** day(s) for Free tier.`
              : 'Disabled minimum Discord account age requirement.',
        })
      );
    }
  },
};
