# Canceled Loot Tracker — Bot

Discord bot for the Canceled guild loot council system.  
Stack: Node.js 20+ · discord.js v14 · Google Sheets API v4 · Railway

---

## First-time setup (do this once)

### 1. Node.js
Install Node.js 20 or later: https://nodejs.org

```bash
node --version   # should print v20.x.x or higher
npm install      # installs discord.js, googleapis, dotenv
```

### 2. Discord Application + Bot Token

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it "Canceled Loot Tracker"
3. Go to the **Bot** tab → click **Add Bot**
4. Under **Token** → click **Reset Token** → copy it (you'll need this for `.env`)
5. Under **Privileged Gateway Intents** — you don't need any for now
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Use Slash Commands`, `Embed Links`
   - Copy the generated URL → open it → add the bot to your Discord server

Your **Client ID** is on the OAuth2 page (also called Application ID).

### 3. Google Sheets Service Account

1. Go to https://console.cloud.google.com
2. Create a new project (or use an existing one)
3. Enable the **Google Sheets API**: APIs & Services → Enable APIs → search "Sheets"
4. Create a service account: APIs & Services → Credentials → Create Credentials → Service Account
   - Name it anything (e.g. "loot-tracker-bot")
   - Skip the optional role steps
5. Click the service account → **Keys** tab → **Add Key** → JSON
   - Download the JSON file → save it as `config/service-account.json` in this project
6. Copy the `client_email` from that JSON (looks like `name@project.iam.gserviceaccount.com`)
7. Open your Google Sheet → Share → paste that email → give it **Editor** access

### 4. Environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `DISCORD_TOKEN` — from step 2
- `DISCORD_CLIENT_ID` — from step 2
- `DISCORD_GUILD_ID` — your server's ID (right-click server name → Copy Server ID)  
  *(only needed during dev for instant command registration — remove for production)*
- `TEAM_MYTHIC_SHEET_ID` — the long ID from your Google Sheet URL
- `TEAM_MYTHIC_OFFICER_CHANNEL` — right-click your officer channel → Copy Channel ID
- `TEAM_MYTHIC_LOOT_CHANNEL` — right-click your loot channel → Copy Channel ID

To copy IDs in Discord you need Developer Mode on:  
Settings → Advanced → Developer Mode → ON

### 5. Register slash commands + start the bot

```bash
node src/deploy-commands.js   # register commands with Discord (run once per change)
npm run dev                    # start the bot (auto-restarts on file changes)
```

You should see:
```
[CMD] Loaded /history
[CMD] Loaded /bis
[BOT] Logged in as Canceled Loot Tracker#1234
[BOT] 2 command(s) loaded
```

Try `/history` in your loot channel. If the Sheet is empty it'll say "No loot recorded" — that's correct.

---

## Project structure

```
src/
  index.js              — bot entry point, loads commands, handles interactions
  deploy-commands.js    — one-shot script to register slash commands with Discord
  lib/
    sheets.js           — all Google Sheets reads/writes (nothing else touches the API)
    teams.js            — resolves team from channel ID, reads TEAM_* env vars
    permissions.js      — officer/channel access checks
  commands/
    raider/             — commands available in any team channel
      history.js        — /history [player]
      bis-show.js       — /bis show character:Name
    officer/            — commands restricted to officer channel + officer role
      (Phase 5+)
config/
  service-account.json  — Google service account key (gitignored, never commit this)
```

---

## Deploying to Railway

1. Push this repo to GitHub (make sure `.env` and `config/` are in `.gitignore` — they are)
2. Go to https://railway.com → New Project → Deploy from GitHub repo
3. Set environment variables in Railway's dashboard (Variables tab):
   - Everything from your `.env` file
   - Instead of `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`, set `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`
     to the **entire contents** of your `config/service-account.json` as a single line
     (paste it in, Railway handles the escaping)
4. Railway auto-detects Node.js and runs `npm start`
5. Run `node src/deploy-commands.js` once locally after setting `DISCORD_TOKEN` — commands
   only need to be registered once, not on every deploy

Expected monthly cost: **$5** (Hobby plan, bot sits mostly idle)

---

## Adding a second team (e.g. Heroic)

1. Create a second Google Sheet, share it with the service account email
2. Add to `.env` (and Railway variables):
   ```
   TEAM_HEROIC_SHEET_ID=<sheet_id>
   TEAM_HEROIC_OFFICER_CHANNEL=<channel_id>
   TEAM_HEROIC_LOOT_CHANNEL=<channel_id>
   ```
3. Restart the bot — no code changes needed

---

## Build phases

| Phase | What gets built | Branch |
|-------|----------------|--------|
| ✅ 1  | Project scaffold, Sheets auth, `/history`, `/bis show` | `main` |
| 2     | BIS web form + manual Sheet approval | `phase-2` |
| 3     | Blizzard API sync — Item DB seeding | `phase-3` |
| 4     | Full read commands: `/loot detail`, `/bis pending`, `/bis default`, `/item-drops` | `phase-4` |
| 5     | RCLC CSV import — `/loot import` | `phase-5` |
| 6     | Officer write commands, roster management, `/brief` manual | `phase-6` |
| 7     | Multi-team, `/transfer` | `phase-7` |
| 8     | BIS approval workflow, interactive embeds, DMs | `phase-8` |
| 9     | Pre-raid brief auto-scheduler | `phase-9` |
| 10    | WarcraftLogs attendance integration | `phase-10` |
