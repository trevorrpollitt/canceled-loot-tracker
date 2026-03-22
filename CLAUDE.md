# Canceled Loot Tracker — Web App

## What this project is
The web app component of the Canceled guild loot tracker.
- Handles all complex UI — loot council, BIS submission, roster, history
- Google Sheets is the database (source of truth); reads/writes via `src/lib/sheets.js`
- Discord OAuth is how users authenticate
- Supports multiple raid teams from a single instance

The Discord bot (panel posting, RCLC import, brief notifications) lives in a
separate repo: `loot-tracker-bot`.

## Architecture

### Web app — the real UI
Both officers and raiders log in with Discord OAuth. The app resolves their team
and role from the Roster sheet after login.

**Pages:**
| Route | Who | What |
|-------|-----|------|
| `/` | Everyone | Dashboard — own loot history + BIS status |
| `/bis` | Raiders | Submit / edit BIS list (slot-by-slot form) |
| `/council` | Officers | Loot council — pick boss, pick item, see candidates |
| `/roster` | Officers | Add/edit characters, manage bench/active |
| `/bis/review` | Officers | Approve or reject pending BIS submissions |
| `/loot` | Officers | Full loot log, fix entries |
| `/admin` | Officers | Config, RCLC map, sync loot tables |

**Hosting:** Railway (web app as a service). Bot is deployed separately.

## Stack
- **Runtime:** Node.js 20+, ESM modules (`"type": "module"` in package.json)
- **Server:** Express + express-session
- **Client:** React 18 + Vite (dev proxy to Express on port 3001)
- **Auth:** Discord OAuth2
- **Data:** Google Sheets API v4 via `googleapis` — Sheets is the database
- **Service auth:** Google service account (JSON key file locally, env var on Railway)
- **Config:** dotenv — all secrets and sheet IDs in `.env`

## Project structure
```
src/
  lib/
    sheets.js              — ALL Sheets reads/writes live here (master + per-team)
    teams.js               — loads team registry from master sheet; resolves team by name
    specs.js               — spec/class constants
    rclc.js                — RCLC response map helpers
  web/
    server/
      index.js             — Express entry point
      routes/              — one file per route group (auth, me, dashboard, bis, etc.)
      middleware/          — session auth guard
    client/
      src/
        App.jsx            — React app root
        pages/             — one file per page
        components/        — shared components
        hooks/             — shared hooks
    vite.config.js         — Vite config (root: ./client, proxy /api → 3001)
    package.json           — web deps (express, react, vite, etc.)
scripts/
  seed-item-db.js          — seed Item DB from Blizzard API
  seed-default-bis.js      — seed Default BIS from guides
  backfill-weapon-types.js — maintenance backfill
  migrate-char-ids.js      — one-time migration: adds CharId to Roster (col H),
                             BIS Submissions (col N), and Loot Log (col K)
                             Usage: node --env-file=.env scripts/migrate-char-ids.js <teamSheetId>
  blizzard.js              — Blizzard API helpers
  wowhead.js               — Wowhead scraping helpers
config/
  service-account.json     — gitignored Google service account key
```

## Sheet architecture

### Master sheet (`MASTER_SHEET_ID` env var)
One guild-wide sheet that all teams share. Contains:

| Tab | Purpose |
|-----|---------|
| **Teams** (A=TeamName, B=SheetId) | Registry of all teams — the only place to add/remove a team |
| **Global Config** (A=Key, B=Value) | Guild-wide settings: `guild_id`, `web_app_url` |
| **Item DB** | Raid and M+ item database (seeded via web admin) |
| **Default BIS** | Spec BIS defaults (seeded via web admin) |
| **Spec BIS Config** | Per-spec preferred BIS source |
| **Transfers** | Cross-team transfer audit log |

### Per-team sheets
Each team has its own sheet with team-specific data:

| Tab | Purpose |
|-----|---------|
| Roster | Characters, owners, status |
| Loot Log | All loot awarded to this team |
| BIS Submissions | Player BIS submissions + review status |
| Config (A=Key, B=Value) | Team-specific: channel IDs, role IDs, raid settings |
| Raids | Raid sessions and attendance |
| RCLC Response Map | Team-specific RCLC button→type mapping |

## Multi-team model
- Adding a new team = add a row to the master sheet Teams tab + create a team sheet
- Zero env var changes, zero code changes, zero redeploy needed
- `initTeams()` in `teams.js` reads the Teams registry at startup, then loads each team's Config
- Master-sheet functions (`getItemDb`, `getDefaultBis`, `getEffectiveDefaultBis`, etc.) take no `sheetId`
- Team-sheet functions (`getRoster`, `getLootLog`, `getBisSubmissions`, etc.) take `sheetId`

## Access control model
| Level | Who | Can do |
|-------|-----|--------|
| Anyone | — | View public pages (none currently) |
| Raider | Team Discord role | View own dashboard, submit/edit BIS |
| Officer | Officer Discord role | All officer pages |

The web app checks the role resolved from the Roster sheet after OAuth login.
`guild_id` comes from the master sheet Global Config; `officer_role_id` comes from the team's Config tab.

## Google Sheets schema
Column order is the source of truth. Tabs marked **[master]** live in the master sheet; all others live in each team's sheet.

### Roster (A=CharName B=Class C=Spec D=Role E=Status F=OwnerId G=OwnerNick H=CharId I=Server)
- CharId (col H) = stable UUID generated when the character is added. Never changes on rename.
  Cols A–G are unchanged from the original schema; old code reading A:G is unaffected.
- Server (col I) = optional realm name (e.g. "Area 52"). Normally empty. Only populated when two
  characters on the roster share the same name (different real-world servers). The UI forces both
  entries to be given a server name when the conflict arises; RCLC imports use server+name to
  disambiguate when the roster entry has a server set, and name-only when it is empty.
- Realm column removed — not needed
- Class and Spec are dropdown-validated in the sheet
- Role is auto-filled by onEdit trigger when Spec is selected — do not write to it directly
- Status values: Active | Bench | Inactive
- OwnerId = Discord user ID (snowflake string)
- OwnerNick = stable player nickname (editable by player on web app or officer in console)
- To rename a character: `POST /api/roster/:charName/rename` — only writes col A; all linked data follows via CharId

### Loot Log (A=Id B=RaidId C=Date D=Boss E=ItemName F=Difficulty G=RecipientId H=RecipientChar I=UpgradeType J=Notes K=RecipientCharId)
- RecipientCharId (col K) = stable character UUID matching Roster!CharId.
  Empty for entries written before the migration ran — name-based join is used as fallback.
- UpgradeType values: BIS | Non-BIS | Tertiary
- BIS and Non-BIS count toward loot totals (shown by difficulty N/H/M)
- Tertiary is recorded but excluded from totals, shown separately
- Primary loot entry path: RCLC CSV import via Discord bot
- Fallback: manual entry form on web app `/loot`

### BIS Submissions (A=Id B=CharName C=Spec D=Slot E=TrueBIS F=RaidBIS G=Rationale H=Status I=SubmittedAt J=ReviewedBy K=OfficerNote L=TrueBISItemId M=RaidBISItemId N=CharId)
- CharId (col N) = stable character UUID matching Roster!CharId.
  Col B (CharName) is kept for readability and for backward compat with old prod code reading A:M.
  New code joins via CharId; CharName is the fallback for un-migrated rows.
- Status values: Pending | Approved | Rejected
- TrueBIS = Overall BIS (best item from any source). Display label: "Overall BIS"
- RaidBIS = Raid BIS (best item from current raid tier only). Display label: "Raid BIS"
- TrueBIS can be an item name/ID or a sentinel value
- RaidBIS is optional per slot — empty means player has no Raid BIS preference for this slot
- Effective BIS per slot: approved personal submission > spec default fallback

### Default BIS **[master]** (A=Spec B=Slot C=TrueBIS D=TrueBISItemId E=RaidBIS F=RaidBISItemId G=Source)
- Source = where the default came from: Icy Veins | Wowhead | Maxroll | Class Discord | Manual
- Seeded via web app `/admin`

### Item DB **[master]** (A=ItemId B=Name C=Slot D=SourceType E=SourceName F=Instance G=Difficulty H=ArmorType I=IsTierToken)
- SourceType: Raid | Mythic+
- ArmorType: Cloth | Leather | Mail | Plate | Accessory | Tier Token
  (Accessory = armor-type-agnostic slots like neck/ring/trinket/back/weapon — matches any armor type)
  (Tier Token = NON_EQUIP tier tokens like Conqueror/Protector/Vanquisher — matched via IsTierToken logic, not armor type)
- IsTierToken: TRUE | FALSE
- Seeded via web app `/admin` -> Sync Loot Tables (calls Blizzard Game Data API)
- Crafted items are NOT in the Item DB

### Raids (A=RaidId B=Date C=Instance D=Difficulty E=AttendeeIds)
- RaidId = WCL report code (e.g. "AbCdEf12") — stable dedup key
- AttendeeIds = pipe-separated Discord user IDs (e.g. "123|456|789")
- Populated automatically by WCL cron sync on report completion
- TeamId column removed — each team has its own sheet

### Raid Encounters (A=RaidId B=EncounterId C=BossName D=Pulls E=Killed F=BestPct)
- One row per boss per completed WCL report
- EncounterId = WCL/Blizzard encounter ID (stable numeric ID per boss)
- Killed = TRUE | FALSE
- BestPct = lowest boss % reached across all pulls (0.0 = dead, 15.3 = 15.3% wipe)
- Trash pulls (encounterID = 0) are excluded
- Written by WCL cron sync on report completion only

### Tier Snapshot (A=CharId B=CharName C=RaidId D=TierCount E=TierDetail F=UpdatedAt)
- One row per roster character — **upserted** on every sync run including live reports
- Represents current state, not history; RaidId = most recent report this was computed from
- TierDetail = pipe-separated slot:track pairs, e.g. "Head:Mythic|Chest:Hero|Hands:Champion"
- Track values: Veteran | Champion | Hero | Mythic
- Characters not on the roster (pugs) are skipped
- Used by council view to show tier piece status per candidate

### Worn BIS (A=CharId B=CharName C=Slot D=OverallBISTrack E=RaidBISTrack F=OtherTrack G=UpdatedAt H=Spec)
- One row per character × spec × slot (~16 slots × number of specs per character)
- Upsert key: CharId (col A) + Slot (col C) + Spec (col H) composite
- Spec column (H) added after initial rollout — rows written before multi-spec support have empty H and are effectively orphaned (never matched by spec-aware lookups)
- Spec is determined from WCL CombatantInfo `specID` (WoW spec ID → app spec name via `WOW_SPEC_ID_TO_NAME`); falls back to roster primary spec if specID is absent or unrecognised
- Records the **highest upgrade track** ever worn in each BIS category for that slot × spec
- OverallBISTrack: highest track worn for an item matching the character's approved Overall BIS for that spec
- RaidBISTrack: highest track worn for an item matching the character's approved Raid BIS for that spec
- OtherTrack: highest track worn for any item in this slot that isn't their Overall or Raid BIS (spec-agnostic)
- Track values: `Veteran | Champion | Hero | Mythic` or empty string (never worn at a known track)
- Tracks never decrease — values are merged with existing sheet data on each sync run (best-ever)
- Items with unrecognised bonus IDs (Unknown track) are skipped entirely
- Characters not on the roster (pugs) are skipped
- Reset manually per season via Admin page → "Reset Worn BIS Data"

### Tier Items **[master]** (A=Class B=Slot C=ItemId)
- Current season's tier piece item IDs, one row per class × slot (13 classes × 5 slots = 65 rows)
- Seeded via web app `/admin` → Sync Tier Items (Blizzard API)
- Updated once per tier when new content releases

### Global Config **[master]** (A=Key B=Value)
Guild-wide settings shared across all teams:
- `guild_id`               — Discord guild (server) ID; required for officer role checks on web login
- `web_app_url`            — base URL of the web app (for link buttons in bot panels)
- `season_start`           — ISO date of current season start (e.g. "2025-01-21"); used as a universal cutoff for all historical data queries and WCL report filtering
- `wcl_client_id`          — Warcraft Logs OAuth client ID (non-sensitive, fine in sheet)
- `wcl_zone_ids`           — pipe-separated WCL zone IDs for current tier (e.g. "38|41"); fights outside these zones are excluded from sync
- `wcl_veteran_bonus_id`   — start bonus ID of the Veteran upgrade track; each track uses 8 consecutive IDs, so Champion = veteran+8, Hero = veteran+16, Mythic = veteran+24; update each new season (Midnight S1: 12777)
- `wcl_crafted_bonus_ids`  — pipe-separated bonus IDs that identify crafted items in WCL gear data (e.g. "9481|9513"); items matching any of these IDs are recorded as track 'Crafted' instead of being skipped; update each new season
- `wcl_client_secret` is **not** stored here — env var `WCL_CLIENT_SECRET` only (Cloudflare Worker secret in prod, `.dev.vars` locally)

### Config (A=Key B=Value) — per team
Team-specific settings:
- `officer_role_id`           — Discord role ID for officers
- `team_role_id`              — Discord role ID for team members
- `console_channel_id`        — #raid-console channel ID (used by bot)
- `brief_channel_id`          — pre-raid brief channel ID (used by bot)
- `console_message_ids`       — JSON map of panel name -> Discord message ID (written by bot)
- `raid_days`                 — e.g. "Tue,Thu"
- `raid_time`                 — e.g. "20:00"
- `raid_instance`             — e.g. "Amirdrassil"
- `current_difficulty`        — default difficulty shown in council view: Mythic
- `raid_session_window_hours` — default 6
- `brief_lead_time_minutes`   — default 60
- `brief_auto_enabled`        — default true
- `bis_default_sources`       — default "Icy Veins,Wowhead,Maxroll,Class Discord,Manual"
- `wcl_guild_id`              — WCL guild/team ID for this team (e.g. "787359"); WCL treats each raid team as its own guild
- `wcl_last_check`            — Unix ms timestamp of last successful sync; written by cron, not manually edited
- `wcl_pending_reports`       — pipe-separated `code:startTime:endTime:zoneName` entries for reports < 24h old; re-checked each run and reprocessed if endTime has changed; written by cron, not manually edited

### RCLC Response Map (A=RCLCButton B=InternalType C=CountedInTotals)
Maps RCLootCouncil button labels to internal upgrade types:
- "BIS" -> BIS (counted)
- "Item Upgrade" -> Non-BIS (counted)
- "Tertiary" -> Tertiary (not counted)
Unmapped responses default to Non-BIS.

### Transfers **[master]** (A=Id B=CharName C=FromTeam D=ToTeam E=Date F=Reason)
- Lives in the master sheet — covers all teams
- Loot history does NOT follow a transfer — player starts fresh on new team
- This tab is audit log only

### Dashboard (computed by bot)
- Raids attended, BIS drops by difficulty (N/H/M), Non-BIS drops by difficulty,
  Tertiary drops (total), last loot date

## BIS sentinel values
Three special sentinel values are valid in TrueBIS and/or RaidBIS fields.
Never store these in the Item DB.

| Sentinel    | Valid in           | Meaning                              | Matches a loot drop when...                                      |
|-------------|--------------------|--------------------------------------|------------------------------------------------------------------|
| `<Crafted>` | TrueBIS only       | Best item is crafted, not droppable  | Never — informational only                                       |
| `<Tier>`    | TrueBIS + RaidBIS  | Tier set piece for this slot         | Dropped item IsTierToken = TRUE and slot matches                 |
| `<Catalyst>`| TrueBIS + RaidBIS  | Any catalyst-eligible drop           | Dropped item slot matches AND item ArmorType matches character   |

**Slot availability — sentinels are mutually exclusive by slot:**
- Tier slots (Head, Shoulders, Chest, Hands, Legs): `<Tier>` available, `<Catalyst>` NOT available
- Non-tier armor slots (Neck, Back, Wrists, Waist, Feet): `<Catalyst>` available, `<Tier>` NOT available
- Accessory slots (Ring 1, Ring 2, Trinket 1, Trinket 2, Weapon, Off-Hand): neither sentinel applies

**`<Catalyst>` matching logic:**
1. Dropped item slot == BIS slot, AND
2. Dropped item ArmorType == character's armor type (derived from class — no extra column needed)
Trinket / Accessory ArmorType items always match regardless of character armor type.

**Armor type by class:**
- Cloth: Mage, Priest, Warlock
- Leather: Druid, Demon Hunter, Monk, Rogue
- Mail: Evoker, Hunter, Shaman
- Plate: Death Knight, Paladin, Warrior

**The BIS form enforces sentinel availability** — only valid sentinels appear in the
dropdown for each slot. Invalid combinations are never presented to the user.

## BIS display labels
Column names in the sheet are `TrueBIS` and `RaidBIS` — do not rename them.
Display labels in all UI are:
- `TrueBIS` -> **"Overall BIS"**
- `RaidBIS` -> **"Raid BIS"**

## BIS submission form (web app `/bis`)
One form, slots listed down the page. Each slot row has:
- **Overall BIS** field (required) — item name/ID or valid sentinel for this slot
- **Raid BIS** field (optional) — item name/ID, valid sentinel, or blank
- "Same as Overall" shortcut button — copies Overall BIS value into Raid BIS
- **Rationale** field (shared, below both fields per slot)

Sentinel options in each dropdown are filtered by slot per the availability rules above.

## BIS review (web app `/bis/review`)
Each pending submission shows:
```
Slot: Head
Overall BIS:  [item name or sentinel]    [source badge]
Raid BIS:     [item name or sentinel]    [source badge]   (or "— not set")
Rationale:    "..."
[ Approve ]  [ Reject ]  [ Add Note ]
```

## Loot council view (web app `/council`)
Per-candidate data points:
- BIS drops received: N / H / M breakdown
- Non-BIS drops received: N / H / M breakdown
- Tertiary drops (total, no difficulty breakdown)
- Raids attended (raw count)
- **Overall BIS match** for this slot? (checkmark / `<Crafted>` badge / dash)
- **Raid BIS match** for this slot? (checkmark / dash)

Example row:
```
Morthrak   BIS 1/2/0  Non-BIS 3  Raids 14   Overall BIS [check]   Raid BIS [check]
Zephyrak   BIS 0/1/1  Non-BIS 2  Raids 12   Overall BIS [check]   Raid BIS  —
Veldris    BIS 2/0/0  Non-BIS 4  Raids 14   Overall BIS  —        Raid BIS  —
```

Default candidate filter: players with Raid BIS set for this slot.
"Show all eligible" toggle: all class/spec eligible characters regardless of BIS.

## Upgrade type taxonomy
| RCLC Button  | Internal | Counted in totals?                        |
|--------------|----------|-------------------------------------------|
| BIS          | BIS      | Yes — BIS drop count (by N/H/M difficulty)|
| Item Upgrade | Non-BIS  | Yes — Non-BIS drop count (by N/H/M)       |
| Tertiary     | Tertiary | No — shown separately, not in totals      |

## Key design decisions (don't re-litigate these)
**No priority score.** The app shows raw data only. Council makes the call.

**Loot history stays with the team.** On transfer, player starts fresh. History on
old team is untouched.

**Crafted items not tracked.** `<Crafted>` is a sentinel in BIS lists only.
No crafted items in Item DB or Loot Log.

**RCLC is the primary import path.** Handled by the bot. Manual entry on web app `/loot` is the fallback.

**Attendance via Warcraft Logs (Phase 10).** Direct Sheet edit is the interim fallback.

**Roster Role column is always computed.** Never write to Role (column D) directly.
The onEdit Apps Script trigger handles it.

**Realm not tracked.** Removed from Roster — character name alone is the identifier
within a team.

**Sentinel availability is enforced in the UI.** `<Tier>` is only offered for tier
slots. `<Catalyst>` is only offered for non-tier armor slots. Neither is offered for
accessory slots. This is a UI constraint only — validate it on form submit too.

## Build phases (current status)
- ✅ **Phase 2** — Web app skeleton + Discord OAuth login + raider dashboard
- ⬜ **Phase 3** — BIS submission form (web app `/bis`)
- ⬜ **Phase 4** — Loot council view (web app `/council`)
- ⬜ **Phase 6** — Officer web pages: roster mgmt, BIS review, loot log, admin
- ⬜ **Phase 7** — Multi-team support, transfers
- ⬜ **Phase 9** — Blizzard API sync (Item DB seeding via `/admin`)
- ⬜ **Phase 10** — Warcraft Logs attendance integration

## Code style conventions
- ESM throughout (`import`/`export`, no `require`)
- Async/await, no raw Promise chains
- All Sheets access goes through `src/lib/sheets.js` — never import googleapis elsewhere
- Route handlers live in `src/web/server/routes/` — one file per route group
- Error responses: `{ error: 'message' }` JSON with appropriate HTTP status

## Sheets read/write efficiency — always consider this when designing features
Google Sheets API has strict rate limits (60 req/min per user). Every design decision must account for this.

**Reading:**
- Use `primeTeamCache(sheetId, [...tabKeys])` at the top of route handlers to batch-load all needed team tabs in one API call, then call individual `get*` functions which hit cache
- Master sheet reads (`getItemDb`, `getEffectiveDefaultBis`, etc.) run in parallel with `primeTeamCache` via `Promise.all`
- New `get*` functions must use `cachedRead` — never call `readRange` directly from a route or exported function
- New tabs added to team sheets must be added to `TEAM_TAB_DEFS` in `sheets.js` with a range and pure parse function
- `cachedRead` has in-flight deduplication: concurrent requests for the same key share one promise automatically

**Writing:**
- Every write function (`upsert*`, `clear*`, etc.) must call `cacheInvalidate(sheetId, tabKey)` after writing so the next read reflects the change
- Batch multiple cell writes into `batchWriteRanges` — never loop individual `writeRange` calls
- Prefer upsert patterns (read once, compute updates/appends, write once) over read-modify-write per row

## Guild branding
- Name: **Canceled**
- Primary colour: `#CC1010` (crimson red)
- Secondary: `#1A1A1A` (near-black card surface)
- Background: `#0D0D0D` (near-black)
- Server icon: ❌ emoji motif
- Vibe: dark, direct, no fluff
