const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const supabase = require('../../config/supabase');
const {
  isValidRoleNameFormat,
  getRoleByName,
  isAdmin,
  deleteRoleSafely,
} = require('../../utils/rba');
const { autocompleteRoleName } = require('../../utils/autocomplete');
const {
  EMBED_COLORS,
  buildEmbed,
  successEmbed,
  warningEmbed,
  errorEmbed,
} = require('../../utils/embeds');

const COMPONENT_PREFIX = 'editrole:';

/**
 * Fetches live statistics and Builds the Role Control Panel payload (Embed + Buttons).
 *
 * @param {string} roleName
 * @param {{ notice?: string, mode?: 'default' | 'pick_channel' | 'confirm_delete' }} [uiState]
 */
async function buildRoleEditorPanel(roleName, uiState = {}) {
  const { notice = null, mode = 'default' } = uiState;
  const role = await getRoleByName(supabase, roleName);

  if (!role) {
    return {
      embeds: [
        errorEmbed({
          title: 'Role Not Found',
          description: `Role \`${roleName}\` could not be found (it may have been renamed or deleted).`,
        }),
      ],
      components: [],
    };
  }

  // Count assigned users and linked services in parallel
  const [usersCountRes, servicesCountRes] = await Promise.all([
    supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('rba_role', role.name),
    supabase
      .from('services')
      .select('*', { count: 'exact', head: true })
      .eq('required_role', role.name),
  ]);

  const userCount = usersCountRes.count ?? 0;
  const serviceCount = servicesCountRes.count ?? 0;

  if (mode === 'confirm_delete') {
    const confirmEmbed = warningEmbed({
      title: `Confirm Delete Role — ${role.name}`,
      description: [
        `Are you sure you want to permanently delete the **${role.name}** role?`,
        '',
        `• **${userCount}** user(s) with this role will be reset to **Free**.`,
        `• **${serviceCount}** service(s) requiring this role will be locked to **Admin**.`,
      ].join('\n'),
    });

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${COMPONENT_PREFIX}confirm_delete:${role.name}`)
        .setLabel('Confirm Delete')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${COMPONENT_PREFIX}refresh:${role.name}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [confirmEmbed], components: [confirmRow] };
  }

  const descriptionParts = [
    'Use the interactive controls below to update this RBA role in real time.',
  ];
  if (notice) {
    descriptionParts.unshift(`**Update:** ${notice}\n`);
  }

  const panelEmbed = buildEmbed({
    title: `Role Control Panel — ${role.name}`,
    description: descriptionParts.join('\n'),
    color: notice ? EMBED_COLORS.SUCCESS : EMBED_COLORS.PRIMARY,
    fields: [
      { name: 'Role Name', value: `**${role.name}**`, inline: true },
      { name: 'Priority Tier', value: `\`${role.priority}\``, inline: true },
      {
        name: 'Linked Channel',
        value: role.channel_id ? `<#${role.channel_id}>` : '*None (Service Default)*',
        inline: true,
      },
      { name: 'Assigned Users', value: `\`${userCount}\` user(s)`, inline: true },
      { name: 'Linked Services', value: `\`${serviceCount}\` service(s)`, inline: true },
      {
        name: 'Protection',
        value: role.is_system ? '`System Protected`' : '`Custom Editable`',
        inline: true,
      },
    ],
    footer: 'Tier Scale: Free = 1 • Custom = 2–99 • Premium = 50 • Admin = 100',
  });

  const primaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_rename:${role.name}`)
      .setLabel('Rename')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(role.is_system),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_priority:${role.name}`)
      .setLabel('Edit Priority')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(role.is_system),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_channel:${role.name}`)
      .setLabel('Set Channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_clearchannel:${role.name}`)
      .setLabel('Clear Channel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!role.channel_id),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}refresh:${role.name}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  const dangerRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_delete:${role.name}`)
      .setLabel('Delete Role')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(role.is_system)
  );

  const components = [primaryRow, dangerRow];

  if (mode === 'pick_channel') {
    const channelPickerRow = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`${COMPONENT_PREFIX}select_channel:${role.name}`)
        .setPlaceholder('Select a Discord text channel for this role...')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1)
    );
    components.push(channelPickerRow);
  }

  return { embeds: [panelEmbed], components };
}

/**
 * Helper to update the parent panel message from either a MessageComponent or ModalSubmit.
 */
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
    .setName('editrole')
    .setDescription('[Admin] Open an interactive control panel to edit a role')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('The RBA role to edit')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: autocompleteRoleName,

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
    const panel = await buildRoleEditorPanel(inputName);
    return interaction.editReply(panel);
  },

  /**
   * Handles all Button, ChannelSelectMenu, and ModalSubmit interactions for `/editrole`.
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

    // customId format: editrole:<action>:<roleName>
    const withoutPrefix = interaction.customId.slice(COMPONENT_PREFIX.length);
    const separatorIdx = withoutPrefix.indexOf(':');
    if (separatorIdx === -1) return;

    const action = withoutPrefix.slice(0, separatorIdx);
    const roleName = withoutPrefix.slice(separatorIdx + 1);

    const role = await getRoleByName(supabase, roleName);
    if (!role) {
      return respondWithUpdatedPanel(interaction, {
        embeds: [
          errorEmbed({
            title: 'Role Not Found',
            description: `Role \`${roleName}\` no longer exists.`,
          }),
        ],
        components: [],
      });
    }

    // 1. Button: Open Rename Modal
    if (interaction.isButton() && action === 'btn_rename') {
      if (role.is_system) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice: 'System roles cannot be renamed.',
        });
        return interaction.update(panel);
      }

      const modal = new ModalBuilder()
        .setCustomId(`${COMPONENT_PREFIX}modal_rename:${role.name}`)
        .setTitle(`Rename Role — ${role.name}`);

      const nameInput = new TextInputBuilder()
        .setCustomId('new_role_name')
        .setLabel('New Role Name')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(32)
        .setValue(role.name)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      return interaction.showModal(modal);
    }

    // 2. Button: Open Priority Modal
    if (interaction.isButton() && action === 'btn_priority') {
      if (role.is_system) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice: 'System role priority tiers are fixed.',
        });
        return interaction.update(panel);
      }

      const modal = new ModalBuilder()
        .setCustomId(`${COMPONENT_PREFIX}modal_priority:${role.name}`)
        .setTitle(`Edit Priority — ${role.name}`);

      const priorityInput = new TextInputBuilder()
        .setCustomId('new_priority')
        .setLabel('Priority Tier (2–99; Free=1, Admin=100)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(2)
        .setValue(String(role.priority))
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(priorityInput));
      return interaction.showModal(modal);
    }

    // 3. Button: Show Channel Select Menu
    if (interaction.isButton() && action === 'btn_channel') {
      const panel = await buildRoleEditorPanel(role.name, { mode: 'pick_channel' });
      return interaction.update(panel);
    }

    // 4. Button: Clear Linked Channel
    if (interaction.isButton() && action === 'btn_clearchannel') {
      const { error } = await supabase
        .from('roles')
        .upsert(
          {
            name: role.name,
            priority: role.priority,
            channel_id: null,
            is_system: role.is_system,
          },
          { onConflict: 'name' }
        );
      if (error) throw error;

      const panel = await buildRoleEditorPanel(role.name, {
        notice: 'Linked channel cleared.',
      });
      return interaction.update(panel);
    }

    // 5. Button: Refresh Panel
    if (interaction.isButton() && action === 'refresh') {
      const panel = await buildRoleEditorPanel(role.name);
      return interaction.update(panel);
    }

    // 6. Button: Prompt Delete Confirmation
    if (interaction.isButton() && action === 'btn_delete') {
      const panel = await buildRoleEditorPanel(role.name, { mode: 'confirm_delete' });
      return interaction.update(panel);
    }

    // 7. Button: Execute Confirmed Delete
    if (interaction.isButton() && action === 'confirm_delete') {
      const result = await deleteRoleSafely(supabase, role.name);
      if (!result.ok) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice: 'This role cannot be deleted.',
        });
        return interaction.update(panel);
      }

      return interaction.update({
        embeds: [
          successEmbed({
            title: 'Role Deleted',
            description: `Role **${result.role.name}** has been permanently deleted.`,
            fields: [
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
            ],
          }),
        ],
        components: [],
      });
    }

    // 8. Channel Select Menu: Set Linked Channel
    if (interaction.isChannelSelectMenu() && action === 'select_channel') {
      const selectedChannelId = interaction.values[0];
      const { error } = await supabase
        .from('roles')
        .upsert(
          {
            name: role.name,
            priority: role.priority,
            channel_id: selectedChannelId,
            is_system: role.is_system,
          },
          { onConflict: 'name' }
        );
      if (error) throw error;

      const panel = await buildRoleEditorPanel(role.name, {
        notice: `Linked channel updated to <#${selectedChannelId}>.`,
      });
      return interaction.update(panel);
    }

    // 9. Modal Submit: Rename Role
    if (interaction.isModalSubmit() && action === 'modal_rename') {
      const newName = interaction.fields.getTextInputValue('new_role_name').trim();

      if (!isValidRoleNameFormat(newName)) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice:
            'Invalid role name. Use 1–32 letters, numbers, spaces, hyphens, or underscores.',
        });
        return respondWithUpdatedPanel(interaction, panel);
      }

      const conflict = await getRoleByName(supabase, newName);
      if (conflict && conflict.name.toLowerCase() !== role.name.toLowerCase()) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice: `Another role named **${conflict.name}** already exists.`,
        });
        return respondWithUpdatedPanel(interaction, panel);
      }

      const { error } = await supabase
        .from('roles')
        .update({ name: newName })
        .eq('name', role.name);
      if (error) throw error;

      // Also keep users & services synced if foreign-key ON UPDATE CASCADE isn't present
      await Promise.all([
        supabase.from('users').update({ rba_role: newName }).eq('rba_role', role.name),
        supabase
          .from('services')
          .update({ required_role: newName })
          .eq('required_role', role.name),
      ]);

      const panel = await buildRoleEditorPanel(newName, {
        notice: `Role renamed from **${role.name}** to **${newName}**.`,
      });
      return respondWithUpdatedPanel(interaction, panel);
    }

    // 10. Modal Submit: Update Priority
    if (interaction.isModalSubmit() && action === 'modal_priority') {
      const rawPriority = interaction.fields.getTextInputValue('new_priority').trim();
      const parsed = Number.parseInt(rawPriority, 10);

      if (!Number.isInteger(parsed) || parsed < 2 || parsed > 99) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice: 'Priority must be a whole number between **2** and **99**.',
        });
        return respondWithUpdatedPanel(interaction, panel);
      }

      const { error } = await supabase
        .from('roles')
        .update({ priority: parsed })
        .eq('name', role.name);
      if (error) throw error;

      const panel = await buildRoleEditorPanel(role.name, {
        notice: `Priority tier updated to \`${parsed}\`.`,
      });
      return respondWithUpdatedPanel(interaction, panel);
    }
  },
};
