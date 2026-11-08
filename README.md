# Discore — Modular Account Generator Bot (Discord.js v14 + Supabase)

A production-ready, modular **Account Generator Discord Bot** built with **Node.js**, **Discord.js v14** (Slash Commands, Rich Embeds, Interactive Buttons/Modals/Select Menus, & Autocomplete), and **Supabase (PostgreSQL)** featuring **Custom Role-Based Access Control (RBA)** and **race-condition-free atomic account claiming**.

---

## Project Structure

```text
Discore-/
├── commands/
│   ├── admin/
│   │   ├── addstock.js         # /addstock [service] [email] [password]
│   │   ├── createrole.js       # /createrole [name] [channel(optional)] [priority(optional)]
│   │   ├── createservice.js    # /createservice [name] [role] [channel(optional)]
│   │   ├── deleterole.js       # /deleterole [name]
│   │   ├── deleteservice.js    # /deleteservice [name]
│   │   ├── editrole.js         # /editrole [name] (interactive embed + buttons/modals/channel picker)
│   │   ├── editservice.js      # /editservice [name] (interactive embed + buttons/modals/role & channel pickers)
│   │   └── setrole.js          # /setrole [user] [role] (custom roles & Admin promotion)
│   ├── general/
│   │   └── help.js             # /help [command]
│   └── generator/
│       ├── gen.js              # /gen [service] (atomic RPC claim + DM embed + rollback)
│       ├── services.js         # /services (all services overview embed)
│       ├── stock.js            # /stock [service] (single service count embed)
│       └── stocks.js           # /stocks (all services remaining stock embed)
├── config/
│   └── supabase.js             # Singleton Supabase service-role client
├── handlers/
│   └── commandHandler.js       # Recursive command loader & Slash/Button/Select/Modal router
├── scripts/
│   └── seed-admin.js           # CLI helper to bootstrap the first Admin user
├── sql/
│   └── schema.sql              # Full PostgreSQL DDL (roles, users, services, stock), RLS, & RPCs
├── tests/
│   └── bot.test.js             # Automated test suite (Node built-in test runner)
├── utils/
│   ├── autocomplete.js         # Live service & custom role autocomplete helpers
│   ├── embeds.js               # Centralized Discord EmbedBuilder factory
│   └── rba.js                  # Dynamic RBA role hierarchy & safe role lifecycle helpers
├── .env.example                # Environment variable template
├── deploy-commands.js          # Discord REST slash-command registration script
├── index.js                    # Bot initialization & lifecycle entry point
└── package.json
```

---

## Setup Instructions

### 1. Install Dependencies

Ensure **Node.js v18+** is installed, then run:

```bash
npm install
```

### 2. Provision / Update the Supabase Database Schema

1. Open the **SQL Editor** in your [Supabase Dashboard](https://supabase.com/).
2. Paste and run the full contents of [`sql/schema.sql`](./sql/schema.sql) *(safe to run on both brand-new and existing projects)*.
   - Creates `roles`, `users`, `services`, and `stock` tables (seeding `Free`, `Premium`, and `Admin`).
   - Enables **Row Level Security (RLS)** on all tables.
   - Creates `claim_stock_account` (atomic `FOR UPDATE SKIP LOCKED` + `DELETE ... RETURNING`) and `get_all_service_stocks` RPCs.

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `SUPABASE_URL`, and `SUPABASE_SERVICE_KEY` (plus optional `DISCORD_GUILD_ID` for instant guild command sync).

### 4. Bootstrap Your First Admin User

```bash
npm run seed-admin -- YOUR_DISCORD_USER_ID
```

### 5. Deploy Slash Commands & Start the Bot

```bash
npm run deploy
npm start
```

---

## Slash Commands Reference (100% Embeds & Interactive Panels)

| Command | Access | Visibility | Description |
| :--- | :--- | :--- | :--- |
| `/help [command]` | Everyone | Public Embed | Displays all commands, active RBA roles, or detailed usage for a specific command. |
| `/gen [service]` | RBA Role >= `required_role` | Public Embed + DM Embed | Atomically claims & deletes 1 account from `stock` and sends credentials via DM Embed. |
| `/stock [service]` | Everyone | Public Embed | Shows remaining stock count for one service. |
| `/stocks` | Everyone | Public Embed | Shows remaining stock across **all** services (`service: X remaining`). |
| `/services` | Everyone | Public Embed | Lists all generator services with their required roles and channels. |
| `/createrole [name] [channel] [priority]` | `Admin` | Ephemeral Embed | Creates a custom RBA role with an optional dedicated channel and priority tier. |
| `/editrole [name]` | `Admin` | Interactive Ephemeral Panel | Interactive embed with buttons, modals, and channel selector to rename, re-tier, link/clear channel, or delete a role. |
| `/deleterole [name]` | `Admin` | Ephemeral Embed | Safely deletes a custom role (resets assigned users to `Free` and locks dependent services to `Admin`). |
| `/createservice [name] [role] [channel]` | `Admin` | Ephemeral Embed | Creates a new generator service (supports custom roles and inherits role channel if omitted). |
| `/editservice [name]` | `Admin` | Interactive Ephemeral Panel | Interactive embed with buttons, modals, and dropdowns to rename, change role/channel, bulk-add/clear stock, or delete a service. |
| `/deleteservice [name]` | `Admin` | Ephemeral Embed | Permanently deletes a generator service and its remaining stock. |
| `/addstock [service] [email] [password]` | `Admin` | Ephemeral Embed | Adds a single account to `stock`. |
| `/setrole [user] [role]` | `Admin` | Ephemeral Embed | Assigns any built-in role, custom role, or `Admin` to a user. |

---

## Running Tests

```bash
npm test
```
