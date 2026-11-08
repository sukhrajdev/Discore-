require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

let clientInstance = null;

/**
 * Ensures SUPABASE_URL and SUPABASE_SERVICE_KEY are present in the environment.
 */
function validateSupabaseEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required Supabase environment variable(s): ${missing.join(', ')}. Please configure your .env file.`
    );
  }
}

/**
 * Lazily initializes and returns the singleton Supabase service-role client.
 */
function getSupabaseClient() {
  if (!clientInstance) {
    validateSupabaseEnv();
    clientInstance = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );
  }
  return clientInstance;
}

/**
 * Allows injecting a mock Supabase client in automated tests.
 * @param {object|null} customClient
 */
function setSupabaseClient(customClient) {
  clientInstance = customClient;
}

const supabase = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'validateSupabaseEnv') return validateSupabaseEnv;
      if (prop === 'getSupabaseClient') return getSupabaseClient;
      if (prop === 'setSupabaseClient') return setSupabaseClient;

      const client = getSupabaseClient();
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
  }
);

module.exports = supabase;
