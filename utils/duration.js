const crypto = require('node:crypto');

const DISCORD_EPOCH_MS = 1420070400000n;
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Parses a human-readable duration string (e.g., '30s', '5m', '12h', '7d', '2w', 'lifetime')
 * or plain integer seconds into `{ ok, seconds }`, where `seconds: null` denotes lifetime.
 *
 * @param {string | number} raw
 * @param {{ allowZero?: boolean, allowLifetime?: boolean }} [options]
 * @returns {{ ok: boolean, seconds: number | null, error?: string }}
 */
function parseDurationInput(
  raw,
  { allowZero = false, allowLifetime = true } = {}
) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || (!allowZero && raw === 0)) {
      return { ok: false, seconds: null, error: 'Invalid numeric duration.' };
    }
    return { ok: true, seconds: raw };
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, seconds: null, error: 'Duration cannot be empty.' };
  }

  const normalized = raw.trim().toLowerCase();

  if (
    allowLifetime &&
    ['lifetime', 'perm', 'permanent', 'forever', 'never'].includes(normalized)
  ) {
    return { ok: true, seconds: null };
  }

  if (allowZero && (normalized === '0' || normalized === '0s' || normalized === 'none' || normalized === 'off')) {
    return { ok: true, seconds: 0 };
  }

  // Plain integer treated as seconds
  if (/^\d+$/.test(normalized)) {
    const secs = Number.parseInt(normalized, 10);
    if (!allowZero && secs === 0) {
      return { ok: false, seconds: null, error: 'Duration must be greater than 0.' };
    }
    return { ok: true, seconds: secs };
  }

  const match = normalized.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks)$/);
  if (!match) {
    return {
      ok: false,
      seconds: null,
      error: 'Use formats like `30s`, `5m`, `12h`, `7d`, `30d`, or `lifetime`.',
    };
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2][0];

  const multipliers = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };

  const seconds = amount * multipliers[unit];
  if (!allowZero && seconds === 0) {
    return { ok: false, seconds: null, error: 'Duration must be greater than 0.' };
  }

  return { ok: true, seconds };
}

/**
 * Formats a duration in seconds (or null for lifetime) into clean human text.
 *
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return 'Lifetime';
  if (seconds <= 0) return 'None (0s)';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Generates a cryptographically secure license key in the format `DISC-XXXX-XXXX-XXXX`.
 *
 * @returns {string}
 */
function generateLicenseKeyCode() {
  const segments = [];
  for (let seg = 0; seg < 3; seg++) {
    let chunk = '';
    for (let i = 0; i < 4; i++) {
      const idx = crypto.randomInt(0, KEY_ALPHABET.length);
      chunk += KEY_ALPHABET[idx];
    }
    segments.push(chunk);
  }
  return `DISC-${segments.join('-')}`;
}

/**
 * Computes a Discord user's account creation timestamp (ms since Unix epoch).
 * Uses `user.createdTimestamp` if available, or extracts it directly from a valid Snowflake ID.
 *
 * @param {{ id: string, createdTimestamp?: number }} user
 * @returns {number | null}
 */
function getDiscordUserCreatedTimestamp(user) {
  if (!user) return null;
  if (typeof user.createdTimestamp === 'number' && Number.isFinite(user.createdTimestamp)) {
    return user.createdTimestamp;
  }
  if (typeof user.id === 'string' && /^\d{17,20}$/.test(user.id)) {
    try {
      return Number((BigInt(user.id) >> 22n) + DISCORD_EPOCH_MS);
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = {
  parseDurationInput,
  formatDuration,
  generateLicenseKeyCode,
  getDiscordUserCreatedTimestamp,
};
