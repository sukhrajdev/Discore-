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
const {
  isValidRoleNameFormat,
  getRoleByName,
  isAdmin,
  deleteRoleSafely,
} = require('../../utils/rba');
const { parseDurationInput, formatDuration } = require('../../utils/duration');
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
 * Fetches live role stats and builds the interactive Role Control Panel.
 *
 * @param {string} roleName
 * @param {{ notice?: string, mode?: 'default' | 'pick_channel' | 'pick_discord_role' | 'confirm_delete' }} [uiState]
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
    'Use the interactive controls below to update this RBA role, cooldown, channel, or Discord server role auto-sync.',
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
        name: 'Gen Cooldown',
        value: `\`${formatDuration(role.cooldown_seconds)}\``,
        inline: true,
      },
      {
        name: 'Linked Channel',
        value: role.channel_id ? `<#${role.channel_id}>` : '*None (Service Default)*',
        inline: true,
      },
      {
        name: 'Synced Discord Role',
        value: role.discord_role_id ? `<@&${role.discord_role_id}>` : '*None*',
        inline: true,
      },
      {
        name: 'Usage Stats',
        value: `\`${userCount}\` user(s) • \`${serviceCount}\` service(s)`,
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
      .setCustomId(`${COMPONENT_PREFIX}btn_cooldown:${role.name}`)
      .setLabel('Edit Cooldown')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_channel:${role.name}`)
      .setLabel('Set Channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_discord_role:${role.name}`)
      .setLabel('Sync Discord Role')
      .setStyle(ButtonStyle.Secondary)
  );

  const secondaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_clearchannel:${role.name}`)
      .setLabel('Clear Channel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!role.channel_id),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_cleardiscordrole:${role.name}`)
      .setLabel('Unlink Discord Role')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!role.discord_role_id),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}refresh:${role.name}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}btn_delete:${role.name}`)
      .setLabel('Delete Role')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(role.is_system)
  );

  const components = [primaryRow, secondaryRow];

  if (mode === 'pick_channel') {
    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`${COMPONENT_PREFIX}select_channel:${role.name}`)
          .setPlaceholder('Select a Discord text channel for this role...')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(1)
          .setMaxValues(1)
      )
    );
  }

  if (mode === 'pick_discord_role') {
    components.push(
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`${COMPONENT_PREFIX}select_discord_role:${role.name}`)
          .setPlaceholder('Select a Discord server role to auto-sync with this RBA role...')
          .setMinValues(1)
          .setMaxValues(1)
      )
    );
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

async function persistRoleFields(role, patch) {
  const record = {
    name: patch.name ?? role.name,
    priority: patch.priority ?? role.priority,
    channel_id: patch.channel_id !== undefined ? patch.channel_id : role.channel_id,
    cooldown_seconds:
      patch.cooldown_seconds !== undefined
        ? patch.cooldown_seconds
        : role.cooldown_seconds,
    discord_role_id:
      patch.discord_role_id !== undefined
        ? patch.discord_role_id
        : role.discord_role_id,
    is_system: role.is_system,
  };

  const { error } = await supabase
    .from('roles')
    .upsert(record, { onConflict: 'name' });
  if (error) throw error;
}

module.exports = {
  componentPrefix: COMPONENT_PREFIX,

  data: new SlashCommandBuilder()
    .setName('editrole')
    .setDescription('[Admin] Open an interactive control panel to edit an RBA role')
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

    const inputName = interaction.options.getString('name', true).trim();
    const panel = await buildRoleEditorPanel(inputName);
    return interaction.editReply(panel);
  },

  /**
   * Handles all Button, SelectMenu, and ModalSubmit interactions for `/editrole`.
   */
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

    // 1. Button: Rename Modal
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

    // 2. Button: Edit Priority Modal
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

    // 3. Button: Edit Cooldown Modal
    if (interaction.isButton() && action === 'btn_cooldown') {
      const modal = new ModalBuilder()
        .setCustomId(`${COMPONENT_PREFIX}modal_cooldown:${role.name}`)
        .setTitle(`Edit Cooldown — ${role.name}`);

      const cooldownInput = new TextInputBuilder()
        .setCustomId('new_cooldown')
        .setLabel('Cooldown (e.g., 0, 30s, 5m, 30m, 1h)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(16)
        .setValue(String(role.cooldown_seconds ?? 0))
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(cooldownInput));
      return interaction.showModal(modal);
    }

    // 4. Button: Show Channel Select Menu
    if (interaction.isButton() && action === 'btn_channel') {
      const panel = await buildRoleEditorPanel(role.name, { mode: 'pick_channel' });
      return interaction.update(panel);
    }

    // 5. Button: Show Discord Role Select Menu
    if (interaction.isButton() && action === 'btn_discord_role') {
      const panel = await buildRoleEditorPanel(role.name, {
        mode: 'pick_discord_role',
      });
      return interaction.update(panel);
    }

    // 6. Button: Clear Linked Channel
    if (interaction.isButton() && action === 'btn_clearchannel') {
      await persistRoleFields(role, { channel_id: null });
      const panel = await buildRoleEditorPanel(role.name, {
        notice: 'Linked channel cleared.',
      });
      return interaction.update(panel);
    }

    // 7. Button: Unlink Discord Role
    if (interaction.isButton() && action === 'btn_cleardiscordrole') {
      await persistRoleFields(role, { discord_role_id: null });
      const panel = await buildRoleEditorPanel(role.name, {
        notice: 'Unlinked Discord server role auto-sync.',
      });
      return interaction.update(panel);
    }

    // 8. Button: Refresh Panel
    if (interaction.isButton() && action === 'refresh') {
      const panel = await buildRoleEditorPanel(role.name);
      return interaction.update(panel);
    }

    // 9. Button: Prompt Delete Confirmation
    if (interaction.isButton() && action === 'btn_delete') {
      const panel = await buildRoleEditorPanel(role.name, { mode: 'confirm_delete' });
      return interaction.update(panel);
    }

    // 10. Button: Execute Confirmed Delete
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

    // 11. ChannelSelectMenu: Set Linked Channel
    if (interaction.isChannelSelectMenu() && action === 'select_channel') {
      const selectedChannelId = interaction.values[0];
      await persistRoleFields(role, { channel_id: selectedChannelId });
      const panel = await buildRoleEditorPanel(role.name, {
        notice: `Linked channel updated to <#${selectedChannelId}>.`,
      });
      return interaction.update(panel);
    }

    // 12. RoleSelectMenu: Link Discord Server Role for Auto-Sync
    if (
      typeof interaction.isRoleSelectMenu === 'function' &&
      interaction.isRoleSelectMenu() &&
      action === 'select_discord_role'
    ) {
      const selectedDiscordRoleId = interaction.values[0];
      await persistRoleFields(role, { discord_role_id: selectedDiscordRoleId });
      const panel = await buildRoleEditorPanel(role.name, {
        notice: `Synced with Discord server role <@&${selectedDiscordRoleId}>.`,
      });
      return interaction.update(panel);
    }

    // 13. Modal Submit: Rename Role
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

    // 14. Modal Submit: Update Priority
    if (interaction.isModalSubmit() && action === 'modal_priority') {
      const rawPriority = interaction.fields.getTextInputValue('new_priority').trim();
      const parsed = Number.parseInt(rawPriority, 10);

      if (!Number.isInteger(parsed) || parsed < 2 || parsed > 99) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice: 'Priority must be a whole number between **2** and **99**.',
        });
        return respondWithUpdatedPanel(interaction, panel);
      }

      await persistRoleFields(role, { priority: parsed });
      const panel = await buildRoleEditorPanel(role.name, {
        notice: `Priority tier updated to \`${parsed}\`.`,
      });
      return respondWithUpdatedPanel(interaction, panel);
    }

    // 15. Modal Submit: Update Cooldown
    if (interaction.isModalSubmit() && action === 'modal_cooldown') {
      const rawCooldown = interaction.fields.getTextInputValue('new_cooldown').trim();
      const parsed = parseDurationInput(rawCooldown, {
        allowZero: true,
        allowLifetime: false,
      });

      if (!parsed.ok || parsed.seconds === null || parsed.seconds > 86400) {
        const panel = await buildRoleEditorPanel(role.name, {
          notice: 'Invalid cooldown. Use `0`, `30s`, `5m`, `30m`, `1h` (max 24h).',
        });
        return respondWithUpdatedPanel(interaction, panel);
      }

      await persistRoleFields(role, { cooldown_seconds: parsed.seconds });
      const panel = await buildRoleEditorPanel(role.name, {
        notice: `Generator cooldown updated to \`${formatDuration(parsed.seconds)}\`.`,
      });
      return respondWithUpdatedPanel(interaction, panel);
    }
  },
};
