const { EmbedBuilder } = require('discord.js');

const EMBED_COLORS = Object.freeze({
  PRIMARY: 0x5865f2, // Blurple
  SUCCESS: 0x57f287, // Green
  WARNING: 0xfee75c, // Amber
  ERROR: 0xed4245,   // Red
});

/**
 * Builds a standardized Discord EmbedBuilder instance.
 *
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.description]
 * @param {number} [options.color]
 * @param {Array<{ name: string, value: string, inline?: boolean }>} [options.fields]
 * @param {string} [options.footer]
 * @returns {EmbedBuilder}
 */
function buildEmbed({
  title,
  description,
  color = EMBED_COLORS.PRIMARY,
  fields = [],
  footer,
} = {}) {
  const embed = new EmbedBuilder().setColor(color).setTimestamp();

  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (Array.isArray(fields) && fields.length > 0) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });

  return embed;
}

function infoEmbed(options) {
  return buildEmbed({ ...options, color: EMBED_COLORS.PRIMARY });
}

function successEmbed(options) {
  return buildEmbed({ ...options, color: EMBED_COLORS.SUCCESS });
}

function warningEmbed(options) {
  return buildEmbed({ ...options, color: EMBED_COLORS.WARNING });
}

function errorEmbed(options) {
  return buildEmbed({ ...options, color: EMBED_COLORS.ERROR });
}

module.exports = {
  EMBED_COLORS,
  buildEmbed,
  infoEmbed,
  successEmbed,
  warningEmbed,
  errorEmbed,
};
