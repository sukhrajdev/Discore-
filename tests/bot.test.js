const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');

const supabase = require('../config/supabase');
const { loadCommands } = require('../handlers/commandHandler');
const { hasRequiredRole, normalizeRole, getOrCreateUserRole } = require('../utils/rba');

const helpCommand = require('../commands/general/help');
const genCommand = require('../commands/generator/gen');
const stockCommand = require('../commands/generator/stock');
const stocksCommand = require('../commands/generator/stocks');
const servicesCommand = require('../commands/generator/services');
const createServiceCommand = require('../commands/admin/createservice');
const editServiceCommand = require('../commands/admin/editservice');
const deleteServiceCommand = require('../commands/admin/deleteservice');
const addStockCommand = require('../commands/admin/addstock');
const createRoleCommand = require('../commands/admin/createrole');
const editRoleCommand = require('../commands/admin/editrole');
const deleteRoleCommand = require('../commands/admin/deleterole');
const setRoleCommand = require('../commands/admin/setrole');

/**
 * Full-featured in-memory mock of Supabase (PostgREST + RPCs) supporting
 * `roles`, `users`, `services`, and `stock`.
 */
function createMockSupabase(initialState = {}) {
  const defaultRoles = {
    Free: { name: 'Free', priority: 1, channel_id: null, is_system: true },
    Premium: { name: 'Premium', priority: 50, channel_id: null, is_system: false },
    Admin: { name: 'Admin', priority: 100, channel_id: null, is_system: true },
  };

  const db = {
    roles: new Map(
      Object.entries({ ...defaultRoles, ...(initialState.roles || {}) })
    ),
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
          // ROLES TABLE
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
              const record = { ...payload };
              db.roles.set(record.name, record);
              return { data: record, error: null };
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

          // USERS TABLE
          if (table === 'users') {
            if (operation === 'select') {
              let entries = Array.from(db.users.entries()).map(([discord_id, rba_role]) => ({
                discord_id,
                rba_role,
              }));
              if (filters.discord_id !== undefined) {
                entries = entries.filter((u) => u.discord_id === filters.discord_id);
              }
              if (filters.rba_role !== undefined) {
                entries = entries.filter((u) => u.rba_role === filters.rba_role);
              }
              if (selectOptions.head && selectOptions.count === 'exact') {
                return { data: null, count: entries.length, error: null };
              }
              return { data: entries, count: entries.length, error: null };
            }

            if (operation === 'upsert') {
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

            if (operation === 'update') {
              const updated = [];
              for (const [uid, role] of db.users.entries()) {
                if (filters.rba_role === undefined || role === filters.rba_role) {
                  db.users.set(uid, payload.rba_role);
                  updated.push({ discord_id: uid, rba_role: payload.rba_role });
                }
              }
              return { data: updated, error: null };
            }
          }

          // SERVICES TABLE
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
              const record = { ...payload };
              db.services.set(record.name, record);
              return { data: record, error: null };
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

          // STOCK TABLE
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
  channelId = '999999999999999999',
  inGuild = true,
  options = {},
  dmShouldFail = false,
  customId = '',
  componentType = 'chat', // 'chat' | 'button' | 'string_select' | 'channel_select' | 'modal'
  values = [],
  modalFields = {},
} = {}) {
  const state = {
    deferred: false,
    deferOptions: undefined,
    replyPayload: null,
    dmsSent: [],
    shownModal: null,
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
    isModalSubmit: () => componentType === 'modal',
    isFromMessage: () => componentType === 'modal',
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
      getInteger(key) {
        return options[key] ?? null;
      },
      getChannel(key) {
        return options[key] ?? null;
      },
      getUser(key) {
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

test('Command Loader loads all 13 modular slash commands with valid JSON schemas', () => {
  const commands = loadCommands();
  assert.equal(commands.size, 13);

  const expectedNames = [
    'help',
    'gen',
    'stock',
    'stocks',
    'services',
    'createservice',
    'editservice',
    'deleteservice',
    'addstock',
    'createrole',
    'editrole',
    'deleterole',
    'setrole',
  ];

  for (const name of expectedNames) {
    assert.ok(commands.has(name), `Expected command /${name} to be loaded`);
    const json = commands.get(name).data.toJSON();
    assert.equal(json.name, name);
  }
});

test('/help, /stocks, and /services return rich embed overviews', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin' },
    services: {
      mcfa: { name: 'mcfa', required_role: 'Free', channel_id: 'chan_1' },
      netflix: { name: 'netflix', required_role: 'Premium', channel_id: 'chan_2' },
    },
    stock: [
      { id: '1', service_name: 'mcfa', email: 'a@b.com', password: '123' },
      { id: '2', service_name: 'mcfa', email: 'c@d.com', password: '456' },
    ],
  });
  supabase.setSupabaseClient(mockDb);

  // /help
  const helpInt = createMockInteraction({ userId: 'admin_1' });
  await helpCommand.execute(helpInt);
  const helpEmbed = extractFirstEmbed(helpInt.state.replyPayload);
  assert.equal(helpEmbed.title, 'Account Generator Bot — Help Menu');
  assert.match(helpEmbed.description, /Admin/);

  // /stocks
  const stocksInt = createMockInteraction({ userId: 'admin_1' });
  await stocksCommand.execute(stocksInt);
  const stocksEmbed = extractFirstEmbed(stocksInt.state.replyPayload);
  assert.equal(stocksEmbed.title, 'All Service Stocks');
  assert.match(stocksEmbed.description, /\*\*mcfa\*\*: `2` remaining/);
  assert.match(stocksEmbed.description, /\*\*netflix\*\*: `0` remaining/);

  // /services
  const servicesInt = createMockInteraction({ userId: 'admin_1' });
  await servicesCommand.execute(servicesInt);
  const servicesEmbed = extractFirstEmbed(servicesInt.state.replyPayload);
  assert.equal(servicesEmbed.title, 'Available Generator Services');
  assert.match(servicesEmbed.description, /\*\*mcfa\*\*/);
  assert.match(servicesEmbed.description, /\*\*netflix\*\*/);
});

test('Custom roles (/createrole, /setrole, /gen, /deleterole) support role channels, peer isolation, and safe deletion', async () => {
  const mockDb = createMockSupabase({
    users: {
      admin_1: 'Admin',
      vip_user: 'Free',
      booster_user: 'Free',
    },
  });
  supabase.setSupabaseClient(mockDb);

  // 1. Create custom role 'VIP' with dedicated channel #vip_chan
  const createVip = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'VIP', channel: { id: 'vip_chan' } },
  });
  await createRoleCommand.execute(createVip);
  assert.equal(extractFirstEmbed(createVip.state.replyPayload).title, 'Custom Role Created');

  // 2. Create peer custom role 'Booster' (also default priority 25, no channel)
  const createBooster = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'Booster' },
  });
  await createRoleCommand.execute(createBooster);

  // 3. Assign VIP to vip_user and Booster to booster_user
  await setRoleCommand.execute(
    createMockInteraction({
      userId: 'admin_1',
      options: { user: { id: 'vip_user', bot: false }, role: 'VIP' },
    })
  );
  await setRoleCommand.execute(
    createMockInteraction({
      userId: 'admin_1',
      options: { user: { id: 'booster_user', bot: false }, role: 'Booster' },
    })
  );

  // 4. Create service 'spotify' for VIP (omitting channel -> inherits VIP's vip_chan!)
  const createSpotify = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'spotify', role: 'VIP' },
  });
  await createServiceCommand.execute(createSpotify);
  assert.equal(mockDb.db.services.get('spotify').channel_id, 'vip_chan');

  await addStockCommand.execute(
    createMockInteraction({
      userId: 'admin_1',
      options: { service: 'spotify', email: 'vip@music.com', password: 'secret' },
    })
  );

  // 5. Booster user (same priority 25, different custom role) CANNOT /gen VIP's spotify
  const boosterGen = createMockInteraction({
    userId: 'booster_user',
    channelId: 'vip_chan',
    options: { service: 'spotify' },
  });
  await genCommand.execute(boosterGen);
  assert.equal(
    extractFirstEmbed(boosterGen.state.replyPayload).description,
    'Currently not available for you.'
  );

  // 6. VIP user CAN /gen spotify in vip_chan
  const vipGen = createMockInteraction({
    userId: 'vip_user',
    channelId: 'vip_chan',
    options: { service: 'spotify' },
  });
  await genCommand.execute(vipGen);
  assert.equal(
    extractFirstEmbed(vipGen.state.replyPayload).description,
    'Check your DMs! I have sent you the account.'
  );

  // 7. System role 'Admin' cannot be deleted
  const deleteAdminAttempt = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'Admin' },
  });
  await deleteRoleCommand.execute(deleteAdminAttempt);
  assert.equal(
    extractFirstEmbed(deleteAdminAttempt.state.replyPayload).title,
    'System Role Protected'
  );

  // 8. Deleting custom role 'VIP' resets vip_user to 'Free' and locks 'spotify' to 'Admin'
  const deleteVip = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'VIP' },
  });
  await deleteRoleCommand.execute(deleteVip);
  assert.equal(extractFirstEmbed(deleteVip.state.replyPayload).title, 'Role Deleted');
  assert.equal(mockDb.db.users.get('vip_user'), 'Free');
  assert.equal(mockDb.db.services.get('spotify').required_role, 'Admin');
});

test('/editrole interactive buttons, channel picker, priority modal, rename modal, and delete flow work end-to-end', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin', member_1: 'Gold' },
    roles: {
      Gold: { name: 'Gold', priority: 30, channel_id: null, is_system: false },
    },
    services: {
      crunchyroll: { name: 'crunchyroll', required_role: 'Gold', channel_id: 'chan_cr' },
    },
  });
  supabase.setSupabaseClient(mockDb);

  // Open /editrole panel
  const openPanel = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'Gold' },
  });
  await editRoleCommand.execute(openPanel);
  const initialEmbed = extractFirstEmbed(openPanel.state.replyPayload);
  assert.equal(initialEmbed.title, 'Role Control Panel — Gold');
  assert.equal(openPanel.state.replyPayload.components.length, 2);

  // Click "Set Channel" button -> reveals ChannelSelectMenu row
  const clickSetChannel = createMockInteraction({
    userId: 'admin_1',
    componentType: 'button',
    customId: 'editrole:btn_channel:Gold',
  });
  await editRoleCommand.handleComponent(clickSetChannel);
  assert.equal(clickSetChannel.state.replyPayload.components.length, 3);

  // Select channel via ChannelSelectMenu
  const pickChannel = createMockInteraction({
    userId: 'admin_1',
    componentType: 'channel_select',
    customId: 'editrole:select_channel:Gold',
    values: ['chan_gold_vip'],
  });
  await editRoleCommand.handleComponent(pickChannel);
  assert.equal(mockDb.db.roles.get('Gold').channel_id, 'chan_gold_vip');

  // Click "Edit Priority" -> opens modal, then submit priority 65
  const clickPriority = createMockInteraction({
    userId: 'admin_1',
    componentType: 'button',
    customId: 'editrole:btn_priority:Gold',
  });
  await editRoleCommand.handleComponent(clickPriority);
  assert.ok(clickPriority.state.shownModal);

  const submitPriority = createMockInteraction({
    userId: 'admin_1',
    componentType: 'modal',
    customId: 'editrole:modal_priority:Gold',
    modalFields: { new_priority: '65' },
  });
  await editRoleCommand.handleComponent(submitPriority);
  assert.equal(mockDb.db.roles.get('Gold').priority, 65);

  // Submit Rename Modal: Gold -> Platinum (cascades to users & services!)
  const submitRename = createMockInteraction({
    userId: 'admin_1',
    componentType: 'modal',
    customId: 'editrole:modal_rename:Gold',
    modalFields: { new_role_name: 'Platinum' },
  });
  await editRoleCommand.handleComponent(submitRename);
  assert.ok(mockDb.db.roles.has('Platinum'));
  assert.equal(mockDb.db.users.get('member_1'), 'Platinum');
  assert.equal(mockDb.db.services.get('crunchyroll').required_role, 'Platinum');
});

test('/editservice interactive buttons, role & channel pickers, bulk stock modal, rename, and /deleteservice work end-to-end', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin' },
    roles: {
      VIP: { name: 'VIP', priority: 40, channel_id: null, is_system: false },
    },
    services: {
      mcfa: { name: 'mcfa', required_role: 'Free', channel_id: 'chan_old' },
      temp_svc: { name: 'temp_svc', required_role: 'Free', channel_id: 'chan_old' },
    },
    stock: [],
  });
  supabase.setSupabaseClient(mockDb);

  // Open /editservice panel
  const openSvc = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'mcfa' },
  });
  await editServiceCommand.execute(openSvc);
  assert.equal(
    extractFirstEmbed(openSvc.state.replyPayload).title,
    'Service Control Panel — mcfa'
  );
  assert.equal(openSvc.state.replyPayload.components.length, 2);

  // Change Required Role via StringSelectMenu to custom role 'VIP'
  const selectRole = createMockInteraction({
    userId: 'admin_1',
    componentType: 'string_select',
    customId: 'editservice:select_role:mcfa',
    values: ['VIP'],
  });
  await editServiceCommand.handleComponent(selectRole);
  assert.equal(mockDb.db.services.get('mcfa').required_role, 'VIP');

  // Change Channel via ChannelSelectMenu
  const selectChan = createMockInteraction({
    userId: 'admin_1',
    componentType: 'channel_select',
    customId: 'editservice:select_channel:mcfa',
    values: ['chan_new_mcfa'],
  });
  await editServiceCommand.handleComponent(selectChan);
  assert.equal(mockDb.db.services.get('mcfa').channel_id, 'chan_new_mcfa');

  // Bulk Add Stock via Modal (3 accounts in email:password lines)
  const submitBulkStock = createMockInteraction({
    userId: 'admin_1',
    componentType: 'modal',
    customId: 'editservice:modal_addstock:mcfa',
    modalFields: {
      accounts_input: 'a@test.com:pass1\nb@test.com:pass2\nc@test.com:pass3',
      single_password: '',
    },
  });
  await editServiceCommand.handleComponent(submitBulkStock);
  assert.equal(mockDb.db.stock.length, 3);

  // Rename Service via Modal: mcfa -> minecraft (keeps stock synced!)
  const submitSvcRename = createMockInteraction({
    userId: 'admin_1',
    componentType: 'modal',
    customId: 'editservice:modal_rename:mcfa',
    modalFields: { new_service_name: 'minecraft' },
  });
  await editServiceCommand.handleComponent(submitSvcRename);
  assert.ok(mockDb.db.services.has('minecraft'));
  assert.equal(
    mockDb.db.stock.filter((s) => s.service_name === 'minecraft').length,
    3
  );

  // Check /stock on renamed service
  const checkStock = createMockInteraction({
    userId: 'admin_1',
    options: { service: 'minecraft' },
  });
  await stockCommand.execute(checkStock);
  assert.equal(
    extractFirstEmbed(checkStock.state.replyPayload).description,
    'There are currently 3 accounts in stock for minecraft.'
  );

  // /deleteservice deletes temp_svc cleanly
  const delSvc = createMockInteraction({
    userId: 'admin_1',
    options: { name: 'temp_svc' },
  });
  await deleteServiceCommand.execute(delSvc);
  assert.equal(extractFirstEmbed(delSvc.state.replyPayload).title, 'Service Deleted');
  assert.equal(mockDb.db.services.has('temp_svc'), false);
});

test('Existing Admin can grant another user Admin via /setrole and self-demotion is blocked', async () => {
  const mockDb = createMockSupabase({
    users: { admin_1: 'Admin', member_1: 'Free' },
  });
  supabase.setSupabaseClient(mockDb);

  // Self-demotion blocked
  const selfDemote = createMockInteraction({
    userId: 'admin_1',
    options: { user: { id: 'admin_1', bot: false }, role: 'Free' },
  });
  await setRoleCommand.execute(selfDemote);
  assert.equal(
    extractFirstEmbed(selfDemote.state.replyPayload).title,
    'Self-Demotion Blocked'
  );

  // Admin promotes member_1 to Admin
  const promote = createMockInteraction({
    userId: 'admin_1',
    options: { user: { id: 'member_1', bot: false }, role: 'Admin' },
  });
  await setRoleCommand.execute(promote);
  assert.equal(extractFirstEmbed(promote.state.replyPayload).title, 'Admin Role Granted');
  assert.equal(mockDb.db.users.get('member_1'), 'Admin');

  // RBA helper sanity checks
  assert.equal(normalizeRole('admin'), 'Admin');
  assert.equal(hasRequiredRole('Admin', 'Premium'), true);
  assert.equal(await getOrCreateUserRole(mockDb, 'new_person'), 'Free');
});
