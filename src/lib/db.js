/**
 * db.js — D1 query layer (replaces sheets.js)
 *
 * All functions take a D1 database binding as the first argument.
 * In production: the Workers env.DB binding.
 * In local dev/tests: a wrapper created by openLocalDb() in scripts/local-db.js.
 *
 * Query pattern:
 *   const { results } = await db.prepare(sql).bind(...args).all();
 *   const row         = await db.prepare(sql).bind(...args).first();
 *   await             db.prepare(sql).bind(...args).run();
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

const all   = (db, sql, ...args) => db.prepare(sql).bind(...args).all().then(r => r.results);
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run   = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

// ── In-process TTL cache ──────────────────────────────────────────────────────
// Reduces D1 row reads for requests handled by the same Worker isolate.
// Cloudflare keeps isolates alive between requests (up to 30 s idle), so this
// effectively caches across rapid sequential requests from the same user/team.
//
// TTLs — tuned to how often each table changes in practice:
//   LONG   (5 min)  item_db, default_bis, spec_bis_config, tier_items
//   MEDIUM (2 min)  global_config, default_bis_overrides
//   SHORT  (60 s)   team_config, roster, rclc_map, raids, tier_snapshot, worn_bis
//   BRIEF  (30 s)   bis_submissions, loot_log

const _cache    = new Map(); // key → { value, expiresAt }
const _inflight = new Map(); // key → Promise  (in-flight dedup: concurrent reads share one query)

const TTL = {
  LONG:   5 * 60_000,
  MEDIUM: 2 * 60_000,
  SHORT:  60_000,
  BRIEF:  30_000,
};

function cacheGet(key) {
  const hit = _cache.get(key);
  return (hit && Date.now() < hit.expiresAt) ? hit.value : null;
}

function cacheSet(key, value, ttl) {
  _cache.set(key, { value, expiresAt: Date.now() + ttl });
}

/** Exact-key invalidation. Pass multiple keys to invalidate several at once. */
function cacheInvalidate(...keys) {
  for (const key of keys) _cache.delete(key);
}

/** Prefix invalidation — use when teamId is not available at the write site. */
function cacheInvalidatePrefix(prefix) {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
}

async function cachedRead(key, ttl, loader) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  if (_inflight.has(key)) return _inflight.get(key);
  const promise = loader()
    .then(value => { cacheSet(key, value, ttl); _inflight.delete(key); return value; })
    .catch(err  => { _inflight.delete(key); throw err; });
  _inflight.set(key, promise);
  return promise;
}

// ── Teams ─────────────────────────────────────────────────────────────────────

export async function getAllTeams(db) {
  return all(db, 'SELECT * FROM teams WHERE id > 0 ORDER BY id');
}

export async function getTeamByName(db, name) {
  return first(db, 'SELECT * FROM teams WHERE name = ?', name);
}

// ── Global config ─────────────────────────────────────────────────────────────

export async function getGlobalConfig(db) {
  return cachedRead('global_config', TTL.MEDIUM, async () => {
    const rows = await all(db, 'SELECT key, value FROM global_config');
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  });
}

// ── Team config ───────────────────────────────────────────────────────────────

export async function getTeamConfig(db, teamId) {
  return cachedRead(`team_config:${teamId}`, TTL.SHORT, async () => {
    const rows = await all(db, 'SELECT key, value FROM team_config WHERE team_id = ?', teamId);
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  });
}

export async function setTeamConfigValue(db, teamId, key, value) {
  await run(db,
    'INSERT INTO team_config (team_id, key, value) VALUES (?, ?, ?) ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value',
    teamId, key, String(value)
  );
  cacheInvalidate(`team_config:${teamId}`);
}

export async function setGlobalConfigValue(db, key, value) {
  await run(db,
    'INSERT INTO global_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, String(value)
  );
  cacheInvalidate('global_config');
}

/** Returns RCLC response map as a plain array (for serialisation). */
export async function getRclcResponseMapRows(db, teamId) {
  return cachedRead(`rclc_map:${teamId}`, TTL.SHORT, () =>
    all(db,
      'SELECT rclc_button, internal_type, counted_in_totals FROM rclc_response_map WHERE team_id = ? ORDER BY rclc_button',
      teamId,
    )
  );
}

/**
 * Full-replace the RCLC response map for a team.
 * entries: [{ button, internalType, counted }]
 */
export async function setRclcResponseMap(db, teamId, entries) {
  await run(db, 'DELETE FROM rclc_response_map WHERE team_id = ?', teamId);
  for (const { button, internalType, counted } of entries) {
    await run(db,
      'INSERT INTO rclc_response_map (team_id, rclc_button, internal_type, counted_in_totals) VALUES (?, ?, ?, ?)',
      teamId, button, internalType, counted ? 1 : 0,
    );
  }
  cacheInvalidate(`rclc_map:${teamId}`);
}

// ── Roster ────────────────────────────────────────────────────────────────────

function parseRosterRow(r) {
  return {
    ...r,
    secondarySpecs:      r.secondary_specs ? r.secondary_specs.split('|').filter(Boolean) : [],
    pendingPrimarySpec:  r.pending_primary_spec ?? '',
  };
}

export async function getRoster(db, teamId) {
  return cachedRead(`roster:${teamId}`, TTL.SHORT, async () => {
    const rows = await all(db,
      'SELECT * FROM roster WHERE team_id = ? ORDER BY char_name',
      teamId
    );
    return rows.map(parseRosterRow);
  });
}

export async function getRosterMember(db, id) {
  const row = await first(db, 'SELECT * FROM roster WHERE id = ?', id);
  return row ? parseRosterRow(row) : null;
}

export async function getRosterByOwnerId(db, teamId, ownerId) {
  const rows = await all(db,
    'SELECT * FROM roster WHERE team_id = ? AND owner_id = ?',
    teamId, ownerId
  );
  return rows.map(parseRosterRow);
}

export async function addRosterChar(db, teamId, { charName, cls, spec, role, status = 'Active', server = '' }) {
  const result = await run(db,
    'INSERT INTO roster (team_id, char_name, class, spec, role, status, server) VALUES (?, ?, ?, ?, ?, ?, ?)',
    teamId, charName, cls, spec, role, status, server
  );
  cacheInvalidate(`roster:${teamId}`);
  return result.meta.last_row_id;
}

export async function deleteRosterChar(db, id) {
  await run(db, 'DELETE FROM roster WHERE id = ?', id);
  cacheInvalidatePrefix('roster:');
}

export async function renameRosterChar(db, id, newName) {
  await run(db, 'UPDATE roster SET char_name = ? WHERE id = ?', newName, id);
  cacheInvalidatePrefix('roster:');
}

export async function setRosterStatus(db, id, status) {
  await run(db, 'UPDATE roster SET status = ? WHERE id = ?', status, id);
  cacheInvalidatePrefix('roster:');
}

export async function setRosterOwner(db, id, ownerId, ownerNick) {
  await run(db, 'UPDATE roster SET owner_id = ?, owner_nick = ? WHERE id = ?', ownerId, ownerNick, id);
  cacheInvalidatePrefix('roster:');
}

export async function setOwnerNick(db, teamId, ownerId, ownerNick) {
  await run(db,
    'UPDATE roster SET owner_nick = ? WHERE team_id = ? AND owner_id = ?',
    ownerNick, teamId, ownerId
  );
  cacheInvalidate(`roster:${teamId}`);
}

export async function setRosterServer(db, id, server) {
  await run(db, 'UPDATE roster SET server = ? WHERE id = ?', server, id);
  cacheInvalidatePrefix('roster:');
}

export async function setSecondarySpecs(db, id, specs) {
  await run(db,
    'UPDATE roster SET secondary_specs = ? WHERE id = ?',
    specs.join('|'), id
  );
  cacheInvalidatePrefix('roster:');
}

export async function setPendingPrimarySpec(db, id, spec) {
  await run(db, 'UPDATE roster SET pending_primary_spec = ? WHERE id = ?', spec, id);
  cacheInvalidatePrefix('roster:');
}

export async function approvePrimarySpecChange(db, id) {
  const char = await getRosterMember(db, id);
  if (!char?.pending_primary_spec) return;
  await run(db,
    'UPDATE roster SET spec = ?, pending_primary_spec = ? WHERE id = ?',
    char.pending_primary_spec, '', id
  );
  cacheInvalidatePrefix('roster:');
}

export async function rejectPrimarySpecChange(db, id) {
  await run(db, 'UPDATE roster SET pending_primary_spec = ? WHERE id = ?', '', id);
  cacheInvalidatePrefix('roster:');
}

// ── Loot log ──────────────────────────────────────────────────────────────────

function parseLootRow(r) {
  return { ...r, ignored: r.ignored === 1 };
}

export async function getLootLog(db, teamId) {
  return cachedRead(`loot_log:${teamId}`, TTL.BRIEF, async () => {
    const rows = await all(db,
      `SELECT l.*, r.char_name AS resolved_char_name
       FROM loot_log l
       LEFT JOIN roster r ON r.id = l.recipient_char_id
       WHERE l.team_id = ?
       ORDER BY l.date DESC`,
      teamId
    );
    return rows.map(parseLootRow);
  });
}

export async function appendLootEntries(db, teamId, entries) {
  cacheInvalidate(`loot_log:${teamId}`);
  if (!entries.length) return;
  const stmt = db.prepare(
    `INSERT INTO loot_log (team_id, date, boss, item_name, difficulty, recipient_id, recipient_name, recipient_char_id, upgrade_type, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const e of entries) {
    await stmt.bind(
      teamId, e.date, e.boss, e.itemName, e.difficulty,
      e.recipientId ?? '', e.recipientChar ?? '',
      e.recipientCharId || null,
      e.upgradeType ?? '', e.notes ?? ''
    ).run();
  }
}

export async function patchLootEntryDifficulties(db, corrections) {
  // corrections: [{ id, difficulty }]
  const stmt = db.prepare('UPDATE loot_log SET difficulty = ? WHERE id = ?');
  for (const { id, difficulty } of corrections) {
    await stmt.bind(difficulty, id).run();
  }
  cacheInvalidatePrefix('loot_log:');
}

export async function patchLootEntryIgnored(db, ids, ignored) {
  const val = ignored ? 1 : 0;
  const placeholders = ids.map(() => '?').join(', ');
  await run(db, `UPDATE loot_log SET ignored = ? WHERE id IN (${placeholders})`, val, ...ids);
  cacheInvalidatePrefix('loot_log:');
}

export async function reassignLootEntries(db, assignments) {
  // assignments: [{ id, rosterId }]  — rosterId is roster.id (integer)
  const stmt = db.prepare(
    `UPDATE loot_log SET recipient_char_id = ?,
       recipient_id   = (SELECT owner_id  FROM roster WHERE id = ?),
       recipient_name = (SELECT char_name FROM roster WHERE id = ?)
     WHERE id = ?`
  );
  for (const { id, rosterId } of assignments) {
    await stmt.bind(rosterId, rosterId, rosterId, id).run();
  }
  cacheInvalidatePrefix('loot_log:');
}

export async function backfillLootEntryIds(db, teamId) {
  // Fill recipient_char_id for entries that have a name but no FK yet
  await run(db,
    `UPDATE loot_log SET recipient_char_id = (
       SELECT r.id FROM roster r
       WHERE r.team_id = loot_log.team_id
         AND r.char_name = loot_log.recipient_name
         AND r.server = ''
       LIMIT 1
     )
     WHERE team_id = ? AND recipient_char_id IS NULL AND recipient_name != ''`,
    teamId
  );
  cacheInvalidate(`loot_log:${teamId}`);
}

// ── BIS submissions ───────────────────────────────────────────────────────────

export async function getBisSubmissions(db, teamId) {
  return cachedRead(`bis_submissions:${teamId}`, TTL.BRIEF, () =>
    all(db,
      'SELECT * FROM bis_submissions WHERE team_id = ? ORDER BY submitted_at DESC',
      teamId
    )
  );
}

export async function upsertBisSubmission(db, teamId, { charId, charName, spec, slot, trueBis, trueBisItemId, raidBis, raidBisItemId, rationale }) {
  const submittedAt = new Date().toISOString();
  await run(db,
    `INSERT INTO bis_submissions (team_id, char_id, char_name, spec, slot, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id, rationale, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)
     ON CONFLICT(team_id, char_id, slot) DO UPDATE SET
       true_bis = excluded.true_bis, true_bis_item_id = excluded.true_bis_item_id,
       raid_bis = excluded.raid_bis, raid_bis_item_id = excluded.raid_bis_item_id,
       rationale = excluded.rationale, status = 'Pending', submitted_at = excluded.submitted_at`,
    teamId, charId || null, charName, spec, slot,
    trueBis ?? '', trueBisItemId || null,
    raidBis ?? '', raidBisItemId || null,
    rationale ?? '', submittedAt
  );
  cacheInvalidate(`bis_submissions:${teamId}`);
}

export async function batchUpsertBisSubmissions(db, teamId, updates) {
  for (const u of updates) {
    await upsertBisSubmission(db, teamId, u);
  }
}

export async function approveBisSubmission(db, id, reviewedBy) {
  await run(db,
    `UPDATE bis_submissions SET status = 'Approved', reviewed_by = ? WHERE id = ?`,
    reviewedBy, id
  );
  cacheInvalidatePrefix('bis_submissions:');
}

export async function rejectBisSubmission(db, id, reviewedBy, officerNote = '') {
  await run(db,
    `UPDATE bis_submissions SET status = 'Rejected', reviewed_by = ?, officer_note = ? WHERE id = ?`,
    reviewedBy, officerNote, id
  );
  cacheInvalidatePrefix('bis_submissions:');
}

export async function clearBisSubmission(db, teamId, charId, slot) {
  await run(db,
    'DELETE FROM bis_submissions WHERE team_id = ? AND char_id = ? AND slot = ?',
    teamId, charId, slot
  );
  cacheInvalidate(`bis_submissions:${teamId}`);
}

export async function clearPendingBisSubmission(db, teamId, charId, slot) {
  await run(db,
    `DELETE FROM bis_submissions WHERE team_id = ? AND char_id = ? AND slot = ? AND status = 'Pending'`,
    teamId, charId, slot
  );
  cacheInvalidate(`bis_submissions:${teamId}`);
}

export async function clearRejectedBisSubmission(db, teamId, charId, slot) {
  await run(db,
    `DELETE FROM bis_submissions WHERE team_id = ? AND char_id = ? AND slot = ? AND status = 'Rejected'`,
    teamId, charId, slot
  );
  cacheInvalidate(`bis_submissions:${teamId}`);
}

export async function resetBisRaidBisField(db, teamId, charId, slot) {
  await run(db,
    `UPDATE bis_submissions SET raid_bis = '', raid_bis_item_id = NULL WHERE team_id = ? AND char_id = ? AND slot = ?`,
    teamId, charId, slot
  );
  cacheInvalidate(`bis_submissions:${teamId}`);
}

// ── Item DB ───────────────────────────────────────────────────────────────────

export async function getItemDb(db) {
  return cachedRead('item_db', TTL.LONG, () =>
    all(db, 'SELECT * FROM item_db ORDER BY id')
  );
}

export async function writeItemDb(db, items, { replace = false } = {}) {
  if (replace) await run(db, 'DELETE FROM item_db');
  cacheInvalidate('item_db');
  const stmt = db.prepare(
    `INSERT INTO item_db (item_id, name, slot, source_type, source_name, instance, difficulty, armor_type, is_tier_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       name = excluded.name, slot = excluded.slot, source_type = excluded.source_type,
       source_name = excluded.source_name, instance = excluded.instance,
       difficulty = excluded.difficulty, armor_type = excluded.armor_type,
       is_tier_token = excluded.is_tier_token`
  );
  for (const item of items) {
    await stmt.bind(
      item.itemId, item.name, item.slot, item.sourceType, item.sourceName,
      item.instance, item.difficulty, item.armorType, item.isTierToken ? 1 : 0
    ).run();
  }
}

// ── Default BIS ───────────────────────────────────────────────────────────────

export async function getDefaultBis(db) {
  return cachedRead('default_bis', TTL.LONG, () =>
    all(db, 'SELECT * FROM default_bis ORDER BY spec, slot')
  );
}

export async function getSpecBisConfig(db) {
  return cachedRead('spec_bis_config', TTL.LONG, async () => {
    const rows = await all(db, 'SELECT spec, source FROM spec_bis_config');
    return new Map(rows.map(r => [r.spec, r.source]));
  });
}

export async function setSpecBisSource(db, spec, source) {
  await run(db,
    `INSERT INTO spec_bis_config (spec, source) VALUES (?, ?)
     ON CONFLICT(spec) DO UPDATE SET source = excluded.source`,
    spec, source
  );
  cacheInvalidate('spec_bis_config');
}

export async function getEffectiveDefaultBis(db) {
  const [allRows, specConfig] = await Promise.all([
    getDefaultBis(db),
    getSpecBisConfig(db),
  ]);

  // Group by spec+slot, pick preferred source
  const bySpecSlot = new Map();
  for (const row of allRows) {
    const key = `${row.spec}|${row.slot}`;
    if (!bySpecSlot.has(key)) bySpecSlot.set(key, []);
    bySpecSlot.get(key).push(row);
  }

  const result = [];
  for (const [key, rows] of bySpecSlot) {
    const preferredSource = specConfig.get(rows[0].spec);
    const preferred = preferredSource && rows.find(r => r.source === preferredSource);
    result.push(preferred ?? rows[0]);
  }
  return result;
}

// ── Default BIS overrides ─────────────────────────────────────────────────────
// Stored in the dedicated default_bis_overrides table (spec × slot × source PK).

export async function getDefaultBisOverrides(db) {
  return cachedRead('default_bis_overrides', TTL.MEDIUM, () =>
    all(db, 'SELECT * FROM default_bis_overrides')
  );
}

export async function updateDefaultBisOverrides(db, updates) {
  for (const u of updates) {
    await run(db,
      `INSERT INTO default_bis_overrides
         (spec, slot, source, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(spec, slot, source) DO UPDATE SET
         true_bis         = excluded.true_bis,
         true_bis_item_id = excluded.true_bis_item_id,
         raid_bis         = excluded.raid_bis,
         raid_bis_item_id = excluded.raid_bis_item_id`,
      u.spec, u.slot, u.source ?? '', u.trueBis ?? '', u.trueBisItemId || null,
      u.raidBis ?? '', u.raidBisItemId || null
    );
  }
  cacheInvalidate('default_bis_overrides');
}

// ── Tier items ────────────────────────────────────────────────────────────────

export async function getTierItems(db) {
  return cachedRead('tier_items', TTL.LONG, () =>
    all(db, 'SELECT * FROM tier_items ORDER BY class, slot')
  );
}

export async function setTierItems(db, items) {
  await run(db, 'DELETE FROM tier_items');
  cacheInvalidate('tier_items');
  const stmt = db.prepare('INSERT INTO tier_items (class, slot, item_id) VALUES (?, ?, ?)');
  for (const item of items) {
    await stmt.bind(item.class, item.slot, item.itemId).run();
  }
}

// ── Raids ─────────────────────────────────────────────────────────────────────

export async function getRaids(db, teamId) {
  return cachedRead(`raids:${teamId}`, TTL.SHORT, async () => {
    const raids = await all(db,
      'SELECT * FROM raids WHERE team_id = ? ORDER BY date DESC',
      teamId
    );
    const attendees = await all(db,
      `SELECT ra.raid_id, ra.user_id FROM raid_attendees ra
       JOIN raids r ON r.id = ra.raid_id
       WHERE r.team_id = ?`,
      teamId
    );
    const attendeeMap = new Map();
    for (const a of attendees) {
      if (!attendeeMap.has(a.raid_id)) attendeeMap.set(a.raid_id, []);
      attendeeMap.get(a.raid_id).push(a.user_id);
    }
    return raids.map(r => ({ ...r, attendeeIds: attendeeMap.get(r.id) ?? [] }));
  });
}

export async function upsertRaids(db, teamId, raids) {
  const raidStmt    = db.prepare(
    `INSERT INTO raids (raid_id, team_id, date, instance, difficulty)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(raid_id, team_id) DO UPDATE SET
       date = excluded.date, instance = excluded.instance, difficulty = excluded.difficulty`
  );
  const attendeeStmt = db.prepare(
    `INSERT OR IGNORE INTO raid_attendees (raid_id, user_id) VALUES (?, ?)`
  );
  for (const raid of raids) {
    await raidStmt.bind(raid.raidId, teamId, raid.date, raid.instance, raid.difficulty).run();
    const row = await first(db,
      'SELECT id FROM raids WHERE raid_id = ? AND team_id = ?',
      raid.raidId, teamId
    );
    for (const userId of (raid.attendeeIds ?? [])) {
      await attendeeStmt.bind(row.id, userId).run();
    }
  }
  cacheInvalidate(`raids:${teamId}`);
}

// ── Raid encounters ───────────────────────────────────────────────────────────

export async function getRaidEncounters(db, teamId) {
  return all(db,
    `SELECT re.* FROM raid_encounters re
     JOIN raids r ON r.id = re.raid_id
     WHERE r.team_id = ?`,
    teamId
  );
}

export async function upsertRaidEncounters(db, teamId, rows) {
  const stmt = db.prepare(
    `INSERT INTO raid_encounters (raid_id, encounter_id, boss_name, pulls, killed, best_pct)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(raid_id, encounter_id) DO UPDATE SET
       boss_name = excluded.boss_name, pulls = excluded.pulls,
       killed = excluded.killed, best_pct = excluded.best_pct`
  );
  for (const row of rows) {
    const raid = await first(db,
      'SELECT id FROM raids WHERE raid_id = ? AND team_id = ?',
      row.raidId, teamId
    );
    if (!raid) continue;
    await stmt.bind(raid.id, row.encounterId, row.bossName, row.pulls, row.killed ? 1 : 0, row.bestPct).run();
  }
}

// ── Tier snapshot ─────────────────────────────────────────────────────────────

export async function getTierSnapshot(db, teamId) {
  return cachedRead(`tier_snapshot:${teamId}`, TTL.SHORT, () =>
    all(db,
      `SELECT ts.*, r.char_name FROM tier_snapshot ts
       JOIN roster r ON r.id = ts.char_id
       WHERE r.team_id = ?`,
      teamId
    )
  );
}

export async function upsertTierSnapshot(db, teamId, snapshots) {
  const stmt = db.prepare(
    `INSERT INTO tier_snapshot (char_id, raid_id, tier_count, tier_detail, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(char_id) DO UPDATE SET
       raid_id = excluded.raid_id, tier_count = excluded.tier_count,
       tier_detail = excluded.tier_detail, updated_at = excluded.updated_at`
  );
  for (const snap of snapshots) {
    const raidRow = snap.raidId
      ? await first(db, 'SELECT id FROM raids WHERE raid_id = ? AND team_id = ?', snap.raidId, teamId)
      : null;
    await stmt.bind(snap.charId, raidRow?.id ?? null, snap.tierCount, snap.tierDetail, snap.updatedAt).run();
  }
  cacheInvalidate(`tier_snapshot:${teamId}`);
}

// ── Worn BIS ──────────────────────────────────────────────────────────────────

export async function getWornBis(db, teamId) {
  return cachedRead(`worn_bis:${teamId}`, TTL.SHORT, async () => {
    const rows = await all(db,
      `SELECT wb.* FROM worn_bis wb
       JOIN roster r ON r.id = wb.char_id
       WHERE r.team_id = ?`,
      teamId
    );
    const map = new Map();
    for (const r of rows) {
      map.set(`${r.char_id}:${r.spec}:${r.slot}`, r);
    }
    return map;
  });
}

export async function upsertWornBis(db, teamId, rows) {
  const stmt = db.prepare(
    `INSERT INTO worn_bis (char_id, slot, spec, overall_bis_track, raid_bis_track, other_track, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(char_id, slot, spec) DO UPDATE SET
       overall_bis_track = excluded.overall_bis_track,
       raid_bis_track    = excluded.raid_bis_track,
       other_track       = excluded.other_track,
       updated_at        = excluded.updated_at`
  );
  for (const row of rows) {
    await stmt.bind(
      row.charId, row.slot, row.spec ?? '',
      row.overallBISTrack ?? '', row.raidBISTrack ?? '', row.otherTrack ?? '',
      row.updatedAt
    ).run();
  }
  cacheInvalidate(`worn_bis:${teamId}`);
}

export async function clearWornBis(db, teamId) {
  await run(db,
    `DELETE FROM worn_bis WHERE char_id IN (SELECT id FROM roster WHERE team_id = ?)`,
    teamId
  );
  cacheInvalidate(`worn_bis:${teamId}`);
}

export async function invalidateWornBisSlots(db, teamId, targets) {
  // targets: [{ charId, slot }]  — charId here is roster.id (integer)
  const stmt = db.prepare(
    `DELETE FROM worn_bis WHERE char_id = ? AND slot = ?`
  );
  for (const { charId, slot } of targets) {
    await stmt.bind(charId, slot).run();
  }
  cacheInvalidate(`worn_bis:${teamId}`);
}

// ── RCLC response map ─────────────────────────────────────────────────────────

export async function getRclcResponseMap(db, teamId) {
  return cachedRead(`rclc_map:${teamId}`, TTL.SHORT, async () => {
    const rows = await all(db,
      'SELECT * FROM rclc_response_map WHERE team_id = ?',
      teamId
    );
    const map = new Map();
    for (const r of rows) {
      map.set(r.rclc_button, {
        internalType: r.internal_type,
        counted:      r.counted_in_totals === 1,
      });
    }
    return map;
  });
}
