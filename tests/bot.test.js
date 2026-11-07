const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');

const supabase = require('../config/supabase');
const { loadCommands } = require('../handlers/commandHandler');
const { hasRequiredRole, normalizeRole, getOrCreateUserRole } = require('../utils/rba');

const helpCommand = require('../commands/general/help');
const genCommand = require('../commands/generator/gen');
const stockCommand = require('../commands/generator/stock');
const createServiceCommand = require('../commands/admin/createservice');
const addStockCommand = require('../commands/admin/addstock');
const setRoleCommand = require('../commands/admin/setrole');

/**
 * In-memory mock of Supabase (PostgREST + atomic RPC) to verify all command flows
 * including concurrent /gen calls, Admin-to-Admin promotion, and DM failure rollbacks.
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
              id:
                payload.id ||
                `00000000-0000-0000-0000-${String(nextUuidCounter++).padStart(12, '0')}`,
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
 * Helper to extract serialized embed JSON from an interaction reply or DM payload.
 */
function extractFirstEmbed(payload) {
  assert.ok(payload && typeof payload === 'object', 'Expected reply payload object');
  assert.ok(
    Array.isArray(payload.embeds) && payload.embeds.length === 1,
    'Expected reply payload to contain an embed'
  );
  const raw = payload.embeds[0];
  return typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
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
    replyPayload: null,
    dmsSent: [],
  };

  return {
    state,
    channelId,
    inGuild: () => inGuild,
    user: {
      id: userId,
      async send(payload) {
        if (dmShouldFail) {
          const err = new Error('Cannot send messages to this user');
          err.code = 50007;
          throw err;
        }
        state.dmsSent.push(payload);
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
      state.replyPayload = payload;
      return payload;
    },
  };
}

test('Command Loader loads all 6 modular slash commands including /help', () => {
  const commands = loadCommands();
  assert.equal(commands.size, 6);

  const expectedNames = ['help', 'gen', 'stock', 'createservice', 'addstock', 'setrole'];
  for (const name of expectedNames) {
    assert.ok(commands.has(name), `Expected command /${name} to be loaded`);
    const json = commands.get(name).data.toJSON();
    assert.equal(json.name, name);
  }
});

test('/help returns rich overview embed and per-command embed with caller RBA role', async () => {
  const mockDb = createMockSupabase({
    users: { premium_member: 'Premium' },
  });
  supabase.setSupabaseClient(mockDb);

  // Overview help menu
  const overviewInt = createMockInteraction({
    userId: 'premium_member',
    options: {},
  });
  await helpCommand.execute(overviewInt);
  const overviewEmbed = extractFirstEmbed(overviewInt.state.replyPayload);
  assert.equal(overviewEmbed.title, 'Account Generator Bot — Help Menu');
  assert.match(overviewEmbed.description, /Premium/);
  assert.equal(overviewEmbed.fields.length, 3);

  // Specific command help (/help command:setrole)
  const detailInt = createMockInteraction({
    userId: 'premium_member',
    options: { command: 'setrole' },
  });
  await helpCommand.execute(detailInt);
  const detailEmbed = extractFirstEmbed(detailInt.state.replyPayload);
  assert.equal(detailEmbed.title, 'Command Help — /setrole');
  assert.match(detailEmbed.description, /promote other users to Admin/);
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

test('/gen replies publicly with unavailable embed on missing service, wrong channel, low role, or empty stock', async () => {
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

  const cases = [
    { userId: 'premium_user', channelId: 'chan_netflix', options: { service: 'unknown' } },
    { userId: 'premium_user', channelId: 'wrong_channel', options: { service: 'netflix' } },
    { userId: 'free_user', channelId: 'chan_netflix', options: { service: 'netflix' } },
    { userId: 'premium_user', channelId: 'chan_netflix', options: { service: 'netflix' } },
  ];

  for (const testCase of cases) {
    const interaction = createMockInteraction(testCase);
    await genCommand.execute(interaction);
    assert.equal(interaction.state.deferOptions, undefined); // Public reply
    const embed = extractFirstEmbed(interaction.state.replyPayload);
    assert.equal(embed.description, 'Currently not available for you.');
  }
});

test('/gen atomically claims & deletes 1 stock row, sends DM embed, prevents race conditions, and rolls back on closed DMs', async () => {
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

  const embedA = extractFirstEmbed(interactionA.state.replyPayload);
  const embedB = extractFirstEmbed(interactionB.state.replyPayload);
  const descriptions = [embedA.description, embedB.description];

  assert.equal(
    descriptions.filter((d) => d === 'Check your DMs! I have sent you the account.').length,
    1
  );
  assert.equal(
    descriptions.filter((d) => d === 'Currently not available for you.').length,
    1
  );
  assert.equal(mockDb.db.stock.length, 0);

  const winner =
    interactionA.state.dmsSent.length === 1 ? interactionA : interactionB;
  const dmEmbed = extractFirstEmbed(winner.state.dmsSent[0]);
  assert.equal(
    dmEmbed.description,
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
  const closedDmEmbed = extractFirstEmbed(closedDmInteraction.state.replyPayload);
  assert.equal(closedDmEmbed.title, 'Direct Messages Disabled');
  assert.equal(mockDb.db.stock.length, 1);
  assert.equal(mockDb.db.stock[0].id, 'acc-2');
});

test('Existing Admin can grant another user Admin, newly promoted Admin has full Admin powers, and /stock returns embed', async () => {
  const mockDb = createMockSupabase({
    users: {
      admin_1: 'Admin',
      free_1: 'Free',
    },
    services: {},
    stock: [],
  });
  supabase.setSupabaseClient(mockDb);

  // Non-admin rejected from /setrole with error embed
  const nonAdminAttempt = createMockInteraction({
    userId: 'free_1',
    options: {
      user: { id: 'someone_else', bot: false },
      role: 'Admin',
    },
  });
  await setRoleCommand.execute(nonAdminAttempt);
  assert.deepEqual(nonAdminAttempt.state.deferOptions, {
    flags: MessageFlags.Ephemeral,
  });
  assert.equal(extractFirstEmbed(nonAdminAttempt.state.replyPayload).title, 'Access Denied');

  // Admin cannot accidentally demote themselves from Admin
  const selfDemoteAttempt = createMockInteraction({
    userId: 'admin_1',
    options: {
      user: { id: 'admin_1', bot: false },
      role: 'Free',
    },
  });
  await setRoleCommand.execute(selfDemoteAttempt);
  assert.equal(
    extractFirstEmbed(selfDemoteAttempt.state.replyPayload).title,
    'Self-Demotion Blocked'
  );
  assert.equal(mockDb.db.users.get('admin_1'), 'Admin');

  // Existing Admin promotes another user (not even in DB yet: brand_new_admin) to Admin
  const grantAdminInt = createMockInteraction({
    userId: 'admin_1',
    options: {
      user: { id: 'brand_new_admin', bot: false },
      role: 'Admin',
    },
  });
  await setRoleCommand.execute(grantAdminInt);
  const grantAdminEmbed = extractFirstEmbed(grantAdminInt.state.replyPayload);
  assert.equal(grantAdminEmbed.title, 'Admin Role Granted');
  assert.equal(mockDb.db.users.get('brand_new_admin'), 'Admin');

  // Newly promoted Admin can immediately create services, add stock, AND grant Admin to a 3rd user
  const createSvc = createMockInteraction({
    userId: 'brand_new_admin',
    options: {
      name: 'mcfa',
      role: 'Free',
      channel: { id: 'chan_mcfa' },
    },
  });
  await createServiceCommand.execute(createSvc);
  assert.equal(extractFirstEmbed(createSvc.state.replyPayload).title, 'Service Created');
  assert.ok(mockDb.db.services.has('mcfa'));

  // Newly promoted Admin adds 15 stock accounts via /addstock
  for (let i = 1; i <= 15; i++) {
    const addStockInt = createMockInteraction({
      userId: 'brand_new_admin',
      options: {
        service: 'mcfa',
        email: `user${i}@example.com`,
        password: `pass${i}`,
      },
    });
    await addStockCommand.execute(addStockInt);
    assert.equal(extractFirstEmbed(addStockInt.state.replyPayload).title, 'Stock Added');
  }

  // Newly promoted Admin promotes free_1 to Admin as well
  const secondAdminPromotion = createMockInteraction({
    userId: 'brand_new_admin',
    options: {
      user: { id: 'free_1', bot: false },
      role: 'Admin',
    },
  });
  await setRoleCommand.execute(secondAdminPromotion);
  assert.equal(mockDb.db.users.get('free_1'), 'Admin');

  // Check /stock embed output matches specification verbatim
  const stockInt = createMockInteraction({
    userId: 'free_1',
    options: { service: 'mcfa' },
  });
  await stockCommand.execute(stockInt);
  const stockEmbed = extractFirstEmbed(stockInt.state.replyPayload);
  assert.equal(
    stockEmbed.description,
    'There are currently 15 accounts in stock for mcfa.'
  );
});
