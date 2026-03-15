# Canceled Loot Tracker — Claude Code Context

## What this project is
A loot council system for the **Canceled** WoW guild.
- Discord bot (discord.js v14) manages persistent button panels and notifications
- Web app handles all complex UI — loot council, BIS submission, roster, history
- Google Sheets is the database (source of truth); bot and web app both read/write it
- Discord OAuth is how users authenticate on the web app
- Supports multiple raid teams from a single bot + web app instance

## Architecture

### Discord bot — notification and quick-action layer
The bot maintains persistent embed panels in a `#raid-console` officer channel.
These panels are auto-posted on bot startup if not already present (message IDs
stored in the Config tab). Officers interact entirely by clicking buttons on these panels.
No slash commands. The one exception is a single `/setup` command used once per team
to post the initial panels and record their message IDs.

**The four persistent panels:**
| Panel | Buttons |
|-------|---------|
| Raid | Start Raid · End Raid · Import Loot (file upload modal) |
| Roster | Open Roster → (link to web app `/roster`) |
| BIS | Pending Submissions → (link to web app `/bis/review`) · Run Brief |
| Links | Open Console → · Officer Guide → |

**Simple actions** (Start Raid, End Raid, Run Brief) happen entirely inside Discord
via ephemeral confirmation messages. **Complex actions** (loot council, BIS review,
roster management) open the web app in the browser via link buttons.

**RCLC loot import flow:** Import Loot button → Discord file upload modal →
officer attaches CSV → bot parses, deduplicates, and writes to Loot Log sheet.

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

**Hosting:** TBD — Railway (bot + web app as two services) or Railway + Vercel.
Decide before Phase 2 build starts.

## Stack
- **Runtime:** Node.js 20+, ESM modules (`"type": "module"` in package.json)
- **Discord bot:** discord.js v14 — button interactions and modals only, no slash commands
- **Web app:** TBD at Phase 2 (likely Express + React, or Next.js)
- **Auth:** Discord OAuth2 for web app login
- **Data:** Google Sheets API v4 via `googleapis` — Sheets is the database
- **Service auth:** Google service account (JSON key file locally, env var on Railway)
- **Config:** dotenv — all secrets and team config in `.env`

## Project structure
```
src/
  index.js                 — bot entry point; registers button/modal handlers
  lib/
    sheets.js              — ALL Sheets reads/writes live here
    teams.js               — resolves team from channel ID via TEAM_* env vars
    permissions.js         — isOfficer() role check helper
    panels.js              — posts and refreshes persistent Discord panels
  handlers/
    buttons/               — one file per button ID
    modals/                — one file per modal ID (e.g. loot-import)
  web/                     — web app (added Phase 2)
config/
  service-account.json     — gitignored Google service account key
```

## Multi-team model
- Each team has its own Google Sheet (same schema)
- Adding a new team = one env var + populate that team's Config sheet. No code changes:
  ```
  TEAM_MYTHIC_SHEET_ID=...   <- the only env var needed per team
  ```
- All other team config lives in the Config sheet tab (channel IDs, role IDs, guild ID).
  `initTeams()` reads this at startup and populates the in-memory team objects.
- `getTeamByChannel(channelId)` in `teams.js` resolves which team an interaction belongs to
- All sheet helpers take `sheetId` as first argument so the same function serves all teams

## Access control model
| Level | Who | Can do |
|-------|-----|--------|
| Anyone | — | View public pages on web app (none currently) |
| Raider | Team Discord role | Web app: view own dashboard, submit/edit BIS |
| Officer | Officer Discord role | Web app: all officer pages; Discord: all panel buttons |

Discord panel buttons check the officer role before acting. The web app checks
the role resolved from the Roster sheet after OAuth login.

## Google Sheets schema
Each team has one Sheet with these tabs. Column order is the source of truth.

### Roster (A=CharName B=Class C=Spec D=Role E=Status F=OwnerId G=OwnerNick)
- Realm column removed — not needed
- Class and Spec are dropdown-validated in the sheet
- Role is auto-filled by onEdit trigger when Spec is selected — do not write to it directly
- Status values: Active | Bench | Inactive
- OwnerId = Discord user ID (snowflake string)
- OwnerNick = stable player nickname (editable by player on web app or officer in console)

### Loot Log (A=Id B=RaidId C=Date D=Boss E=ItemName F=Difficulty G=RecipientId H=RecipientChar I=UpgradeType J=Notes)
- UpgradeType values: BIS | Non-BIS | Tertiary
- BIS and Non-BIS count toward loot totals (shown by difficulty N/H/M)
- Tertiary is recorded but excluded from totals, shown separately
- Primary loot entry path: RCLC CSV import via Discord modal
- Fallback: manual entry form on web app `/loot`

### BIS Submissions (A=Id B=CharName C=Spec D=Slot E=TrueBIS F=RaidBIS G=Rationale H=Status I=SubmittedAt J=ReviewedBy K=OfficerNote)
- Status values: Pending | Approved | Rejected
- TrueBIS = Overall BIS (best item from any source). Display label: "Overall BIS"
- RaidBIS = Raid BIS (best item from current raid tier only). Display label: "Raid BIS"
- TrueBIS can be an item name/ID or a sentinel value
- RaidBIS is optional per slot — empty means player has no Raid BIS preference for this slot
- Effective BIS per slot: approved personal submission > spec default fallback

### Default BIS (A=Spec B=Slot C=TrueBIS D=TrueBISItemId E=RaidBIS F=RaidBISItemId G=Source)
- Source = where the default came from: Icy Veins | Wowhead | Maxroll | Class Discord | Manual
- Seeded via web app `/admin`

### Item DB (A=ItemId B=Name C=Slot D=SourceType E=SourceName F=Instance G=Difficulty H=ArmorType I=IsTierToken)
- SourceType: Raid | Mythic+
- ArmorType: Cloth | Leather | Mail | Plate | Accessory | Tier Token
  (Accessory = armor-type-agnostic slots like neck/ring/trinket/back/weapon — matches any armor type)
  (Tier Token = NON_EQUIP tier tokens like Conqueror/Protector/Vanquisher — matched via IsTierToken logic, not armor type)
- IsTierToken: TRUE | FALSE
- Seeded via web app `/admin` -> Sync Loot Tables (calls Blizzard Game Data API)
- Crafted items are NOT in the Item DB

### Raids (A=RaidId B=TeamId C=Date D=Instance E=Difficulty F=AttendeeIds)
- AttendeeIds = comma-separated Discord user IDs
- Populated via Warcraft Logs API (Phase 10); direct Sheet edit as interim

### Config (A=Key B=Value)
Key settings:
- `console_message_ids`       — JSON map of panel name -> Discord message ID (written by bot on setup)
- `guild_id`                  — Discord guild (server) ID; required for officer role checks on web login
- `officer_role_id`           — Discord role ID for officers
- `team_role_id`              — Discord role ID for team members
- `console_channel_id`        — #raid-console channel ID
- `brief_channel_id`          — pre-raid brief channel ID
- `raid_days`                 — e.g. "Tue,Thu"
- `raid_time`                 — e.g. "20:00"
- `raid_instance`             — e.g. "Amirdrassil"
- `current_difficulty`        — default difficulty shown in council view: Mythic
- `raid_session_window_hours` — default 6
- `brief_lead_time_minutes`   — default 60
- `brief_auto_enabled`        — default true
- `bis_default_sources`       — default "Icy Veins,Wowhead,Maxroll,Class Discord,Manual"
- `web_app_url`               — base URL of the web app (for link buttons in panels)

### RCLC Response Map (A=RCLCButton B=InternalType C=CountedInTotals)
Maps RCLootCouncil button labels to internal upgrade types:
- "BIS" -> BIS (counted)
- "Item Upgrade" -> Non-BIS (counted)
- "Tertiary" -> Tertiary (not counted)
Unmapped responses default to Non-BIS with a bot warning.

### Transfers (A=Id B=CharName C=FromTeam D=ToTeam E=Date F=Reason)
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
Display labels in all UI (web app, Discord embeds) are:
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

## Pre-raid brief contents
Auto-posted to brief channel at `brief_lead_time_minutes` before raid (default 60 min).
Also triggered manually via the BIS panel "Run Brief" button.
1. Pending BIS submissions with Approve / Reject buttons
2. Raiders with zero approved personal BIS submissions
3. Roster changes since last raid

## Discord channel structure (per team)
| Channel              | Purpose                                    | Access         |
|----------------------|--------------------------------------------|----------------|
| #[team]-raid-console | Persistent bot panels — all officer actions| Officers only  |
| #[team]-brief        | Pre-raid brief auto-posts                  | Officers (read)|

No public loot channel — raiders use the web app for history and BIS status.

## Key design decisions (don't re-litigate these)
**No slash commands.** Bot uses persistent button panels only. One `/setup` command
exists solely to post the initial panels on first run.

**No priority score.** The bot shows raw data only. Council makes the call.

**Loot history stays with the team.** On transfer, player starts fresh. History on
old team is untouched.

**Crafted items not tracked.** `<Crafted>` is a sentinel in BIS lists only.
No crafted items in Item DB or Loot Log.

**RCLC is the primary import path.** Discord modal file upload -> CSV parse ->
dedup -> write to Loot Log. Manual entry on web app `/loot` is the fallback.

**Attendance via Warcraft Logs (Phase 10).** Direct Sheet edit is the interim fallback.

**Roster Role column is always computed.** Never write to Role (column D) directly.
The onEdit Apps Script trigger handles it. Bot reads Role but never writes it.

**Realm not tracked.** Removed from Roster — character name alone is the identifier
within a team.

**Sentinel availability is enforced in the UI.** `<Tier>` is only offered for tier
slots. `<Catalyst>` is only offered for non-tier armor slots. Neither is offered for
accessory slots. This is a UI constraint only — validate it on form submit too.

## Build phases (current status)
- ✅ **Phase 1** — Bot scaffold, Sheets auth, panel posting, basic button handlers
- ⬜ **Phase 2** — Web app skeleton + Discord OAuth login + raider dashboard
- ⬜ **Phase 3** — BIS submission form (web app `/bis`)
- ⬜ **Phase 4** — Loot council view (web app `/council`)
- ⬜ **Phase 5** — RCLC CSV import via Discord modal
- ⬜ **Phase 6** — Officer web pages: roster mgmt, BIS review, loot log, admin
- ⬜ **Phase 7** — Multi-team support, transfers
- ⬜ **Phase 8** — Pre-raid brief auto-scheduler
- ⬜ **Phase 9** — Blizzard API sync (Item DB seeding)
- ⬜ **Phase 10** — Warcraft Logs attendance integration

## Code style conventions
- ESM throughout (`import`/`export`, no `require`)
- Async/await, no raw Promise chains
- All Sheets access goes through `src/lib/sheets.js` — never import googleapis elsewhere
- Button handlers live in `src/handlers/buttons/` — one file per customId
- Modal handlers live in `src/handlers/modals/` — one file per customId
- Always check officer role before acting on any button in the console channel
- Error format: `❌ Reason for failure.` (red X emoji, ephemeral)
- Success embeds: color `0xCC1010` (Canceled crimson) for positive, `0x1A1A1A` for neutral

## Guild branding
- Name: **Canceled**
- Primary colour: `#CC1010` (crimson red)
- Secondary: `#1A1A1A` (near-black card surface)
- Background: `#0D0D0D` (near-black)
- Server icon: ❌ emoji motif
- Vibe: dark, direct, no fluff
