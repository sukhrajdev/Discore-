const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const { getAllRoles, getRoleByName, isAdmin } = require('../../utils/rba');
const { autocompleteServiceName } = require('../../utils/autocomplete');
const {
  EMBED_COLORS,
  buildEmbed,
  successEmbed,
  warningEmbed,
  errorEmbed,
} = require('../../utils/embeds');

const COMPONENT_PREFIX = 'editservice:';

/**
 * Fetches live service configuration & stock count and builds the interactive Service Control Panel.
 *
 * @param {string} serviceName
 * @param {{ notice?: string, mode?: 'default' | 'pick_role' | 'pick_channel' | 'confirm_clear_stock' | 'confirm_delete' }} [uiState]
 */
async function buildServiceEditorPanel(serviceName, uiState = {}) {
  const { notice = null, mode = 'default' } = uiState;
  const normalizedName = serviceName.trim().toLowerCase();

  const [serviceRes, stockCountRes] = await Promise.all([
    supabase
      .from('services')
      .select('name, required_role, channel_id')
      .eq('name', normalizedName)
      .maybeSingle(),
    supabase
      .from('stock')
      .select('*', { count: 'exact', head: true })
      .eq('service_name', normalizedName),
  ]);

  if (serviceRes.error) throw serviceRes.error;
  if (stockCountRes.error) throw stockCountRes.error;

  const service = serviceRes.data;
  if (!service) {
    return {
      embeds: [
        errorEmbed({
          title: 'Service Not Found',
          description: `Service \`${normalizedName}\` does not exist (it may have been renamed or deleted).`,
        }),
      ],
      components: [],
    };
  }

  const stockCount = stockCountRes.count ?? 0;

  // Confirmation view: Clear Stock
  if (mode === 'confirm_clear_stock') {
    const confirmEmbed = warningEmbed({
      title: `Confirm Clear Stock — ${service.name}`,
      description: `Are you sure you want to delete all **${stockCount}** account(s) currently in stock for **${service.name}**?\n\n*The service itself will remain active.*`,
    });

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${COMPONENT_PREFIX}confirm_clearstock:${service.name}`)
        .setLabel(`Clear ${stockCount} Account(s)`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${COMPONENT_PREFIX}refresh:${service.name}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [confirmEmbed], components: [confirmRow] };
  }

  // Confirmation view: Delete Service
  if (mode === 'confirm_delete') {
    const confirmEmbed = warningEmbed({
      title: `Confirm Delete Service — ${service.name}`,
      description: `Are you sure you want to permanently delete **${service.name}** and its **${stockCount}** remaining stock account(s)?`,
    });

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${COMPONENT_PREFIX}confirm_delete:${service.name}`)
        .setLabel('Confirm Delete Service')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${COMPONENT_PREFIX}refresh:${service.name}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [confirmEmbed], components: [confirmRow] };
  }

  const descriptionParts = [
    'Use the interactive buttons below to configure this service or manage its stock in real time.',
  ];
  if (notice) {
    descriptionParts.unshift(`**Update:** ${notice}\n`);
  }

  const panelEmbed = buildEmbed({
    title: `Service Control Panel — ${service.name}`,
    description: descriptionParts.join('\n'),
    color: notice
      ? EMBED_COLORS.SUCCESS
      : stockCount > 0
      ? EMBED_COLORS.PRIMARY
      : EMBED_COLORS.WARNING,
    fields: [
      { name: 'Service Name', value: `\`${service.name}\``, inline: true },
      { name: 'Required RBA Role', value: `**${service.required_role}**`, inline: true },
      { name: 'Generator Channel', value: `<#${service.channel_id}>`, inline: true },
      {
        name: 'Accounts in Stock',
        value: `${stockCount > 0 ? '🟢' : '🔴'} \`${stockCount}\` remaining`,
        inline: true,
      },
    ],
    footer: 'Changes apply immediately across /gen, /stock, /stocks, and /services.',
  });

  const primaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_rename:${service.name}`)
      .setLabel('Rename')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_role:${service.name}`)
      .setLabel('Change Role')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_channel:${service.name}`)
      .setLabel('Change Channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_addstock:${service.name}`)
      .setLabel('Add Stock')
      .setStyle(ButtonStyle.Success)
  );

  const secondaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}refresh:${service.name}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_clearstock:${service.name}`)
      .setLabel('Clear Stock')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(stockCount === 0),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_delete:${service.name}`)
      .setLabel('Delete Service')
      .setStyle(ButtonStyle.Danger)
  );

  const components = [primaryRow, secondaryRow];

  if (mode === 'pick_role') {
    const allRoles = await getAllRoles(supabase);
    const roleOptions = allRoles.slice(0, 25).map((r) => ({
      label: r.name,
      value: r.name,
      description: `Priority: ${r.priority}${r.channel_id ? ' • Dedicated Channel' : ''}`,
      default: r.name.toLowerCase() === service.required_role.toLowerCase(),
    }));

    const roleSelectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${COMPONENT_PREFIX}select_role:${service.name}`)
        .setPlaceholder('Select the minimum RBA role required...')
        .addOptions(roleOptions)
    );
    components.push(roleSelectRow);
  }

  if (mode === 'pick_channel') {
    const channelSelectRow = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`${COMPONENT_PREFIX}select_channel:${service.name}`)
        .setPlaceholder('Select the Discord channel for generating this service...')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1)
    );
    components.push(channelSelectRow);
  }

  return { embeds: [panelEmbed], components };
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
    .setName('editservice')
    .setDescription('[Admin] Open an interactive control panel to edit a generator service')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('The service name to edit (e.g., mcfa, netflix)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: autocompleteServiceName,

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

    const serviceName = interaction.options.getString('name', true).trim().toLowerCase();
    const panel = await buildServiceEditorPanel(serviceName);
    return interaction.editReply(panel);
  },

  /**
   * Handles all Button, SelectMenu, and ModalSubmit interactions for `/editservice`.
   */
  async handleComponent(interaction) {
    const hasAdminAccess = await isAdmin(supabase, interaction.user.id);
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

    // customId format: editservice:<action>:<serviceName>
    const withoutPrefix = interaction.customId.slice(COMPONENT_PREFIX.length);
    const separatorIdx = withoutPrefix.indexOf(':');
    if (separatorIdx === -1) return;

    const action = withoutPrefix.slice(0, separatorIdx);
    const serviceName = withoutPrefix.slice(separatorIdx + 1).trim().toLowerCase();

    const { data: service, error: lookupError } = await supabase
      .from('services')
      .select('name, required_role, channel_id')
      .eq('name', serviceName)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!service) {
      return respondWithUpdatedPanel(interaction, {
        embeds: [
          errorEmbed({
            title: 'Service Not Found',
            description: `Service \`${serviceName}\` no longer exists.`,
          }),
        ],
        components: [],
      });
    }

    // 1. Button: Open Rename Service Modal
    if (interaction.isButton() && action === 'btn_rename') {
      const modal = new ModalBuilder()
        .setCustomId(`${COMPONENT_PREFIX}modal_rename:${service.name}`)
        .setTitle(`Rename Service — ${service.name}`);

      const nameInput = new TextInputBuilder()
        .setCustomId('new_service_name')
        .setLabel('New Service Name (lowercase, e.g., mcfa)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(50)
        .setValue(service.name)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      return interaction.showModal(modal);
    }

    // 2. Button: Show Role Select Menu
    if (interaction.isButton() && action === 'btn_role') {
      const panel = await buildServiceEditorPanel(service.name, { mode: 'pick_role' });
      return interaction.update(panel);
    }

    // 3. Button: Show Channel Select Menu
    if (interaction.isButton() && action === 'btn_channel') {
      const panel = await buildServiceEditorPanel(service.name, { mode: 'pick_channel' });
      return interaction.update(panel);
    }

    // 4. Button: Open Quick/Bulk Add Stock Modal
    if (interaction.isButton() && action === 'btn_addstock') {
      const modal = new ModalBuilder()
        .setCustomId(`${COMPONENT_PREFIX}modal_addstock:${service.name}`)
        .setTitle(`Add Stock — ${service.name}`);

      const accountsInput = new TextInputBuilder()
        .setCustomId('accounts_input')
        .setLabel('Accounts (email:password per line, or email)')
        .setPlaceholder('user1@mail.com:pass123\nuser2@mail.com:pass456')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const singlePasswordInput = new TextInputBuilder()
        .setCustomId('single_password')
        .setLabel('Password (only if entering 1 email above)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(accountsInput),
        new ActionRowBuilder().addComponents(singlePasswordInput)
      );
      return interaction.showModal(modal);
    }

    // 5. Button: Refresh Panel
    if (interaction.isButton() && action === 'refresh') {
      const panel = await buildServiceEditorPanel(service.name);
      return interaction.update(panel);
    }

    // 6. Button: Prompt Clear Stock Confirmation
    if (interaction.isButton() && action === 'btn_clearstock') {
      const panel = await buildServiceEditorPanel(service.name, {
        mode: 'confirm_clear_stock',
      });
      return interaction.update(panel);
    }

    // 7. Button: Execute Clear Stock
    if (interaction.isButton() && action === 'confirm_clearstock') {
      const { error } = await supabase
        .from('stock')
        .delete()
        .eq('service_name', service.name);
      if (error) throw error;

      const panel = await buildServiceEditorPanel(service.name, {
        notice: `Cleared all stock accounts for **${service.name}**.`,
      });
      return interaction.update(panel);
    }

    // 8. Button: Prompt Delete Service Confirmation
    if (interaction.isButton() && action === 'btn_delete') {
      const panel = await buildServiceEditorPanel(service.name, { mode: 'confirm_delete' });
      return interaction.update(panel);
    }

    // 9. Button: Execute Delete Service
    if (interaction.isButton() && action === 'confirm_delete') {
      // Remove stock rows explicitly as well in case DB doesn't cascade in mocks
      await supabase.from('stock').delete().eq('service_name', service.name);
      const { error } = await supabase
        .from('services')
        .delete()
        .eq('name', service.name);
      if (error) throw error;

      return interaction.update({
        embeds: [
          successEmbed({
            title: 'Service Deleted',
            description: `Generator service **${service.name}** and its remaining stock have been permanently deleted.`,
          }),
        ],
        components: [],
      });
    }

    // 10. StringSelectMenu: Update Required Role
    if (interaction.isStringSelectMenu() && action === 'select_role') {
      const chosenRoleName = interaction.values[0];
      const validRole = await getRoleByName(supabase, chosenRoleName);
      if (!validRole) {
        const panel = await buildServiceEditorPanel(service.name, {
          notice: `Role \`${chosenRoleName}\` no longer exists.`,
        });
        return interaction.update(panel);
      }

      const { error } = await supabase
        .from('services')
        .update({ required_role: validRole.name })
        .eq('name', service.name);
      if (error) throw error;

      const panel = await buildServiceEditorPanel(service.name, {
        notice: `Required role updated to **${validRole.name}**.`,
      });
      return interaction.update(panel);
    }

    // 11. ChannelSelectMenu: Update Generator Channel
    if (interaction.isChannelSelectMenu() && action === 'select_channel') {
      const selectedChannelId = interaction.values[0];
      const { error } = await supabase
        .from('services')
        .update({ channel_id: selectedChannelId })
        .eq('name', service.name);
      if (error) throw error;

      const panel = await buildServiceEditorPanel(service.name, {
        notice: `Generator channel updated to <#${selectedChannelId}>.`,
      });
      return interaction.update(panel);
    }

    // 12. Modal Submit: Rename Service
    if (interaction.isModalSubmit() && action === 'modal_rename') {
      const newName = interaction.fields
        .getTextInputValue('new_service_name')
        .trim()
        .toLowerCase();

      if (!/^[a-z0-9_-]{1,50}$/.test(newName)) {
        const panel = await buildServiceEditorPanel(service.name, {
          notice:
            'Invalid name. Use 1–50 lowercase letters, numbers, hyphens, or underscores.',
        });
        return respondWithUpdatedPanel(interaction, panel);
      }

      if (newName !== service.name) {
        const { data: existing } = await supabase
          .from('services')
          .select('name')
          .eq('name', newName)
          .maybeSingle();

        if (existing) {
          const panel = await buildServiceEditorPanel(service.name, {
            notice: `A service named **${newName}** already exists.`,
          });
          return respondWithUpdatedPanel(interaction, panel);
        }

        const { error } = await supabase
          .from('services')
          .update({ name: newName })
          .eq('name', service.name);
        if (error) throw error;

        // Ensure stock service_name stays synced even if ON UPDATE CASCADE is mocked
        await supabase
          .from('stock')
          .update({ service_name: newName })
          .eq('service_name', service.name);
      }

      const panel = await buildServiceEditorPanel(newName, {
        notice: `Service renamed to **${newName}**.`,
      });
      return respondWithUpdatedPanel(interaction, panel);
    }

    // 13. Modal Submit: Add Single or Bulk Stock
    if (interaction.isModalSubmit() && action === 'modal_addstock') {
      const rawAccounts = interaction.fields.getTextInputValue('accounts_input').trim();
      const singlePassword = interaction.fields
        .getTextInputValue('single_password')
        ?.trim();

      const lines = rawAccounts
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const rowsToInsert = [];

      if (lines.length === 1 && !lines[0].includes(':') && singlePassword) {
        rowsToInsert.push({
          service_name: service.name,
          email: lines[0],
          password: singlePassword,
        });
      } else {
        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0 && colonIdx < line.length - 1) {
            rowsToInsert.push({
              service_name: service.name,
              email: line.slice(0, colonIdx).trim(),
              password: line.slice(colonIdx + 1),
            });
          }
        }
      }

      if (rowsToInsert.length === 0) {
        const panel = await buildServiceEditorPanel(service.name, {
          notice:
            'No valid accounts parsed. Enter `email:password` per line (or 1 email + password field).',
        });
        return respondWithUpdatedPanel(interaction, panel);
      }

      const { error } = await supabase.from('stock').insert(rowsToInsert);
      if (error) throw error;

      const panel = await buildServiceEditorPanel(service.name, {
        notice: `Added **${rowsToInsert.length}** account(s) to **${service.name}** stock.`,
      });
      return respondWithUpdatedPanel(interaction, panel);
    }
  },
};
