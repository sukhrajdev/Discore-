const test = require('node:test');
const assert = require('node:assert/strict');

const supabase = require('../config/supabase');
const { loadCommands } = require('../handlers/commandHandler');
const { hasRequiredRole, normalizeRole, getOrCreateUserRole } = require('../utils/rba');

const helpCommand = require('../commands/general/help');
const redeemCommand = require('../commands/general/redeem');
const genCommand = require('../commands/generator/gen');
const stockCommand = require('../commands/generator/stock');
const stocksCommand = require('../commands/generator/stocks');
const servicesCommand = require('../commands/generator/services');
const createServiceCommand = require('../commands/admin/createservice');
const editServiceCommand = require('../commands/admin/editservice');
const deleteServiceCommand = require('../commands/admin/deleteservice');
const addStockCommand = require('../commands/admin/addstock');
const restockCommand = require('../commands/admin/restock');
const createRoleCommand = require('../commands/admin/createrole');
const editRoleCommand = require('../commands/admin/editrole');
const deleteRoleCommand = require('../commands/admin/deleterole');
const setRoleCommand = require('../commands/admin/setrole');
const createKeyCommand = require('../commands/admin/createkey');
const blacklistCommand = require('../commands/admin/blacklist');
const settingsCommand = require('../commands/admin/settings');

/**
 * Full-featured in-memory mock of Supabase supporting:
 * `roles`, `users` (full objects or role strings), `services`, `stock`,
 * `license_keys`, `blacklist`, `bot_settings`, and atomic RPCs.
 */
function createMockSupabase(initialState = {}) {
  const defaultRoles = {
    Free: {
      name: 'Free',
      priority: 1,
      channel_id: null,
      cooldown_seconds: 0,
      discord_role_id: null,
      is_system: true,
    },
    Premium: {
      name: 'Premium',
      priority: 50,
      channel_id: null,
      cooldown_seconds: 0,
      discord_role_id: null,
      is_system: false,
    },
    Admin: {
      name: 'Admin',
      priority: 100,
      channel_id: null,
      cooldown_seconds: 0,
      discord_role_id: null,
      is_system: true,
    },
  };

  const normalizedUsers = new Map();
  for (const [uid, val] of Object.entries(initialState.users || {})) {
    if (typeof val === 'string') {
      normalizedUsers.set(uid, {
        discord_id: uid,
        rba_role: val,
        role_expires_at: null,
        last_gen_at: null,
      });
    } else {
      normalizedUsers.set(uid, {
        discord_id: uid,
        rba_role: val.rba_role || 'Free',
        role_expires_at: val.role_expires_at ?? null,
        last_gen_at: val.last_gen_at ?? null,
      });
    }
  }

  const db = {
    roles: new Map(
      Object.entries({ ...defaultRoles, ...(initialState.roles || {}) })
    ),
    users: normalizedUsers,
    services: new Map(Object.entries(initialState.services || {})),
    stock: [...(initialState.stock || [])],
    license_keys: new Map(Object.entries(initialState.license_keys || {})),
    blacklist: new Map(Object.entries(initialState.blacklist || {})),
    bot_settings: {
      id: 'default',
      restock_channel_id: null,
      restock_ping_role_id: null,
      min_account_age_days: 0,
      ...(initialState.bot_settings || {}),
    },
  };

  let nextUuidCounter = 1;

  return {
    db,

    async rpc(fnName, params) {
      if (fnName === 'claim_stock_account') {
        const idx = db.stock.findIndex(
          (item) => item.service_name === params.p_service_name
        );
        if (idx === -1) return { data: [], error: null };
        const [claimed] = db.stock.splice(idx, 1);
        return { data: [claimed], error: null };
      }

      if (fnName === 'get_all_service_stocks') {
        const rows = Array.from(db.services.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((svc) => ({
            name: svc.name,
            required_role: svc.required_role,
            channel_id: svc.channel_id,
            stock_count: db.stock.filter((s) => s.service_name === svc.name).length,
          }));
        return { data: rows, error: null };
      }

      if (fnName === 'redeem_license_key') {
        const keyRecord = db.license_keys.get(params.p_key);
        if (!keyRecord || keyRecord.redeemed_by) {
          return { data: [], error: null };
        }
        keyRecord.redeemed_by = params.p_discord_id;
        keyRecord.redeemed_at = new Date().toISOString();

        const existingUser = db.users.get(params.p_discord_id);
        let newExpiresAt = null;
        if (keyRecord.duration_seconds !== null && keyRecord.duration_seconds !== undefined) {
          const nowMs = Date.now();
          const currentExpiryMs =
            existingUser &&
            existingUser.rba_role.toLowerCase() === keyRecord.role_name.toLowerCase() &&
            existingUser.role_expires_at
              ? new Date(existingUser.role_expires_at).getTime()
              : 0;
          const baseMs = Math.max(nowMs, currentExpiryMs);
          newExpiresAt = new Date(
            baseMs + Number(keyRecord.duration_seconds) * 1000
          ).toISOString();
        }

        db.users.set(params.p_discord_id, {
          discord_id: params.p_discord_id,
          rba_role: keyRecord.role_name,
          role_expires_at: newExpiresAt,
          last_gen_at: existingUser?.last_gen_at ?? null,
        });

        return {
          data: [
            {
              role_name: keyRecord.role_name,
              duration_seconds: keyRecord.duration_seconds,
              new_expires_at: newExpiresAt,
            },
          ],
          error: null,
        };
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
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        ilike() {
          return builder;
        },
        insert(rowOrRows) {
          operation = 'insert';
          payload = rowOrRows;
          return builder;
        },
        upsert(row, options = {}) {
          operation = 'upsert';
          payload = row;
          upsertOptions = options;
          return builder;
        },
        update(values) {
          operation = 'update';
          payload = values;
          return builder;
        },
        delete() {
          operation = 'delete';
          return builder;
        },
        async maybeSingle() {
          const res = await builder._execute();
          const first = Array.isArray(res.data) ? res.data[0] || null : res.data;
          return { data: first, error: res.error };
        },
        async single() {
          const res = await builder._execute();
          const first = Array.isArray(res.data) ? res.data[0] || null : res.data;
          return { data: first, error: res.error };
        },
        then(resolve, reject) {
          return builder._execute().then(resolve, reject);
        },

        async _execute() {
          // ROLES
          if (table === 'roles') {
            if (operation === 'select') {
              let rows = Array.from(db.roles.values());
              if (filters.name !== undefined) {
                rows = rows.filter((r) => r.name === filters.name);
              }
              return { data: rows, count: rows.length, error: null };
            }
            if (operation === 'insert') {
              if (db.roles.has(payload.name)) {
                return { data: null, error: { code: '23505', message: 'duplicate key' } };
              }
              db.roles.set(payload.name, { ...payload });
              return { data: { ...payload }, error: null };
            }
            if (operation === 'upsert') {
              const exists = db.roles.has(payload.name);
              if (!exists || !upsertOptions.ignoreDuplicates) {
                db.roles.set(payload.name, { ...payload });
              }
              return { data: db.roles.get(payload.name), error: null };
            }
            if (operation === 'update') {
              const existing = db.roles.get(filters.name);
              if (!existing) return { data: [], error: null };
              const updated = { ...existing, ...payload };
              if (payload.name && payload.name !== filters.name) {
                db.roles.delete(filters.name);
              }
              db.roles.set(updated.name, updated);
              return { data: [updated], error: null };
            }
            if (operation === 'delete') {
              db.roles.delete(filters.name);
              return { data: [], error: null };
            }
          }

          // USERS
          if (table === 'users') {
            if (operation === 'select') {
              let rows = Array.from(db.users.values());
              if (filters.discord_id !== undefined) {
                rows = rows.filter((u) => u.discord_id === filters.discord_id);
              }
              if (filters.rba_role !== undefined) {
                rows = rows.filter((u) => u.rba_role === filters.rba_role);
              }
              if (selectOptions.head && selectOptions.count === 'exact') {
                return { data: null, count: rows.length, error: null };
              }
              return { data: rows, count: rows.length, error: null };
            }
            if (operation === 'upsert') {
              const exists = db.users.has(payload.discord_id);
              if (!exists) {
                db.users.set(payload.discord_id, {
                  discord_id: payload.discord_id,
                  rba_role: payload.rba_role || 'Free',
                  role_expires_at: payload.role_expires_at ?? null,
                  last_gen_at: payload.last_gen_at ?? null,
                });
              } else if (!upsertOptions.ignoreDuplicates) {
                const prev = db.users.get(payload.discord_id);
                db.users.set(payload.discord_id, { ...prev, ...payload });
              }
              return { data: db.users.get(payload.discord_id), error: null };
            }
            if (operation === 'update') {
              const updated = [];
              for (const [uid, u] of db.users.entries()) {
                const matchId = filters.discord_id === undefined || uid === filters.discord_id;
                const matchRole =
                  filters.rba_role === undefined || u.rba_role === filters.rba_role;
                if (matchId && matchRole) {
                  const next = { ...u, ...payload };
                  db.users.set(uid, next);
                  updated.push(next);
                }
              }
              return { data: updated, error: null };
            }
          }

          // SERVICES
          if (table === 'services') {
            if (operation === 'select') {
              let rows = Array.from(db.services.values()).sort((a, b) =>
                a.name.localeCompare(b.name)
              );
              if (filters.name !== undefined) {
                rows = rows.filter((s) => s.name === filters.name);
              }
              if (filters.required_role !== undefined) {
                rows = rows.filter((s) => s.required_role === filters.required_role);
              }
              if (selectOptions.head && selectOptions.count === 'exact') {
                return { data: null, count: rows.length, error: null };
              }
              return { data: rows, count: rows.length, error: null };
            }
            if (operation === 'insert') {
              if (db.services.has(payload.name)) {
                return { data: null, error: { code: '23505', message: 'duplicate key' } };
              }
              db.services.set(payload.name, { ...payload });
              return { data: { ...payload }, error: null };
            }
            if (operation === 'update') {
              const updated = [];
              for (const [svcName, svc] of Array.from(db.services.entries())) {
                const matchName = filters.name === undefined || svcName === filters.name;
                const matchRole =
                  filters.required_role === undefined ||
                  svc.required_role === filters.required_role;
                if (matchName && matchRole) {
                  const next = { ...svc, ...payload };
                  if (payload.name && payload.name !== svcName) {
                    db.services.delete(svcName);
                  }
                  db.services.set(next.name, next);
                  updated.push(next);
                }
              }
              return { data: updated, error: null };
            }
            if (operation === 'delete') {
              db.services.delete(filters.name);
              return { data: [], error: null };
            }
          }

          // STOCK
          if (table === 'stock') {
            if (operation === 'select') {
              let rows = db.stock;
              if (filters.service_name !== undefined) {
                rows = rows.filter((s) => s.service_name === filters.service_name);
              }
              if (selectOptions.head && selectOptions.count === 'exact') {
                return { data: null, count: rows.length, error: null };
              }
              return { data: rows, count: rows.length, error: null };
            }
            if (operation === 'insert') {
              const list = Array.isArray(payload) ? payload : [payload];
              const created = [];
              for (const item of list) {
                if (!db.services.has(item.service_name)) {
                  return {
                    data: null,
                    error: { code: '23503', message: 'foreign key violation' },
                  };
                }
                const record = {
                  id:
                    item.id ||
                    `00000000-0000-0000-0000-${String(nextUuidCounter++).padStart(12, '0')}`,
                  service_name: item.service_name,
                  email: item.email,
                  password: item.password,
                };
                db.stock.push(record);
                created.push(record);
              }
              return { data: Array.isArray(payload) ? created : created[0], error: null };
            }
            if (operation === 'update') {
              for (const item of db.stock) {
                if (
                  filters.service_name === undefined ||
                  item.service_name === filters.service_name
                ) {
                  Object.assign(item, payload);
                }
              }
              return { data: [], error: null };
            }
            if (operation === 'delete') {
              db.stock = db.stock.filter((s) => s.service_name !== filters.service_name);
              return { data: [], error: null };
            }
          }

          // LICENSE KEYS
          if (table === 'license_keys') {
            if (operation === 'insert') {
              const rows = Array.isArray(payload) ? payload : [payload];
              for (const r of rows) {
                db.license_keys.set(r.key, { ...r });
              }
              return { data: rows, error: null };
            }
            if (operation === 'select') {
              let rows = Array.from(db.license_keys.values());
              if (filters.key !== undefined) {
                rows = rows.filter((k) => k.key === filters.key);
              }
              return { data: rows, error: null };
            }
            if (operation === 'update') {
              const existing = db.license_keys.get(filters.key);
              if (existing) Object.assign(existing, payload);
              return { data: existing ? [existing] : [], error: null };
            }
          }

          // BLACKLIST
          if (table === 'blacklist') {
            if (operation === 'select') {
              let rows = Array.from(db.blacklist.values());
              if (filters.discord_id !== undefined) {
                rows = rows.filter((b) => b.discord_id === filters.discord_id);
              }
              return { data: rows, error: null };
            }
            if (operation === 'upsert') {
              db.blacklist.set(payload.discord_id, {
                ...payload,
                created_at: new Date().toISOString(),
              });
              return { data: db.blacklist.get(payload.discord_id), error: null };
            }
            if (operation === 'delete') {
              db.blacklist.delete(filters.discord_id);
              return { data: [], error: null };
            }
          }

          // BOT SETTINGS
          if (table === 'bot_settings') {
            if (operation === 'select') {
              return { data: [{ ...db.bot_settings }], error: null };
            }
            if (operation === 'upsert') {
              db.bot_settings = { ...db.bot_settings, ...payload };
              return { data: { ...db.bot_settings }, error: null };
            }
          }

          return { data: null, error: null };
        },
      };

      return builder;
    },
  };
}

function extractFirstEmbed(payload) {
  assert.ok(payload && typeof payload === 'object', 'Expected reply payload object');
  assert.ok(
    Array.isArray(payload.embeds) && payload.embeds.length === 1,
    'Expected reply payload to contain an embed'
  );
  const raw = payload.embeds[0];
  return typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
}

function createMockInteraction({
  userId = '111111111111111111',
  userCreatedTimestamp = Date.now() - 30 * 86_400_000, // 30 days old by default
  memberRoleIds = [],
  channelId = '999999999999999999',
  inGuild = true,
  options = {},
  subcommand = null,
  dmShouldFail = false,
  customId = '',
  componentType = 'chat', // 'chat' | 'button' | 'string_select' | 'channel_select' | 'role_select' | 'modal'
  values = [],
  modalFields = {},
  clientChannels = {},
} = {}) {
  const state = {
    deferred: false,
    deferOptions: undefined,
    replyPayload: null,
    dmsSent: [],
    shownModal: null,
    channelMessages: {},
  };

  return {
    state,
    customId,
    values,
    channelId,
    inGuild: () => inGuild,
    isButton: () => componentType === 'button',
    isStringSelectMenu: () => componentType === 'string_select',
    isChannelSelectMenu: () => componentType === 'channel_select',
    isRoleSelectMenu: () => componentType === 'role_select',
    isModalSubmit: () => componentType === 'modal',
    isFromMessage: () => componentType === 'modal',
    member: {
      roles: memberRoleIds,
    },
    client: {
      channels: {
        async fetch(cid) {
          if (!clientChannels[cid]) return null;
          return {
            async send(msg) {
              if (!state.channelMessages[cid]) state.channelMessages[cid] = [];
              state.channelMessages[cid].push(msg);
              return msg;
            },
          };
        },
      },
    },
    user: {
      id: userId,
      createdTimestamp: userCreatedTimestamp,
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
      getSubcommand() {
        return subcommand;
      },
      getString(key) {
        return options[key] ?? null;
      },
      getInteger(key) {
        return options[key] ?? null;
      },
      getBoolean(key) {
        return options[key] ?? null;
      },
      getChannel(key) {
        return options[key] ?? null;
      },
      getRole(key) {
        return options[key] ?? null;
      },
      getUser(key) {
        return options[key] ?? null;
      },
      getAttachment(key) {
        return options[key] ?? null;
      },
    },
    fields: {
      getTextInputValue(key) {
        return modalFields[key] ?? '';
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
    async reply(payload) {
      state.replyPayload = payload;
      return payload;
    },
    async update(payload) {
      state.replyPayload = payload;
      return payload;
    },
    async showModal(modal) {
      state.shownModal = modal.toJSON();
      return state.shownModal;
    },
  };
}

test('Command Loader loads all 18 modular slash commands with valid Discord.js v14 schemas', () => {
  const commands = loadCommands();
  assert.equal(commands.size, 18);

  const expectedNames = [
    'help',
    'redeem',
    'gen',
    'stock',
    'stocks',
    'services',
    'createservice',
    'editservice',
    'deleteservice',
    'addstock',
    'restock',
    'createrole',
    'editrole',
    'deleterole',
    'setrole',
    'createkey',
    'blacklist',
    'settings',
  ];

  for (const name of expectedNames) {
    assert.ok(commands.has(name), `Expected command /${name} to be loaded`);
    assert.equal(commands.get(name).data.toJSON().name, name);
  }
});

test('#1 Per-Role Cooldown: blocks repeated /gen during cooldown, ignores failed DMs, and edits via /editrole', async () => {
  const mockDb = createMockSupabase({
    roles: {
      Free: {
        name: 'Free',
        priority: 1,
        channel_id: null,
        cooldown_seconds: 600, // 10m cooldown
        discord_role_id: null,
        is_system: true,
      },
    },
    users: { free_member: 'Free', admin_1: 'Admin' },
    services: {
      mcfa: { name: 'mcfa', required_role: 'Free', channel_id: 'chan_mcfa' },
    },
    stock: [
      { id: '1', service_name: 'mcfa', email: 'a@b.com', password: '111' },
      { id: '2', service_name: 'mcfa', email: 'c@d.com', password: '222' },
    ],
  });
  supabase.setSupabaseClient(mockDb);

  // Failed DM should NOT put user on cooldown
  const failedDmGen = createMockInteraction({
    userId: 'free_member',
    channelId: 'chan_mcfa',
    options: { service: 'mcfa' },
    dmShouldFail: true,
  });
  await genCommand.execute(failedDmGen);
  assert.equal(mockDb.db.users.get('free_member').last_gen_at, null);

  // Successful 1st /gen sets last_gen_at
  const firstGen = createMockInteraction({
    userId: 'free_member',
    channelId: 'chan_mcfa',
    options: { service: 'mcfa' },
  });
  await genCommand.execute(firstGen);
  assert.equal(
    extractFirstEmbed(firstGen.state.replyPayload).description,
    'Check your DMs! I have sent you the account.'
  );
  assert.ok(mockDb.db.users.get('free_member').last_gen_at);

  // Immediate 2nd /gen hits Cooldown Active embed
  const secondGen = createMockInteraction({
    userId: 'free_member',
    channelId: 'chan_mcfa',
    options: { service: 'mcfa' },
  });
  await genCommand.execute(secondGen);
  assert.equal(
    extractFirstEmbed(secondGen.state.replyPayload).title,
    'Cooldown Active'
  );

  // Admin lowers Free cooldown to 0 via /editrole modal -> user can /gen immediately!
  await editRoleCommand.handleComponent(
    createMockInteraction({
      userId: 'admin_1',
      componentType: 'modal',
      customId: 'editrole:modal_cooldown:Free',
      modalFields: { new_cooldown: '0' },
    })
  );
  assert.equal(mockDb.db.roles.get('Free').cooldown_seconds, 0);

  const thirdGen = createMockInteraction({
    userId: 'free_member',
    channelId: 'chan_mcfa',
    options: { service: 'mcfa' },
  });
  await genCommand.execute(thirdGen);
  assert.equal(
    extractFirstEmbed(thirdGen.state.replyPayload).description,
    'Check your DMs! I have sent you the account.'
  );
});

test('#2 Restocking System (/restock + /settings): parses .txt, deduplicates, inserts stock, and posts Restock Alert embed', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin' },
    services: {
      netflix: { name: 'netflix', required_role: 'Premium', channel_id: 'chan_nf' },
    },
    stock: [
      { id: 'existing-1', service_name: 'netflix', email: 'already@nf.com', password: 'old' },
    ],
  });
  supabase.setSupabaseClient(mockDb);

  // Configure restock channel & ping role via /settings interactive selectors
  await settingsCommand.handleComponent(
    createMockInteraction({
      userId: 'admin_1',
      componentType: 'channel_select',
      customId: 'settings:select_channel',
      values: ['chan_restocks'],
    })
  );
  await settingsCommand.handleComponent(
    createMockInteraction({
      userId: 'admin_1',
      componentType: 'role_select',
      customId: 'settings:select_pingrole',
      values: ['role_restock_ping'],
    })
  );

  // Mock .txt file download
  restockCommand.setAttachmentDownloader(async () =>
    [
      '# Restock batch',
      'already@nf.com:old', // Duplicate of existing DB stock
      'fresh1@nf.com:passA',
      'fresh1@nf.com:passA', // Duplicate inside file
      'invalid_line_without_colon',
      'fresh2@nf.com:passB',
    ].join('\n')
  );

  const restockInt = createMockInteraction({
    userId: 'admin_1',
    clientChannels: { chan_restocks: true },
    options: {
      service: 'netflix',
      file: {
        name: 'netflix_batch.txt',
        url: 'https://cdn.discordapp.com/attachments/1/2/netflix_batch.txt',
        size: 256,
        contentType: 'text/plain',
      },
    },
  });

  await restockCommand.execute(restockInt);
  const summaryEmbed = extractFirstEmbed(restockInt.state.replyPayload);
  assert.equal(summaryEmbed.title, 'Restock Complete — netflix');
  assert.equal(mockDb.db.stock.length, 3); // 1 existing + 2 fresh

  // Verify Restock Alert embed + ping role was posted to #chan_restocks
  const postedAlerts = restockInt.state.channelMessages.chan_restocks;
  assert.equal(postedAlerts.length, 1);
  assert.equal(postedAlerts[0].content, '<@&role_restock_ping>');
  assert.equal(extractFirstEmbed(postedAlerts[0]).title, 'Restock Alert — netflix');
});

test('#3 Discord Server Role Auto-Sync: automatically grants RBA role when member holds linked Discord role', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin', booster_user: 'Free' },
    services: {
      disney: { name: 'disney', required_role: 'BoosterVIP', channel_id: 'chan_disney' },
    },
    stock: [
      { id: 'd-1', service_name: 'disney', email: 'mickey@disney.com', password: 'ears' },
    ],
  });
  supabase.setSupabaseClient(mockDb);

  // Admin creates custom role BoosterVIP linked to Discord server role 'discord_role_777'
  await createRoleCommand.execute(
    createMockInteraction({
      userId: 'admin_1',
      options: {
        name: 'BoosterVIP',
        cooldown: 0,
        discord_role: { id: 'discord_role_777' },
      },
    })
  );

  // Without Discord role -> rejected
  const withoutRoleGen = createMockInteraction({
    userId: 'booster_user',
    memberRoleIds: [],
    channelId: 'chan_disney',
    options: { service: 'disney' },
  });
  await genCommand.execute(withoutRoleGen);
  assert.equal(
    extractFirstEmbed(withoutRoleGen.state.replyPayload).description,
    'Currently not available for you.'
  );

  // With Discord server role 'discord_role_777' -> auto-synced to BoosterVIP and succeeds!
  const withRoleGen = createMockInteraction({
    userId: 'booster_user',
    memberRoleIds: ['discord_role_777'],
    channelId: 'chan_disney',
    options: { service: 'disney' },
  });
  await genCommand.execute(withRoleGen);
  assert.equal(
    extractFirstEmbed(withRoleGen.state.replyPayload).description,
    'Check your DMs! I have sent you the account.'
  );
});

test('#4 License Key & Timed Subscription System (/createkey, /redeem, time stacking, & auto-expiration)', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin', buyer_1: 'Free' },
  });
  supabase.setSupabaseClient(mockDb);

  // Admin creates 2 keys for Premium (7d)
  const createKeysInt = createMockInteraction({
    userId: 'admin_1',
    options: { role: 'Premium', duration: '7d', amount: 2 },
  });
  await createKeyCommand.execute(createKeysInt);
  assert.equal(
    extractFirstEmbed(createKeysInt.state.replyPayload).title,
    'License Key(s) Generated'
  );

  const generatedKeyCodes = Array.from(mockDb.db.license_keys.keys());
  assert.equal(generatedKeyCodes.length, 2);

  // Buyer redeems key 1 -> upgraded to Premium
  const redeem1 = createMockInteraction({
    userId: 'buyer_1',
    options: { key: generatedKeyCodes[0] },
  });
  await redeemCommand.execute(redeem1);
  assert.equal(extractFirstEmbed(redeem1.state.replyPayload).title, 'License Key Redeemed!');
  assert.equal(mockDb.db.users.get('buyer_1').rba_role, 'Premium');
  const firstExpiryMs = new Date(mockDb.db.users.get('buyer_1').role_expires_at).getTime();

  // Re-using already-redeemed key 1 fails
  const reuseAttempt = createMockInteraction({
    userId: 'buyer_1',
    options: { key: generatedKeyCodes[0] },
  });
  await redeemCommand.execute(reuseAttempt);
  assert.equal(
    extractFirstEmbed(reuseAttempt.state.replyPayload).title,
    'Invalid or Already Redeemed Key'
  );

  // Buyer redeems key 2 -> stacks +7 days onto existing expiry!
  const redeem2 = createMockInteraction({
    userId: 'buyer_1',
    options: { key: generatedKeyCodes[1] },
  });
  await redeemCommand.execute(redeem2);
  const stackedExpiryMs = new Date(mockDb.db.users.get('buyer_1').role_expires_at).getTime();
  assert.ok(stackedExpiryMs >= firstExpiryMs + 6.9 * 86_400_000);

  // Simulate subscription expiration in the past -> auto-reverts to 'Free'
  mockDb.db.users.get('buyer_1').role_expires_at = new Date(Date.now() - 5000).toISOString();
  const roleAfterExpiry = await getOrCreateUserRole(mockDb, 'buyer_1');
  assert.equal(roleAfterExpiry, 'Free');
  assert.equal(mockDb.db.users.get('buyer_1').role_expires_at, null);
});

test('#8 Blacklist & Alt-Account Age Protection (/blacklist & /settings min_account_age_days)', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin', bad_actor: 'Premium', brand_new_alt: 'Free' },
    services: {
      mcfa: { name: 'mcfa', required_role: 'Free', channel_id: 'chan_mcfa' },
    },
    stock: [
      { id: 's-1', service_name: 'mcfa', email: 'acc@mc.com', password: '123' },
    ],
  });
  supabase.setSupabaseClient(mockDb);

  // 1. Admin blacklists bad_actor
  const blAdd = createMockInteraction({
    userId: 'admin_1',
    subcommand: 'add',
    options: {
      user: { id: 'bad_actor' },
      reason: 'Abusing accounts',
    },
  });
  await blacklistCommand.execute(blAdd);
  assert.equal(extractFirstEmbed(blAdd.state.replyPayload).title, 'User Blacklisted');

  // Blacklisted user blocked from /gen
  const blockedGen = createMockInteraction({
    userId: 'bad_actor',
    channelId: 'chan_mcfa',
    options: { service: 'mcfa' },
  });
  await genCommand.execute(blockedGen);
  assert.equal(extractFirstEmbed(blockedGen.state.replyPayload).title, 'Access Restricted');

  // List blacklist & unblacklist
  const blList = createMockInteraction({ userId: 'admin_1', subcommand: 'list' });
  await blacklistCommand.execute(blList);
  assert.match(extractFirstEmbed(blList.state.replyPayload).description, /bad_actor/);

  const blRemove = createMockInteraction({
    userId: 'admin_1',
    subcommand: 'remove',
    options: { user: { id: 'bad_actor' } },
  });
  await blacklistCommand.execute(blRemove);
  assert.equal(extractFirstEmbed(blRemove.state.replyPayload).title, 'User Unblacklisted');

  // 2. Admin enables 7-day minimum Discord account age via /settings modal
  await settingsCommand.handleComponent(
    createMockInteraction({
      userId: 'admin_1',
      componentType: 'modal',
      customId: 'settings:modal_minage',
      modalFields: { min_age_days: '7' },
    })
  );
  assert.equal(mockDb.db.bot_settings.min_account_age_days, 7);

  // 1-day-old Free alt account is blocked
  const youngAltGen = createMockInteraction({
    userId: 'brand_new_alt',
    userCreatedTimestamp: Date.now() - 1 * 86_400_000, // Only 1 day old
    channelId: 'chan_mcfa',
    options: { service: 'mcfa' },
  });
  await genCommand.execute(youngAltGen);
  assert.equal(extractFirstEmbed(youngAltGen.state.replyPayload).title, 'Account Too New');

  // Existing commands (/stocks, /services, /stock, /editservice, /deleterole, /deleteservice, /setrole, /help) still work cleanly
  await stocksCommand.execute(createMockInteraction({ userId: 'admin_1' }));
  await servicesCommand.execute(createMockInteraction({ userId: 'admin_1' }));
  await stockCommand.execute(
    createMockInteraction({ userId: 'admin_1', options: { service: 'mcfa' } })
  );
  await helpCommand.execute(createMockInteraction({ userId: 'admin_1' }));
  await editServiceCommand.execute(
    createMockInteraction({ userId: 'admin_1', options: { name: 'mcfa' } })
  );
  await addStockCommand.execute(
    createMockInteraction({
      userId: 'admin_1',
      options: { service: 'mcfa', email: 'two@mc.com', password: '456' },
    })
  );
  await createServiceCommand.execute(
    createMockInteraction({
      userId: 'admin_1',
      options: { name: 'temp', role: 'Free', channel: { id: 'chan_mcfa' } },
    })
  );
  await deleteServiceCommand.execute(
    createMockInteraction({ userId: 'admin_1', options: { name: 'temp' } })
  );
  await deleteRoleCommand.execute(
    createMockInteraction({ userId: 'admin_1', options: { name: 'Premium' } })
  );
  await setRoleCommand.execute(
    createMockInteraction({
      userId: 'admin_1',
      options: { user: { id: 'brand_new_alt', bot: false }, role: 'Admin' },
    })
  );

  assert.equal(normalizeRole('free'), 'Free');
  assert.equal(hasRequiredRole('Admin', 'Free'), true);
});
