# Discore — Modular Account Generator Bot (Discord.js v14 + Supabase)

A production-ready, modular **Account Generator Discord Bot** built with **Node.js**, **Discord.js v14** (Slash Commands, Rich Embeds, & Autocomplete), and **Supabase (PostgreSQL)** featuring Role-Based Access Control (RBA) and **race-condition-free atomic account claiming**.

---

## Project Structure

```text
Discore-/
├── commands/
│   ├── admin/
│   │   ├── addstock.js         # /addstock [service] [email] [password]
│   │   ├── createservice.js    # /createservice [name] [role] [channel]
│   │   └── setrole.js          # /setrole [user] [role] (supports promoting users to Admin)
│   ├── general/
│   │   └── help.js             # /help [command] (interactive embed help menu)
│   └── generator/
│       ├── gen.js              # /gen [service] (atomic RPC claim + DM embed + rollback)
│       └── stock.js            # /stock [service] (HEAD exact count embed)
├── config/
│   └── supabase.js             # Singleton Supabase service-role client
├── handlers/
│   └── commandHandler.js       # Recursive command loader & InteractionCreate router
├── scripts/
│   └── seed-admin.js           # CLI helper to bootstrap the first Admin user
├── sql/
│   └── schema.sql              # Full PostgreSQL DDL, RLS policies, & atomic RPC
├── tests/
│   └── bot.test.js             # Automated test suite (Node built-in test runner)
├── utils/
│   ├── autocomplete.js         # Live service name autocomplete helper
│   ├── embeds.js               # Centralized Discord EmbedBuilder factory
│   └── rba.js                  # RBA role hierarchy (Free < Premium < Admin)
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

### 2. Provision the Supabase Database Schema

1. Create a project in [Supabase](https://supabase.com/).
2. Open the **SQL Editor** in your Supabase Dashboard.
3. Paste and run the full contents of [`sql/schema.sql`](./sql/schema.sql).
   - Creates `users`, `services`, and `stock` tables.
   - Enables **Row Level Security (RLS)** on all tables so public `anon` keys cannot read credentials, while your backend `service_role` key has full access.
   - Creates the `claim_stock_account(p_service_name)` PostgreSQL RPC using `SELECT ... FOR UPDATE SKIP LOCKED` + `DELETE ... RETURNING` to eliminate race conditions.

### 3. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_application_client_id_here
DISCORD_GUILD_ID=optional_dev_server_id_for_instant_command_sync
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_role_key_here
```

> **Discord Developer Portal Tip:** Invite the bot to your server using OAuth2 scopes `bot` and `applications.commands` (`Send Messages`, `Embed Links`, `View Channels`).

### 4. Bootstrap Your First Admin User

Bootstrap your initial `Admin` Discord User ID once:

```bash
npm run seed-admin -- YOUR_DISCORD_USER_ID
```

Once the first `Admin` exists, they can promote additional users to `Admin` directly inside Discord via `/setrole user:@Member role:Admin`.

### 5. Deploy Slash Commands & Start the Bot

```bash
# Register slash commands with Discord (re-run whenever new commands like /help are added)
npm run deploy

# Start the bot
npm start
```

---

## Slash Commands Reference (100% Embed Responses)

All bot channel responses, ephemeral responses, error messages, and Direct Messages are formatted as rich Discord **Embeds** (`EmbedBuilder`):

| Command | Access | Visibility | Description |
| :--- | :--- | :--- | :--- |
| `/help [command]` | Everyone | Public Embed | Displays all available commands, your current RBA role, or detailed usage for a specific command. |
| `/gen [service]` | RBA Role >= `required_role` | Public Embed + DM Embed | Atomically claims & deletes 1 account from `stock` and delivers credentials via a DM Embed. |
| `/stock [service]` | Everyone | Public Embed | Counts remaining accounts for a service (`"There are currently 15 accounts in stock for mcfa."`). |
| `/createservice [name] [role] [channel]` | `Admin` | Ephemeral Embed | Registers a new generator service restricted to a minimum RBA role and channel. |
| `/addstock [service] [email] [password]` | `Admin` | Ephemeral Embed | Inserts an account into `stock` without exposing credentials in public chat. |
| `/setrole [user] [role]` | `Admin` | Ephemeral Embed | Assigns `Free`, `Premium`, or `Admin` to any user (existing Admins can grant other users `Admin`, with self-demotion protection). |

---

## Concurrency & Reliability Design

- **Zero Race Conditions (`FOR UPDATE SKIP LOCKED`)**: `/gen` calls `supabase.rpc('claim_stock_account', ...)` which locks one unlocked stock row and deletes it in a single atomic PostgreSQL statement. Even if 100 users run `/gen` in the exact same millisecond, two users can never receive the same account and queries never block each other.
- **Closed-DM Compensating Rollback**: If a user disables server DMs (`DiscordAPIError[50007]`), the bot catches the failure and immediately re-inserts the claimed account back into `stock` so zero accounts are lost.
- **Zero-Payload Stock Counts**: `/stock` uses `{ count: 'exact', head: true }` so PostgREST returns the exact PostgreSQL `COUNT(*)` without transferring credential rows or hitting the 1,000-row pagination cap.

---

## Running Tests

```bash
npm test
```
