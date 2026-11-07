const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../../config/supabase');
const { getOrCreateUserRole } = require('../../utils/rba');
const { infoEmbed, errorEmbed } = require('../../utils/embeds');

const COMMAND_DETAILS = Object.freeze({
  help: {
    usage: '/help [command]',
    role: 'Free (Everyone)',
    visibility: 'Public Embed',
    description:
      'Displays all available bot commands, your current RBA role, or detailed usage information for a specific command.',
    example: '/help command:gen',
  },
  gen: {
    usage: '/gen [service]',
    role: 'Matches or exceeds service required_role',
    visibility: 'Public Embed + Direct Message Embed',
    description:
      'Atomically claims and deletes 1 account from the requested service stock (when executed inside the designated channel) and sends the credentials to your DMs.',
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
  createservice: {
    usage: '/createservice [name] [role] [channel]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Creates a new generator service linked to a minimum RBA role (Free, Premium, or Admin) and a specific Discord channel.',
    example: '/createservice name:mcfa role:Premium channel:#gen-mcfa',
  },
  addstock: {
    usage: '/addstock [service] [email] [password]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      'Adds a new account (email + password) into the Stock pool for an existing service without exposing credentials publicly.',
    example: '/addstock service:mcfa email:user@example.com password:secretPassword',
  },
  setrole: {
    usage: '/setrole [user] [role]',
    role: 'Admin',
    visibility: 'Ephemeral Embed',
    description:
      "Updates a user's RBA role in the database (Free, Premium, or Admin). Existing Admins can use this command to promote other users to Admin.",
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
          { name: '/help', value: 'help' },
          { name: '/gen', value: 'gen' },
          { name: '/stock', value: 'stock' },
          { name: '/createservice', value: 'createservice' },
          { name: '/addstock', value: 'addstock' },
          { name: '/setrole', value: 'setrole' }
        )
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    let userRole = 'Free';
    try {
      userRole = await getOrCreateUserRole(supabase, interaction.user.id);
    } catch {
      // Fall back gracefully to 'Free' display if database lookup fails
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
            '`/gen [service]` — Generate an account in the service channel (sent via DM).',
            '`/stock [service]` — Check how many accounts remain in stock for a service.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Admin Commands (Requires Admin RBA Role)',
          value: [
            '`/createservice [name] [role] [channel]` — Create a new generator service.',
            '`/addstock [service] [email] [password]` — Add an account to service stock.',
            '`/setrole [user] [role]` — Assign `Free`, `Premium`, or `Admin` role to a user.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'RBA Role Hierarchy',
          value: '`Free` ➜ `Premium` ➜ `Admin`',
          inline: false,
        },
      ],
      footer: 'Tip: Run /help command:<name> for detailed usage examples.',
    });

    return interaction.editReply({ embeds: [overviewEmbed] });
  },
};
