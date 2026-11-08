const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const supabase = require('../../config/supabase');
const { EMBED_COLORS, buildEmbed, infoEmbed } = require('../../utils/embeds');

/**
 * Fetches all services with their remaining stock count.
 * Uses the `get_all_service_stocks` RPC for single-query performance, with a
 * graceful fallback to `services` + parallel HEAD exact counts.
 */
async function fetchAllServiceStocks() {
  const { data: rpcData, error: rpcError } = await supabase.rpc('get_all_service_stocks');

  if (!rpcError && Array.isArray(rpcData)) {
    return rpcData.map((row) => ({
      name: row.name,
      required_role: row.required_role,
      channel_id: row.channel_id,
      stock_count: Number(row.stock_count ?? 0),
    }));
  }

  // Fallback: fetch all services and run exact zero-payload HEAD counts in parallel
  const { data: services, error: servicesError } = await supabase
    .from('services')
    .select('name, required_role, channel_id')
    .order('name', { ascending: true });

  if (servicesError) throw servicesError;
  if (!Array.isArray(services) || services.length === 0) return [];

  const counts = await Promise.all(
    services.map(async (svc) => {
      const { count, error } = await supabase
        .from('stock')
        .select('*', { count: 'exact', head: true })
        .eq('service_name', svc.name);
      if (error) throw error;
      return {
        ...svc,
        stock_count: count ?? 0,
      };
    })
  );

  return counts;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stocks')
    .setDescription('View remaining account stock across all generator services')
    .setContexts(InteractionContextType.Guild),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    const serviceStocks = await fetchAllServiceStocks();

    if (serviceStocks.length === 0) {
      return interaction.editReply({
        embeds: [
          infoEmbed({
            title: 'All Service Stocks',
            description: 'No generator services have been created yet.',
          }),
        ],
      });
    }

    const totalAccounts = serviceStocks.reduce((sum, s) => sum + s.stock_count, 0);
    const inStockServices = serviceStocks.filter((s) => s.stock_count > 0).length;

    const lines = serviceStocks.map((svc) => {
      const indicator = svc.stock_count > 0 ? '🟢' : '🔴';
      return `${indicator} **${svc.name}**: \`${svc.stock_count}\` remaining`;
    });

    // Respect Discord's 4096-character embed description limit
    let description = lines.join('\n');
    if (description.length > 3900) {
      description = `${description.slice(0, 3900)}\n*...list truncated*`;
    }

    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'All Service Stocks',
          description,
          color: totalAccounts > 0 ? EMBED_COLORS.SUCCESS : EMBED_COLORS.WARNING,
          fields: [
            {
              name: 'Total Services',
              value: `\`${serviceStocks.length}\` (\`${inStockServices}\` in stock)`,
              inline: true,
            },
            {
              name: 'Total Accounts Remaining',
              value: `\`${totalAccounts}\``,
              inline: true,
            },
          ],
          footer: 'Use /gen [service] inside the service channel to claim an account.',
        }),
      ],
    });
  },
};
