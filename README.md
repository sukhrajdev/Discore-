# Discore — Modular Account Generator Bot (Discord.js v14 + Supabase)

A commercial-grade, modular **Account Generator Discord Bot** built with **Node.js**, **Discord.js v14** (Slash Commands, Rich Embeds, Interactive Control Panels, & Autocomplete), and **Supabase (PostgreSQL)**.

<div align="center">

### 🎬 Official 30s Animated Launch Trailer

[![Discore 30s Animated Trailer Preview](./trailer/discore-trailer-preview.gif)](./trailer/discore-trailer.mp4)

**[▶️ Watch / Download Full 1080p HD Trailer with Audio (`discore-trailer.mp4`)](./trailer/discore-trailer.mp4)** · **[⬇️ Direct Raw MP4 Download](https://github.com/sukhrajdev/Discore-/raw/main/trailer/discore-trailer.mp4)**

| 💳 Paid Instant Unlock | 🎁 Free Community Unlock |
| :---: | :---: |
| **`4$ (Paid)`** — Full Bot + Complete Source Code | **`15 Invites (Non-Paid)`** — Full Bot + Complete Source Code |

</div>

---

## Core Capabilities

- **Atomic Race-Condition-Free Generation**: Uses PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` + `DELETE ... RETURNING` (`claim_stock_account` RPC) with automatic closed-DM stock rollback.
- **Custom RBA Roles & Per-Role Cooldowns**: Create custom roles (`/createrole`) with dedicated channels and per-role `/gen` cooldowns (`cooldown_seconds`), editable live via `/editrole`.
- **Discord Server Role Auto-Sync**: Link any Discord server role (e.g., `@Server Booster`, `@VIP`) to an RBA role so members automatically receive generator access without manual `/setrole`.
- **Bulk `.txt` Restocking & Auto Restock Alerts**: Upload `.txt` account files via `/restock` with automatic duplicate filtering and instant `#restocks` channel + `@Restock Ping` embed alerts.
- **License Keys & Timed Subscriptions**: Generate `DISC-XXXX-XXXX-XXXX` keys (`/createkey`) for `7d`, `30d`, or `lifetime` plans; users claim via `/redeem` with automatic duration stacking and expiration.
- **Blacklist & Alt-Account Age Protection**: Block abusive users via `/blacklist` and enforce a minimum Discord account age (in days) on `Free` tier users via `/settings`.

---

## Project Structure

```text
Discore-/
├── commands/
│   ├── admin/
│   │   ├── addstock.js         # /addstock [service] [email] [password]
│   │   ├── blacklist.js        # /blacklist add|remove|list
│   │   ├── createkey.js        # /createkey [role] [duration] [amount]
│   │   ├── createrole.js       # /createrole [name] [channel] [priority] [cooldown] [discord_role]
│   │   ├── createservice.js    # /createservice [name] [role] [channel]
│   │   ├── deleterole.js       # /deleterole [name]
│   │   ├── deleteservice.js    # /deleteservice [name]
│   │   ├── editrole.js         # /editrole [name] (interactive embed + buttons/modals/pickers)
│   │   ├── editservice.js      # /editservice [name] (interactive embed + buttons/modals/pickers)
│   │   ├── restock.js          # /restock [service] [file] (.txt bulk restocker + alert)
│   │   ├── setrole.js          # /setrole [user] [role]
│   │   └── settings.js         # /settings (interactive Restock Alert & alt-age panel)
│   ├── general/
│   │   ├── help.js             # /help [command]
│   │   └── redeem.js           # /redeem [key]
│   └── generator/
│       ├── gen.js              # /gen [service]
│       ├── services.js         # /services
│       ├── stock.js            # /stock [service]
│       └── stocks.js           # /stocks
├── config/
│   └── supabase.js             # Singleton Supabase service-role client
├── handlers/
│   └── commandHandler.js       # Recursive command loader & Slash/Button/Select/Modal router
├── scripts/
│   └── seed-admin.js           # CLI helper to bootstrap the first Admin user
├── sql/
│   └── schema.sql              # Full PostgreSQL DDL, RLS policies, & atomic RPCs
├── tests/
│   └── bot.test.js             # Automated end-to-end test suite
├── trailer/
│   ├── discore-trailer.mp4         # Full 30s 1080p 30fps animated trailer (with audio)
│   └── discore-trailer-preview.gif # Inline GitHub README animated preview
├── utils/
│   ├── autocomplete.js         # Live service & custom role autocomplete helpers
│   ├── duration.js             # Duration parser, key generator, & Snowflake age helper
│   ├── embeds.js               # Centralized Discord EmbedBuilder factory
│   ├── rba.js                  # Dynamic RBA roles, cooldowns, Discord role sync, & expiry
│   └── settings.js             # Bot settings, blacklist checks, & Restock Alert broadcaster
├── .env.example
├── deploy-commands.js
├── index.js
└── package.json
```

---

## Setup & Deployment

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Apply the Supabase SQL schema**:
   Run [`sql/schema.sql`](./sql/schema.sql) in the Supabase **SQL Editor** *(idempotent—safe for both new and existing databases)*.
3. **Configure `.env`**:
   ```bash
   cp .env.example .env
   ```
   Populate `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `SUPABASE_URL`, and `SUPABASE_SERVICE_KEY`.
4. **Bootstrap your first Admin**:
   ```bash
   npm run seed-admin -- YOUR_DISCORD_USER_ID
   ```
5. **Register slash commands & start**:
   ```bash
   npm run deploy
   npm start
   ```

---

## Running Tests

```bash
npm test
```
