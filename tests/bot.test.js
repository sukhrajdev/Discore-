const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');

const supabase = require('../config/supabase');
const { loadCommands } = require('../handlers/commandHandler');
const { hasRequiredRole, normalizeRole, getOrCreateUserRole } = require('../utils/rba');

const genCommand = require('../commands/generator/gen');
const stockCommand = require('../commands/generator/stock');
const createServiceCommand = require('../commands/admin/createservice');
const addStockCommand = require('../commands/admin/addstock');
const setRoleCommand = require('../commands/admin/setrole');

/**
 * In-memory mock of Supabase (PostgREST + atomic RPC) to verify all command flows
 * including concurrent /gen calls and DM failure rollbacks.
 */
function createMockSupabase(initialState = {}) {
  const db = {
    users: new Map(Object.entries(initialState.users || {})),
    services: new Map(Object.entries(initialState.services || {})),
    stock: [...(initialState.stock || [])],
  };

  let nextUuidCounter = 1;

  return {
    db,

    async rpc(fnName, params) {
      if (fnName === 'claim_stock_account') {
        const idx = db.stock.findIndex(
          (item) => item.service_name === params.p_service_name
        );
        if (idx === -1) {
          return { data: [], error: null };
        }
        const [claimed] = db.stock.splice(idx, 1);
        return { data: [claimed], error: null };
      }
      return { data: null, error: new Error(`Unknown RPC: ${fnName}`) };
    },

    from(table) {
      const filters = {};
      let selectOptions = {};
      let operation = 'select';
      let payload = null;
      let upsertOptions = {};

      const builder = {
        select(_columns, options = {}) {
          selectOptions = options;
          return builder;
        },

        eq(column, value) {
          filters[column] = value;
          return builder;
        },

        async maybeSingle() {
          if (table === 'users') {
            const role = db.users.get(filters.discord_id);
            return {
              data: role ? { discord_id: filters.discord_id, rba_role: role } : null,
              error: null,
            };
          }
          if (table === 'services') {
            const svc = db.services.get(filters.name);
            return { data: svc || null, error: null };
          }
          return { data: null, error: null };
        },

        insert(row) {
          operation = 'insert';
          payload = row;
          return builder;
        },

        upsert(row, options = {}) {
          operation = 'upsert';
          payload = row;
          upsertOptions = options;
          return builder;
        },

        async single() {
          const res = await builder._executeWrite();
          return res;
        },

        then(resolve, reject) {
          if (operation === 'insert' || operation === 'upsert') {
            return builder._executeWrite().then(resolve, reject);
          }
          if (selectOptions.head && selectOptions.count === 'exact') {
            const count = db.stock.filter(
              (s) => s.service_name === filters.service_name
            ).length;
            return Promise.resolve({ data: null, count, error: null }).then(
              resolve,
              reject
            );
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },

        async _executeWrite() {
          if (table === 'users' && operation === 'upsert') {
            const exists = db.users.has(payload.discord_id);
            if (!exists || !upsertOptions.ignoreDuplicates) {
              db.users.set(payload.discord_id, payload.rba_role || 'Free');
            }
            return {
              data: {
                discord_id: payload.discord_id,
                rba_role: db.users.get(payload.discord_id),
              },
              error: null,
            };
          }

          if (table === 'services' && operation === 'insert') {
            if (db.services.has(payload.name)) {
              return { data: null, error: { code: '23505', message: 'duplicate key' } };
            }
            db.services.set(payload.name, { ...payload });
            return { data: { ...payload }, error: null };
          }

          if (table === 'stock' && operation === 'insert') {
            if (!db.services.has(payload.service_name)) {
              return {
                data: null,
                error: { code: '23503', message: 'foreign key violation' },
              };
            }
            const record = {
              id: payload.id || `00000000-0000-0000-0000-${String(nextUuidCounter++).padStart(12, '0')}`,
              service_name: payload.service_name,
              email: payload.email,
              password: payload.password,
            };
            db.stock.push(record);
            return { data: record, error: null };
          }

          return { data: null, error: null };
        },
      };

      return builder;
    },
  };
}

/**
 * Helper to create a mock Discord ChatInputCommandInteraction.
 */
function createMockInteraction({
  userId = '111111111111111111',
  channelId = '999999999999999999',
  inGuild = true,
  options = {},
  dmShouldFail = false,
} = {}) {
  const state = {
    deferred: false,
    deferOptions: undefined,
    replyContent: null,
    dmsSent: [],
  };

  return {
    state,
    channelId,
    inGuild: () => inGuild,
    user: {
      id: userId,
      async send(content) {
        if (dmShouldFail) {
          const err = new Error('Cannot send messages to this user');
          err.code = 50007;
          throw err;
        }
        state.dmsSent.push(content);
      },
    },
    options: {
      getString(key) {
        return options[key] ?? null;
      },
      getChannel(key) {
        return options[key] ?? null;
      },
      getUser(key) {
        return options[key] ?? null;
      },
    },
    async deferReply(opts) {
      state.deferred = true;
      state.deferOptions = opts;
    },
    async editReply(payload) {
      state.replyContent = typeof payload === 'string' ? payload : payload.content;
      return state.replyContent;
    },
  };
}

test('Command Loader loads all 5 modular slash commands with valid JSON schemas', () => {
  const commands = loadCommands();
  assert.equal(commands.size, 5);

  const expectedNames = ['gen', 'stock', 'createservice', 'addstock', 'setrole'];
  for (const name of expectedNames) {
    assert.ok(commands.has(name), `Expected command /${name} to be loaded`);
    const json = commands.get(name).data.toJSON();
    assert.equal(json.name, name);
  }
});

test('RBA role hierarchy and normalization work accurately and fail closed', async () => {
  assert.equal(normalizeRole('free'), 'Free');
  assert.equal(normalizeRole('PREMIUM'), 'Premium');
  assert.equal(normalizeRole('Admin'), 'Admin');
  assert.equal(normalizeRole('UnknownRole'), null);

  assert.equal(hasRequiredRole('Free', 'Free'), true);
  assert.equal(hasRequiredRole('Free', 'Premium'), false);
  assert.equal(hasRequiredRole('Premium', 'Free'), true);
  assert.equal(hasRequiredRole('Premium', 'Premium'), true);
  assert.equal(hasRequiredRole('Premium', 'Admin'), false);
  assert.equal(hasRequiredRole('Admin', 'Free'), true);
  assert.equal(hasRequiredRole('Admin', 'Premium'), true);
  assert.equal(hasRequiredRole('Admin', 'Admin'), true);
  assert.equal(hasRequiredRole('Invalid', 'Free'), false);
  assert.equal(hasRequiredRole('Admin', 'Invalid'), false);

  const mockDb = createMockSupabase();
  const defaultRole = await getOrCreateUserRole(mockDb, '222222222222222222');
  assert.equal(defaultRole, 'Free');
  assert.equal(mockDb.db.users.get('222222222222222222'), 'Free');
});

test('/gen replies publicly with unavailable message on missing service, wrong channel, low role, or empty stock', async () => {
  const mockDb = createMockSupabase({
    users: {
      free_user: 'Free',
      premium_user: 'Premium',
    },
    services: {
      netflix: {
        name: 'netflix',
        required_role: 'Premium',
        channel_id: 'chan_netflix',
      },
    },
    stock: [],
  });
  supabase.setSupabaseClient(mockDb);

  // 1. Non-existent service
  const nonExistentInteraction = createMockInteraction({
    userId: 'premium_user',
    channelId: 'chan_netflix',
    options: { service: 'unknown' },
  });
  await genCommand.execute(nonExistentInteraction);
  assert.equal(nonExistentInteraction.state.deferOptions, undefined); // Public reply
  assert.equal(nonExistentInteraction.state.replyContent, 'Currently not available for you.');

  // 2. Wrong channel_id
  const wrongChannelInteraction = createMockInteraction({
    userId: 'premium_user',
    channelId: 'wrong_channel',
    options: { service: 'netflix' },
  });
  await genCommand.execute(wrongChannelInteraction);
  assert.equal(wrongChannelInteraction.state.replyContent, 'Currently not available for you.');

  // 3. Insufficient RBA role (Free < Premium)
  const lowRoleInteraction = createMockInteraction({
    userId: 'free_user',
    channelId: 'chan_netflix',
    options: { service: 'netflix' },
  });
  await genCommand.execute(lowRoleInteraction);
  assert.equal(lowRoleInteraction.state.replyContent, 'Currently not available for you.');

  // 4. Out of stock (0 rows)
  const emptyStockInteraction = createMockInteraction({
    userId: 'premium_user',
    channelId: 'chan_netflix',
    options: { service: 'netflix' },
  });
  await genCommand.execute(emptyStockInteraction);
  assert.equal(emptyStockInteraction.state.replyContent, 'Currently not available for you.');
});

test('/gen atomically claims & deletes 1 stock row, DMs user, prevents race conditions, and rolls back on closed DMs', async () => {
  const mockDb = createMockSupabase({
    users: {
      user_a: 'Premium',
      user_b: 'Admin',
    },
    services: {
      mcfa: {
        name: 'mcfa',
        required_role: 'Premium',
        channel_id: 'chan_gen',
      },
    },
    stock: [
      {
        id: 'acc-1',
        service_name: 'mcfa',
        email: 'steve@example.com',
        password: 'secretPassword123',
      },
    ],
  });
  supabase.setSupabaseClient(mockDb);

  // Concurrent /gen invocations when only 1 account is in stock
  const interactionA = createMockInteraction({
    userId: 'user_a',
    channelId: 'chan_gen',
    options: { service: 'mcfa' },
  });
  const interactionB = createMockInteraction({
    userId: 'user_b',
    channelId: 'chan_gen',
    options: { service: 'mcfa' },
  });

  await Promise.all([
    genCommand.execute(interactionA),
    genCommand.execute(interactionB),
  ]);

  const replies = [interactionA.state.replyContent, interactionB.state.replyContent];
  assert.equal(
    replies.filter((r) => r === 'Check your DMs! I have sent you the account.').length,
    1
  );
  assert.equal(
    replies.filter((r) => r === 'Currently not available for you.').length,
    1
  );
  assert.equal(mockDb.db.stock.length, 0);

  const winner =
    interactionA.state.dmsSent.length === 1 ? interactionA : interactionB;
  assert.equal(
    winner.state.dmsSent[0],
    'Congratulations you got a mcfa account here:\nEmail: steve@example.com\nPass: secretPassword123'
  );

  // Test compensating rollback if user has DMs closed
  mockDb.db.stock.push({
    id: 'acc-2',
    service_name: 'mcfa',
    email: 'alex@example.com',
    password: 'keepSafePassword',
  });

  const closedDmInteraction = createMockInteraction({
    userId: 'user_a',
    channelId: 'chan_gen',
    options: { service: 'mcfa' },
    dmShouldFail: true,
  });

  await genCommand.execute(closedDmInteraction);
  assert.equal(mockDb.db.stock.length, 1);
  assert.equal(mockDb.db.stock[0].id, 'acc-2');
});

test('/stock returns exact formatted count and Admin commands enforce Admin RBA role', async () => {
  const mockDb = createMockSupabase({
    users: {
      admin_1: 'Admin',
      free_1: 'Free',
    },
    services: {},
    stock: [],
  });
  supabase.setSupabaseClient(mockDb);

  // Non-admin rejected from /createservice
  const nonAdminAttempt = createMockInteraction({
    userId: 'free_1',
    options: {
      name: 'mcfa',
      role: 'Free',
      channel: { id: 'chan_mcfa' },
    },
  });
  await createServiceCommand.execute(nonAdminAttempt);
  assert.deepEqual(nonAdminAttempt.state.deferOptions, {
    flags: MessageFlags.Ephemeral,
  });
  assert.match(nonAdminAttempt.state.replyContent, /Access denied/);

  // Admin creates 'mcfa' service
  const createSvc = createMockInteraction({
    userId: 'admin_1',
    options: {
      name: 'mcfa',
      role: 'Free',
      channel: { id: 'chan_mcfa' },
    },
  });
  await createServiceCommand.execute(createSvc);
  assert.ok(mockDb.db.services.has('mcfa'));

  // Admin adds 15 stock accounts via /addstock
  for (let i = 1; i <= 15; i++) {
    const addStockInt = createMockInteraction({
      userId: 'admin_1',
      options: {
        service: 'mcfa',
        email: `user${i}@example.com`,
        password: `pass${i}`,
      },
    });
    await addStockCommand.execute(addStockInt);
  }

  // Check /stock output matches prompt specification verbatim
  const stockInt = createMockInteraction({
    userId: 'free_1',
    options: { service: 'mcfa' },
  });
  await stockCommand.execute(stockInt);
  assert.equal(
    stockInt.state.replyContent,
    'There are currently 15 accounts in stock for mcfa.'
  );

  // Admin promotes free_1 to Premium via /setrole
  const setRoleInt = createMockInteraction({
    userId: 'admin_1',
    options: {
      user: { id: 'free_1' },
      role: 'Premium',
    },
  });
  await setRoleCommand.execute(setRoleInt);
  assert.equal(mockDb.db.users.get('free_1'), 'Premium');
});
