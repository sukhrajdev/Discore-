require('dotenv').config();
const supabase = require('../config/supabase');

async function seedAdmin() {
  const discordId = process.argv[2]?.trim();

  if (!discordId || !/^\d{17,20}$/.test(discordId)) {
    console.error('Usage: npm run seed-admin -- <DISCORD_USER_ID>');
    console.error('Example: npm run seed-admin -- 123456789012345678');
    process.exit(1);
  }

  supabase.validateSupabaseEnv();

  const { data, error } = await supabase
    .from('users')
    .upsert({ discord_id: discordId, rba_role: 'Admin' }, { onConflict: 'discord_id' })
    .select('discord_id, rba_role')
    .single();

  if (error) {
    console.error('[SeedAdmin] Failed to assign Admin role:', error.message);
    process.exit(1);
  }

  console.log(
    `[SeedAdmin] Successfully assigned '${data.rba_role}' role to Discord ID ${data.discord_id}.`
  );
}

seedAdmin();
