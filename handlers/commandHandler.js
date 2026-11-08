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
 * @returns {Collection<string, object>}
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
 * Sends a standardized fallback error embed regardless of interaction state.
 */
async function sendFallbackErrorEmbed(interaction) {
  const fallbackEmbed = errorEmbed({
    title: 'Unexpected Error',
    description: 'An unexpected internal error occurred while processing your interaction.',
  });

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ embeds: [fallbackEmbed], components: [] });
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

/**
 * Registers slash commands & interactive component handlers on the Discord client.
 *
 * @param {import('discord.js').Client} client
 */
function registerCommandHandler(client) {
  client.commands = loadCommands();
  console.log(`[CommandHandler] Loaded ${client.commands.size} slash command(s).`);

  client.on(Events.InteractionCreate, async (interaction) => {
    // 1. Handle Slash Command Autocomplete
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command && typeof command.autocomplete === 'function') {
        await command.autocomplete(interaction);
      }
      return;
    }

    // 2. Handle Interactive Components (Buttons, Select Menus, Modals)
    if (
      interaction.isButton() ||
      interaction.isAnySelectMenu() ||
      interaction.isModalSubmit()
    ) {
      const targetCommand = client.commands.find(
        (cmd) =>
          typeof cmd.componentPrefix === 'string' &&
          typeof interaction.customId === 'string' &&
          interaction.customId.startsWith(cmd.componentPrefix) &&
          typeof cmd.handleComponent === 'function'
      );

      if (targetCommand) {
        try {
          await targetCommand.handleComponent(interaction);
        } catch (error) {
          console.error(
            `[CommandHandler] Unhandled component error (${interaction.customId}):`,
            error
          );
          await sendFallbackErrorEmbed(interaction);
        }
      }
      return;
    }

    // 3. Handle Chat Input Slash Commands
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
      await sendFallbackErrorEmbed(interaction);
    }
  });
}

module.exports = {
  getCommandFiles,
  loadCommands,
  registerCommandHandler,
};
