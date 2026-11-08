const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const supabase = require('../../config/supabase');
const { infoEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('services')
    .setDescription('List all available generator services, required roles, and channels')
    .setContexts(InteractionContextType.Guild),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    const { data: services, error } = await supabase
      .from('services')
      .select('name, required_role, channel_id')
      .order('name', { ascending: true });

    if (error) {
      throw error;
    }

    if (!Array.isArray(services) || services.length === 0) {
      return interaction.editReply({
        embeds: [
          infoEmbed({
            title: 'Generator Services',
            description: 'No generator services have been created yet.',
          }),
        ],
      });
    }

    const lines = services.map(
      (svc) =>
        `• **${svc.name}** — Role: **${svc.required_role}** • Channel: <#${svc.channel_id}>`
    );

    let description = lines.join('\n');
    if (description.length > 3900) {
      description = `${description.slice(0, 3900)}\n*...list truncated*`;
    }

    return interaction.editReply({
      embeds: [
        infoEmbed({
          title: 'Available Generator Services',
          description,
          fields: [
            {
              name: 'Total Services',
              value: `\`${services.length}\``,
              inline: true,
            },
          ],
          footer: 'Run /stocks to check stock counts or /gen [service] to claim an account.',
        }),
      ],
    });
  },
};
