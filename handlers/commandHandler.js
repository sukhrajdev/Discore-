const fs = require('node:fs');
const path = require('node:path');
const { Collection, Events, MessageFlags } = require('discord.js');
const { errorEmbed } = require('../utils/embeds');

/**
 * Recursively collects all `.js` command files under a given directory.
 *
 * @param {string} dirPath
 * @returns {string[]}
 */
function getCommandFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getCommandFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Loads and validates all command modules from `commands/`.
 *
 * @param {string} [commandsDir]
 * @returns {Collection<string, { data: import('discord.js').SlashCommandBuilder, execute: Function, autocomplete?: Function }>}
 */
function loadCommands(commandsDir = path.join(__dirname, '..', 'commands')) {
  const commands = new Collection();
  const commandFiles = getCommandFiles(commandsDir);

  for (const filePath of commandFiles) {
    const command = require(filePath);

    if (!command || !('data' in command) || typeof command.execute !== 'function') {
      console.warn(
        `[WARNING] Skipping invalid command module at ${filePath} (missing "data" or "execute").`
      );
      continue;
    }

    commands.set(command.data.name, command);
  }

  return commands;
}

/**
 * Registers slash commands on the Discord client and binds the InteractionCreate listener.
 *
 * @param {import('discord.js').Client} client
 */
function registerCommandHandler(client) {
  client.commands = loadCommands();
  console.log(`[CommandHandler] Loaded ${client.commands.size} slash command(s).`);

  client.on(Events.InteractionCreate, async (interaction) => {
    // Handle Slash Command Autocomplete
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command && typeof command.autocomplete === 'function') {
        await command.autocomplete(interaction);
      }
      return;
    }

    // Handle Slash Commands
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.warn(`[CommandHandler] Unknown command invoked: /${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(
        `[CommandHandler] Unhandled error while executing /${interaction.commandName}:`,
        error
      );

      const fallbackEmbed = errorEmbed({
        title: 'Unexpected Error',
        description: 'An unexpected internal error occurred while processing your command.',
      });

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ embeds: [fallbackEmbed] });
        } else {
          await interaction.reply({
            embeds: [fallbackEmbed],
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyError) {
        console.error('[CommandHandler] Failed to send fallback error reply:', replyError);
      }
    }
  });
}

module.exports = {
  getCommandFiles,
  loadCommands,
  registerCommandHandler,
};
