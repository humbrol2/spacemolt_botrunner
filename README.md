# SpaceMolt Bot Runner

A web-based bot fleet manager for [SpaceMolt](https://www.spacemolt.com) — run multiple bots with automated routines, monitor everything from a live dashboard.

![Dashboard](https://img.shields.io/badge/interface-web_dashboard-blue) ![Runtime](https://img.shields.io/badge/runtime-bun-black) ![No Dependencies](https://img.shields.io/badge/deps-zero_runtime-green)

## What It Does

Bot Runner manages a fleet of SpaceMolt bots from a single web dashboard. Each bot runs an automated routine (mining, exploring, crafting, rescue) while you monitor from your browser.

- **Web Dashboard** — real-time status, logs, and controls at `http://localhost:3000`
- **4 Routines** — Miner, Explorer, Crafter, Fuel Rescue
- **Faction Management** — members, storage, facilities, diplomacy, intel
- **Galaxy Map** — auto-built from explorer data
- **Manual Control** — execute any game command from the bot profile page
- **Multi-bot** — run as many bots as you want, each with its own routine
- **Zero runtime deps** — just Bun

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- A SpaceMolt account — register at [spacemolt.com/dashboard](https://spacemolt.com/dashboard) to get a registration code

### Install

```bash
git clone https://github.com/humbrol2/spacemolt_botrunner.git
cd spacemolt_botrunner
bun install
```

### Run

```bash
bun start
```

Open `http://localhost:3000` in your browser. Use `PORT=8080 bun start` for a different port.

## Dashboard

### Bot Table
All bots at a glance — name, ship, state, credits, fuel, hull/shield, cargo, location. Click a bot name to open its profile.

### Bot Profile
Full manual control panel for any bot:
- Travel, jump, dock/undock
- Mine, scan, refuel, repair
- Buy/sell with live market prices
- Craft with recipe browser
- Deposit/withdraw station storage
- Send gifts/credits between bots
- Custom command input for any API call

### Routines

| Routine | Description |
|---------|-------------|
| **Miner** | Mines ore at asteroid belts, returns to station to sell/deposit. Configurable target ore, cargo threshold, sell vs deposit. |
| **Explorer** | Jumps system to system, visits every POI, surveys resources. Builds the galaxy map. |
| **Crafter** | Crafts items up to configured stock limits. Add/remove recipes with category picker. |
| **Fuel Rescue** | Monitors fleet for stranded bots (low fuel), delivers fuel cells or credits. |

All routines include:
- Auto-refuel and repair at configurable thresholds
- Wreck scavenging (loot fuel cells and cargo from debris)
- Emergency fuel recovery (sell cargo, wait for rescue)
- Auto-collect credits from station storage on dock

### Faction Tab
Full faction management from the browser:
- **Overview** — leader, members, treasury, allies/enemies/wars, deposit/withdraw credits
- **Members** — role management (recruit/member/officer/leader), kick, invite players, quick-invite your other bots with auto-accept
- **Storage** — view/deposit/withdraw faction items. Detects missing lockbox and offers to build one
- **Facilities** — list faction facilities at current station, toggle on/off, check upgrades, build new facilities (lockbox, etc.)
- **Diplomacy** — set ally/enemy, declare war, propose/accept peace
- **Intel** — query intel by system/player, view intel status, trade intel

### Settings
Per-routine configuration saved to `data/settings.json`:
- **Miner** — target ore, mining system, deposit bot, sell ore, cargo/refuel/repair thresholds
- **Crafter** — recipe list with add/remove + category picker, stock limits, thresholds
- **Explorer** — max jumps, survey mode, scan POIs, avoid low security, thresholds
- **Fuel Rescue** — scan interval, fuel trigger %, cells to deliver, credits to send

### Other Tabs
- **Map** — galaxy map built from explorer data, filterable by security level and resources
- **Missions** — browse available missions per system, view/claim/complete active missions per bot

## Adding Bots

From the dashboard:

1. **Register New** — enter a registration code from [spacemolt.com/dashboard](https://spacemolt.com/dashboard), pick a username and empire
2. **Add Existing** — enter username and password for an existing account

Credentials are saved to `sessions/<username>/credentials.json`. Bots auto-discover on restart.

## Project Structure

```
src/
  botmanager.ts      Entry point — discovers bots, starts web server, handles actions
  bot.ts             Bot class — login, exec, status caching, routine runner
  api.ts             SpaceMolt REST client with session management
  session.ts         Credential persistence
  ui.ts              Log routing (bot → web server → browser)
  debug.ts           Debug logging to data/debug.log
  mapstore.ts        Galaxy map persistence
  routines/
    common.ts        Shared utilities (dock, refuel, travel, scavenge, emergency recovery)
    miner.ts         Mining routine
    explorer.ts      Exploration routine
    crafter.ts       Crafting routine
    rescue.ts        Fuel rescue routine
  web/
    server.ts        Bun.serve HTTP + WebSocket server
    index.html       Dashboard SPA (vanilla JS, no build step)
data/
  settings.json      Persisted routine settings
  map.json           Galaxy map data
sessions/
  <username>/
    credentials.json
```

## About SpaceMolt

[SpaceMolt](https://www.spacemolt.com) is a massively multiplayer online game designed for AI agents. Thousands of LLMs play simultaneously in a vast galaxy — mining, trading, exploring, and fighting.

## License

MIT
