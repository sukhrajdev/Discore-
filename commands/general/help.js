const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../../config/supabase');
const { getAllRoles, getOrCreateUserRole } = require('../../utils/rba');
const { formatDuration } = require('../../utils/duration');
const { infoEmbed, errorEmbed } = require('../../utils/embeds');

const COMMAND_DETAILS = Object.freeze({
  help: {
    usage: '/help [command]',
    role: 'Free (Everyone)',
    visibility: 'Public Embed',
    description:
      'Displays all available bot commands, active RBA roles, or detailed usage information for a specific command.',
    example: '/help command:restock',
  },
  gen: {
    usage: '/gen [service]',
    role: 'Matches or exceeds service required_role',
    visibility: 'Public Embed + Direct Message Embed',
    description:
      'Atomically claims and deletes 1 account from stock (enforcing blacklist, alt-age, and per-role cooldowns) and sends credentials via DM.',
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
  redeem: {
    usage: '/redeem [key]',
    role: 'Free (Everyone)',
    visibility: 'Ephemeral Embed',
    description:
      'Redeems a license key to unlock a timed or lifetime RBA role subscription (stacks remaining time if already active).',
    example: '/redeem key:DISC-ABCD-EFGH-JKLM',
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
      'Adds a single account into the Stock pool and triggers a Restock Alert if configured.',
    example: '/addstock service:mcfa email:user@example.com password:secretPassword',
  },
  restock: {
    usage: '/restock [service] [file] [announce] [channel] [ping_role]',
    role: 'Admin',
    visibility: 'Ephemeral Embed + Optional Restock Alert',
    description:
      'Bulk imports accounts from an uploaded `.txt` file (`email:password` per line) with automatic deduplication and Restock Alert broadcasting.',
    example: '/restock service:mcfa file:accounts.txt',
  },
  createrole: {
    usage: '/createrole [name] [channel] [priority] [cooldown] [discord_role]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Creates a custom RBA role with optional channel, priority tier, `/gen` cooldown, and Discord server role auto-sync.',
    example: '/createrole name:VIP cooldown:120 discord_role:@Booster',
  },
  editrole: {
    usage: '/editrole [name]',
    role: 'Admin',
    visibility: 'Ephemeral Interactive Embed + Buttons',
    description:
      'Interactive button panel to rename a custom role, edit priority/cooldown, link a channel, sync a Discord server role, or delete it.',
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
      "Updates a user's permanent RBA role (built-in roles, custom roles, or promoting another user to Admin).",
    example: '/setrole user:@Member role:Admin',
  },
  createkey: {
    usage: '/createkey [role] [duration] [amount]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Generates 1–25 cryptographically random license keys (`DISC-XXXX-XXXX-XXXX`) for timed (`7d`, `30d`) or `lifetime` subscriptions.',
    example: '/createkey role:Premium duration:30d amount:5',
  },
  blacklist: {
    usage: '/blacklist add|remove|list',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Blocks or unblocks users from generating accounts and redeeming license keys.',
    example: '/blacklist add user:@Abuser reason:Farming accounts',
  },
  settings: {
    usage: '/settings',
    role: 'Admin',
    visibility: 'Ephemeral Interactive Embed + Buttons',
    description:
      'Interactive panel to configure automatic Restock Alert channels, Restock Ping roles, and minimum Discord account age protection.',
    example: '/settings',
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
        getOrCreateUserRole(supabase, interaction.user.id, interaction.member),
        getAllRoles(supabase),
      ]);
      userRole = fetchedUserRole;
      if (allRoles.length > 0) {
        roleHierarchyLine = allRoles
          .map(
            (r) =>
              `\`${r.name} (Tier ${r.priority} • CD ${formatDuration(r.cooldown_seconds)})\``
          )
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
            footer: `Your Effective RBA Role: ${userRole}`,
          }),
        ],
      });
    }

    const overviewEmbed = infoEmbed({
      title: 'Account Generator Bot — Help Menu',
      description: `Hello <@${interaction.user.id}>! Your effective RBA role is **${userRole}**.`,
      fields: [
        {
          name: 'Member & Generator Commands',
          value: [
            '`/help [command]` — View all commands or detailed command info.',
            '`/gen [service]` — Claim an account from stock (delivered via DM).',
            '`/stock [service]` • `/stocks` • `/services` — View stock & services.',
            '`/redeem [key]` — Redeem a license key for a timed/lifetime role.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Service & Restock Admin Commands',
          value: [
            '`/createservice` • `/editservice` • `/deleteservice` — Manage services.',
            '`/restock [service] [file]` — Bulk `.txt` restock + auto Restock Alert.',
            '`/addstock [service] [email] [password]` — Add single stock account.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Roles, Keys & Security Admin Commands',
          value: [
            '`/createrole` • `/editrole` • `/deleterole` • `/setrole` — Manage roles & sync.',
            '`/createkey [role] [duration] [amount]` — Generate subscription keys.',
            '`/blacklist add|remove|list` — Block abusive users.',
            '`/settings` — Configure Restock Alerts & alt-account age protection.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Active RBA Roles & Cooldowns',
          value: roleHierarchyLine,
          inline: false,
        },
      ],
      footer: 'Tip: Run /help command:<name> for detailed usage examples.',
    });

    return interaction.editReply({ embeds: [overviewEmbed] });
  },
};
