require('dotenv').config();
const { Client, Events, GatewayIntentBits } = require('discord.js');
const supabase = require('./config/supabase');
const { registerCommandHandler } = require('./handlers/commandHandler');

/**
 * Validates required environment variables before connecting to Discord.
 */
function validateEnvironment() {
  const requiredVars = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
  ];

  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and populate all values.`
    );
  }

  supabase.validateSupabaseEnv();
}

async function bootstrap() {
  validateEnvironment();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  // Load modular slash commands and register InteractionCreate dispatcher
  registerCommandHandler(client);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[Bot] Logged in and ready as ${readyClient.user.tag} (ID: ${readyClient.user.id})`);
  });

  // Graceful shutdown handling
  const shutdown = (signal) => {
    console.log(`[Bot] Received ${signal}. Shutting down Discord client cleanly...`);
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(process.env.DISCORD_TOKEN);
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('[Bot] Fatal startup error:', error.message);
    process.exit(1);
  });
}

module.exports = { bootstrap, validateEnvironment };
