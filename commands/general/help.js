const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../../config/supabase');
const { getAllRoles, getOrCreateUserRole } = require('../../utils/rba');
const { infoEmbed, errorEmbed } = require('../../utils/embeds');

const COMMAND_DETAILS = Object.freeze({
  help: {
    usage: '/help [command]',
    role: 'Free (Everyone)',
    visibility: 'Public Embed',
    description:
      'Displays all available bot commands, active RBA roles, or detailed usage information for a specific command.',
    example: '/help command:editrole',
  },
  gen: {
    usage: '/gen [service]',
    role: 'Matches or exceeds service required_role',
    visibility: 'Public Embed + Direct Message Embed',
    description:
      'Atomically claims and deletes 1 account from the requested service stock (inside the designated service or role channel) and delivers credentials to your DMs.',
    example: '/gen service:mcfa',
  },
  stock: {
    usage: '/stock [service]',
    role: 'Free (Everyone)',
    visibility: 'Public Embed',
    description:
      'Counts and displays the exact number of remaining accounts in stock for a specific service.',
    example: '/stock service:mcfa',
  },
  stocks: {
    usage: '/stocks',
    role: 'Free (Everyone)',
    visibility: 'Public Embed',
    description:
      'Displays a live stock overview listing every generator service alongside how many accounts remain in stock.',
    example: '/stocks',
  },
  services: {
    usage: '/services',
    role: 'Free (Everyone)',
    visibility: 'Public Embed',
    description:
      'Lists all configured generator services along with their minimum RBA role and designated Discord channel.',
    example: '/services',
  },
  createservice: {
    usage: '/createservice [name] [role] [channel(optional)]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Creates a new generator service linked to a minimum RBA role (built-in or custom) and channel.',
    example: '/createservice name:mcfa role:VIP channel:#gen-mcfa',
  },
  editservice: {
    usage: '/editservice [name]',
    role: 'Admin',
    visibility: 'Ephemeral Interactive Embed + Buttons',
    description:
      'Opens an interactive control panel with buttons, modals, and dropdowns to rename a service, change its required role or channel, bulk-add/clear stock, or delete it.',
    example: '/editservice name:mcfa',
  },
  deleteservice: {
    usage: '/deleteservice [name]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Permanently deletes an existing generator service and removes any remaining stock.',
    example: '/deleteservice name:mcfa',
  },
  addstock: {
    usage: '/addstock [service] [email] [password]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Adds a new account (email + password) into the Stock pool for an existing service without exposing credentials publicly.',
    example: '/addstock service:mcfa email:user@example.com password:secretPassword',
  },
  createrole: {
    usage: '/createrole [name] [channel(optional)] [priority(optional)]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Creates a custom RBA role with an optional dedicated Discord channel and hierarchy tier priority.',
    example: '/createrole name:VIP channel:#vip-gen priority:40',
  },
  editrole: {
    usage: '/editrole [name]',
    role: 'Admin',
    visibility: 'Ephemeral Interactive Embed + Buttons',
    description:
      'Opens an interactive control panel with buttons, modals, and channel pickers to rename a custom role, adjust its priority tier, set/clear its channel, or delete it.',
    example: '/editrole name:VIP',
  },
  deleterole: {
    usage: '/deleterole [name]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Deletes a custom RBA role (safely resetting assigned users to Free and locking dependent services to Admin).',
    example: '/deleterole name:VIP',
  },
  setrole: {
    usage: '/setrole [user] [role]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      "Updates a user's RBA role in the database (built-in roles, custom roles, or promoting another user to Admin).",
    example: '/setrole user:@Member role:Admin',
  },
});

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('View available commands, usage details, and your RBA role')
    .addStringOption((option) =>
      option
        .setName('command')
        .setDescription('Inspect detailed help for a specific command')
        .setRequired(false)
        .addChoices(
          ...Object.keys(COMMAND_DETAILS).map((cmd) => ({
            name: `/${cmd}`,
            value: cmd,
          }))
        )
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    let userRole = 'Free';
    let roleHierarchyLine = '`Free (1)` ➜ `Premium (50)` ➜ `Admin (100)`';

    try {
      const [fetchedUserRole, allRoles] = await Promise.all([
        getOrCreateUserRole(supabase, interaction.user.id),
        getAllRoles(supabase),
      ]);
      userRole = fetchedUserRole;
      if (allRoles.length > 0) {
        roleHierarchyLine = allRoles
          .map((r) => `\`${r.name} (${r.priority})\``)
          .join(' ➜ ');
      }
    } catch {
      // Fall back gracefully if database lookup fails
    }

    const selectedCommand = interaction.options.getString('command')?.trim().toLowerCase();

    if (selectedCommand) {
      const detail = COMMAND_DETAILS[selectedCommand];
      if (!detail) {
        return interaction.editReply({
          embeds: [
            errorEmbed({
              title: 'Unknown Command',
              description: `No help entry found for \`/${selectedCommand}\`.`,
            }),
          ],
        });
      }

      return interaction.editReply({
        embeds: [
          infoEmbed({
            title: `Command Help — /${selectedCommand}`,
            description: detail.description,
            fields: [
              { name: 'Syntax', value: `\`${detail.usage}\``, inline: true },
              { name: 'Required RBA Role', value: `\`${detail.role}\``, inline: true },
              { name: 'Response Type', value: detail.visibility, inline: true },
              { name: 'Example', value: `\`${detail.example}\``, inline: false },
            ],
            footer: `Your current RBA Role: ${userRole}`,
          }),
        ],
      });
    }

    const overviewEmbed = infoEmbed({
      title: 'Account Generator Bot — Help Menu',
      description: `Hello <@${interaction.user.id}>! Your current RBA role is **${userRole}**.`,
      fields: [
        {
          name: 'Generator & General Commands',
          value: [
            '`/help [command]` — View all commands or detailed command info.',
            '`/gen [service]` — Claim an account from stock (delivered via DM).',
            '`/stock [service]` — Check remaining stock for a single service.',
            '`/stocks` — View remaining stock across all services.',
            '`/services` — List all generator services, required roles, and channels.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Service & Stock Admin Commands',
          value: [
            '`/createservice [name] [role] [channel]` — Create a generator service.',
            '`/editservice [name]` — Interactive button panel to edit service & stock.',
            '`/deleteservice [name]` — Delete a service and its remaining stock.',
            '`/addstock [service] [email] [password]` — Add an account to stock.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Role & User Admin Commands',
          value: [
            '`/createrole [name] [channel]` — Create a custom RBA role.',
            '`/editrole [name]` — Interactive button panel to edit a role.',
            '`/deleterole [name]` — Delete a custom RBA role.',
            '`/setrole [user] [role]` — Assign any built-in/custom/Admin role.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Active RBA Roles (Priority Tiers)',
          value: roleHierarchyLine,
          inline: false,
        },
      ],
      footer: 'Tip: Run /help command:<name> for detailed usage examples.',
    });

    return interaction.editReply({ embeds: [overviewEmbed] });
  },
};
