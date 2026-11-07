require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { loadCommands } = require('./handlers/commandHandler');

async function deployCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    throw new Error(
      'Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in your .env file.'
    );
  }

  const commandsCollection = loadCommands();
  const commandPayloads = commandsCollection.map((cmd) => cmd.data.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    console.log(
      `[Deploy] Registering ${commandPayloads.length} guild slash command(s) to guild ${guildId}...`
    );
    const data = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commandPayloads }
    );
    console.log(`[Deploy] Successfully registered ${data.length} guild slash command(s).`);
  } else {
    console.log(
      `[Deploy] Registering ${commandPayloads.length} global slash command(s)...`
    );
    const data = await rest.put(Routes.applicationCommands(clientId), {
      body: commandPayloads,
    });
    console.log(
      `[Deploy] Successfully registered ${data.length} global slash command(s) (may take up to 1 hour to propagate globally).`
    );
  }
}

if (require.main === module) {
  deployCommands().catch((error) => {
    console.error('[Deploy] Failed to register slash commands:', error);
    process.exit(1);
  });
}

module.exports = { deployCommands };
