/**
 * Cross-device progress: the translation layer between the game's five progress
 * systems and the server's merge ledger.
 *
 * ── Why the merge is not here ─────────────────────────────────────────────
 *
 * This file does not merge anything. It converts the local systems into the
 * ledger's shape, posts them, and applies whatever comes back. The union
 * happens once, in Postgres, as a UNIQUE constraint - see
 * `site/lib/progressLedger.ts`.
 *
 * That is deliberate and it is the whole reason the endpoint returns the merged
 * state rather than an acknowledgement. Two merge implementations, one on each
 * side of the wire, would eventually disagree, and the disagreement would show
 * up as a player's relics quietly changing count. One implementation, in the
 * place that has both copies.
 *
 * ── What travels, and what does not ───────────────────────────────────────
 *
 * Only monotone facts: which relics, which viewpoints, which seams, which
 * wings, which charters, which deeds, which opening steps, which days and
 * weeks the retention loop has claimed, best times, and high-water counters. Rosters (`elements`, `wingRoster`, and the charter
 * board's per-world rosters) do NOT travel - they are lookups learned from the
 * worlds a player has visited, not progress, and they rebuild themselves.
 * Position, health, the active world and the loadout do not travel either; see
 * the design note in
 * `docs/superpowers/specs/2026-08-23-save-parity-design.md` section 6.
 *
 * Because rosters stay local, applying the server's answer never replaces a
 * whole payload: each system's local `serialize()` is taken as the base and
 * only the synced fields are overwritten, then handed to its own
 * `deserialize()`. One application path per system, the one it already had.
 */

/** Endpoint. Overridable so tests do not need a network. */
const ENDPOINT = '/api/game/progress';

/** `sighted` / `landed` as an ordered number, so GREATEST means "furthest". */
const SURVEY_RANK = { sighted: 1, landed: 2 };
const SURVEY_NAME = ['', 'sighted', 'landed'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keysOf = (v) => (isObj(v) ? Object.keys(v) : []);

/* ---------------------------------------------------------------------- */
/* Local systems -> ledger payload                                         */
/* ---------------------------------------------------------------------- */

/**
 * Build the ledger payload from whatever the systems currently hold.
 *
 * Every system is optional and every read is guarded: a game booted without
 * mining, or with a system that throws in `serialize`, must still sync the
 * others rather than lose the lot.
 */
export function toPayload({
  relics, viewpoints, mining, objectives, trials, races, charters, onboarding, retention,
} = {}) {
  const items = [];
  const values = [];
  const set = (kind, scope, keys) => {
    const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k) : [];
    if (list.length) items.push({ kind, scope: scope || '', keys: list });
  };
  const val = (kind, scope, key, n) => {
    const v = Number(n);
    if (typeof key === 'string' && key && Number.isFinite(v)) {
      values.push({ kind, scope: scope || '', key, value: Math.trunc(v) });
    }
  };
  const safe = (fn) => { try { return fn(); } catch { return null; } };

  const r = safe(() => relics?.serialize?.());
  if (isObj(r)) {
    for (const world of keysOf(r.foundIds)) set('relic', world, r.foundIds[world]);
    set('relic_paid', '', r.paid);
  }

  const v = safe(() => viewpoints?.serialize?.());
  if (isObj(v)) {
    for (const world of keysOf(v.worlds)) set('viewpoint', world, v.worlds[world]);
    for (const world of keysOf(v.charts)) set('chart', world, v.charts[world]);
    set('viewpoint_paid', '', v.sets);
  }

  const m = safe(() => mining?.serialize?.());
  if (isObj(m)) {
    set('mining', '', m.taken);
    val('mining_stat', '', 'mined', m.mined);
    val('mining_stat', '', 'credits', m.credits);
  }

  const o = safe(() => objectives?.serialize?.());
  if (isObj(o)) {
    set('wing', '', o.wings);
    for (const id of keysOf(o.kills)) val('kills', '', id, o.kills[id]);
    for (const id of keysOf(o.survey)) val('survey', '', id, SURVEY_RANK[o.survey[id]] ?? 0);
    for (const type of keysOf(o.ore)) {
      const row = o.ore[type];
      if (!isObj(row)) continue;
      val('ore', 'n', type, row.n);
      val('ore', 'credits', type, row.credits);
    }
    val('tier', '', 'kill', o.killTier);
    val('tier', '', 'ore', o.oreTier);
    // The three one-shot set prizes, as receipts rather than numbers.
    const paid = [];
    if (o.wingSet) paid.push('wingSet');
    if (o.surveySet) paid.push('surveySet');
    if (o.landfallSet) paid.push('landfallSet');
    set('objective_paid', '', paid);
  }

  const t = safe(() => trials?.read?.());
  if (isObj(t) && isObj(t.best)) {
    for (const key of keysOf(t.best)) {
      const row = t.best[key];
      if (!isObj(row)) continue;
      // Keyed "worldId/venueId" locally; the ledger scopes by world.
      const slash = key.indexOf('/');
      const world = slash > 0 ? key.slice(0, slash) : '';
      const venue = slash > 0 ? key.slice(slash + 1) : key;
      // Milliseconds, because the ledger column is BIGINT and a float second
      // would truncate a personal best to the nearest whole second.
      val('trial', world, venue, Math.round(Number(row.time) * 1000));
    }
  }

  const rc = safe(() => races?.read?.());
  if (isObj(rc) && isObj(rc.best)) {
    for (const key of keysOf(rc.best)) {
      const row = rc.best[key];
      if (!isObj(row)) continue;
      /* Keyed `worldId/circuitId/difficulty` locally. The ledger scopes by
       * world, so the remaining TWO parts stay together as the item key - the
       * grade is half the identity, not a qualifier on it. See
       * `SaveGame._recordRace`. */
      const slash = key.indexOf('/');
      const world = slash > 0 ? key.slice(0, slash) : '';
      const rest = slash > 0 ? key.slice(slash + 1) : key;
      // Milliseconds, for the same reason a trial time is: the column is BIGINT.
      val('race', world, rest, Math.round(Number(row.time) * 1000));
    }
  }

  /* The mission spine. Only the two identity SETS travel; the learned rosters
   * stay local, exactly as `elements` and `wingRoster` do and for the reason in
   * this file's header - a roster is a record of what a world published, not of
   * what a player did, and it rebuilds itself on the next visit. */
  const c = safe(() => charters?.serialize?.());
  if (isObj(c)) {
    set('charter', '', c.charters);
    /* `worldId/deedId` locally; scoped by world here, so a deed cannot be
     * confused with the same-named deed of another world. */
    const byWorld = {};
    for (const key of Array.isArray(c.deeds) ? c.deeds : []) {
      if (typeof key !== 'string') continue;
      const slash = key.indexOf('/');
      if (slash <= 0) continue;
      (byWorld[key.slice(0, slash)] ??= []).push(key.slice(slash + 1));
    }
    for (const world of keysOf(byWorld)) set('deed', world, byWorld[world]);
  }

  const ob = safe(() => onboarding?.serialize?.());
  if (isObj(ob)) set('onboarding', '', ob.done);

  /* The retention loop. Two sets of ids and no numbers - see the note on
   * `retention` in `progressLedger.ts` for why the run of consecutive days
   * stays on the device that computed it. */
  const rt = safe(() => retention?.serialize?.());
  if (isObj(rt)) {
    set('retention', '', rt.done);
    /* `seasonId/worldId` locally; scoped by season here, so a world charted in
     * one window cannot be confused with the same world charted in another -
     * the same split the deed block above makes on the world id. */
    const bySeason = {};
    for (const key of Array.isArray(rt.season) ? rt.season : []) {
      if (typeof key !== 'string') continue;
      const slash = key.indexOf('/');
      if (slash <= 0) continue;
      (bySeason[key.slice(0, slash)] ??= []).push(key.slice(slash + 1));
    }
    for (const id of keysOf(bySeason)) set('season', id, bySeason[id]);
  }

  return { items, values };
}

/* ---------------------------------------------------------------------- */
/* Ledger state -> local systems                                           */
/* ---------------------------------------------------------------------- */

const itemsOf = (state, kind) => (isObj(state?.items) && isObj(state.items[kind]) ? state.items[kind] : {});
const valuesOf = (state, kind) => (isObj(state?.values) && isObj(state.values[kind]) ? state.values[kind] : {});

/**
 * Apply the server's merged answer to the live systems.
 *
 * Returns the number of systems it actually reached, so a caller can tell
 * "nothing to do" from "everything failed".
 */
export function applyState(state, {
  relics, viewpoints, mining, objectives, trials, races, charters, onboarding, retention,
} = {}) {
  if (!isObj(state)) return 0;
  let applied = 0;
  const safe = (fn) => { try { return fn(); } catch { return false; } };

  /* Relics. `found` is derived from the ids so the two cannot disagree - the
   * same rule `Relics.serialize` follows. */
  const relicWorlds = itemsOf(state, 'relic');
  if (relics?.deserialize && (keysOf(relicWorlds).length || keysOf(itemsOf(state, 'relic_paid')).length)) {
    const foundIds = {};
    const found = {};
    for (const world of keysOf(relicWorlds)) {
      const list = relicWorlds[world] ?? [];
      if (!list.length) continue;
      foundIds[world] = [...list];
      found[world] = list.length;
    }
    const paid = itemsOf(state, 'relic_paid')[''] ?? [];
    if (safe(() => relics.deserialize({ found, foundIds, paid: [...paid] })) !== false) applied++;
  }

  const vpWorlds = itemsOf(state, 'viewpoint');
  const chartWorlds = itemsOf(state, 'chart');
  if (viewpoints?.deserialize && (keysOf(vpWorlds).length || keysOf(chartWorlds).length)) {
    const worlds = {};
    for (const world of keysOf(vpWorlds)) if (vpWorlds[world]?.length) worlds[world] = [...vpWorlds[world]];
    const charts = {};
    for (const world of keysOf(chartWorlds)) if (chartWorlds[world]?.length) charts[world] = [...chartWorlds[world]];
    const sets = itemsOf(state, 'viewpoint_paid')[''] ?? [];
    if (safe(() => viewpoints.deserialize({ worlds, charts, sets: [...sets] })) !== false) applied++;
  }

  const taken = itemsOf(state, 'mining')[''] ?? [];
  const miningStats = valuesOf(state, 'mining_stat')[''] ?? {};
  if (mining?.deserialize && (taken.length || keysOf(miningStats).length)) {
    if (safe(() => mining.deserialize({
      taken: [...taken],
      mined: Number(miningStats.mined) || 0,
      credits: Number(miningStats.credits) || 0,
    })) !== false) applied++;
  }

  /* Objectives keeps two ROSTERS that are learned locally from the worlds this
   * session has visited, not progress. Start from the live payload so those
   * survive, and overwrite only what the ledger actually carries. */
  if (objectives?.deserialize && objectives?.serialize) {
    const base = safe(() => objectives.serialize());
    if (isObj(base)) {
      const next = { ...base };
      /* Only write back if the ledger actually carried something. A server with
       * no rows yet - a first sync, or a failed read that degraded to an empty
       * object - must be a no-op, not an authoritative "you have nothing". That
       * mistake is how a sync deletes a save. */
      let touched = false;

      const wings = itemsOf(state, 'wing')[''];
      if (wings?.length) { next.wings = [...wings]; touched = true; }

      const kills = valuesOf(state, 'kills')[''] ?? {};
      if (keysOf(kills).length) {
        next.kills = {};
        for (const id of keysOf(kills)) next.kills[id] = Number(kills[id]) || 0;
        touched = true;
      }

      const survey = valuesOf(state, 'survey')[''] ?? {};
      if (keysOf(survey).length) {
        next.survey = {};
        for (const id of keysOf(survey)) {
          const name = SURVEY_NAME[Number(survey[id])] ?? '';
          if (name) next.survey[id] = name;
        }
        touched = true;
      }

      const oreN = valuesOf(state, 'ore').n ?? {};
      const oreCr = valuesOf(state, 'ore').credits ?? {};
      if (keysOf(oreN).length) {
        next.ore = {};
        for (const type of keysOf(oreN)) {
          next.ore[type] = {
            n: Number(oreN[type]) || 0,
            credits: Number(oreCr[type]) || 0,
            // The display name is a roster fact; keep whatever this build knows.
            name: base.ore?.[type]?.name ?? type,
          };
        }
        touched = true;
      }

      const tiers = valuesOf(state, 'tier')[''] ?? {};
      if (Number.isFinite(Number(tiers.kill))) { next.killTier = Number(tiers.kill); touched = true; }
      if (Number.isFinite(Number(tiers.ore))) { next.oreTier = Number(tiers.ore); touched = true; }

      const objPaid = new Set(itemsOf(state, 'objective_paid')[''] ?? []);
      if (objPaid.size) {
        next.wingSet = next.wingSet || objPaid.has('wingSet');
        next.surveySet = next.surveySet || objPaid.has('surveySet');
        next.landfallSet = next.landfallSet || objPaid.has('landfallSet');
        touched = true;
      }

      if (touched && safe(() => objectives.deserialize(next)) !== false) applied++;
    }
  }

  const trialVals = valuesOf(state, 'trial');
  if (typeof trials?.merge === 'function' && keysOf(trialVals).length) {
    const best = {};
    for (const world of keysOf(trialVals)) {
      for (const venue of keysOf(trialVals[world])) {
        best[`${world}/${venue}`] = { time: Number(trialVals[world][venue]) / 1000, worldId: world };
      }
    }
    if (safe(() => trials.merge(best)) !== false) applied++;
  }

  const raceVals = valuesOf(state, 'race');
  if (typeof races?.merge === 'function' && keysOf(raceVals).length) {
    const best = {};
    for (const world of keysOf(raceVals)) {
      for (const rest of keysOf(raceVals[world])) {
        best[`${world}/${rest}`] = { time: Number(raceVals[world][rest]) / 1000, worldId: world };
      }
    }
    if (safe(() => races.merge(best)) !== false) applied++;
  }

  /* Charters and deeds. The local ROSTERS are kept and only the two sets are
   * overwritten, the same rule the objectives block above follows for its
   * rosters - and for the stronger version of the reason: a roster arriving
   * from another device could name content this build's worlds no longer have,
   * which would leave a denominator nobody can fill.
   *
   * The charter set is handed over as a claim, not as truth.
   * `Charters.deserialize` clamps every id in it against the record that earned
   * it, so a device that finished a world contributes its charter only where
   * the underlying relics, viewpoints and seams merged across with it. */
  if (charters?.deserialize && charters?.serialize) {
    const base = safe(() => charters.serialize());
    if (isObj(base)) {
      const next = { ...base };
      let touched = false;
      const won = itemsOf(state, 'charter')[''];
      if (won?.length) {
        next.charters = [...new Set([...(base.charters ?? []), ...won])];
        touched = true;
      }
      const deedWorlds = itemsOf(state, 'deed');
      if (keysOf(deedWorlds).length) {
        const merged = new Set(base.deeds ?? []);
        for (const world of keysOf(deedWorlds)) {
          for (const id of deedWorlds[world] ?? []) merged.add(`${world}/${id}`);
        }
        next.deeds = [...merged];
        touched = true;
      }
      if (touched && safe(() => charters.deserialize(next)) !== false) applied++;
    }
  }

  /* Retention. UNION with what this device already has, never a replacement,
   * for the same reason the onboarding block below unions: `deserialize`
   * REPLACES by design, and a phone that claimed Tuesday must not un-claim the
   * Monday this desktop did. Nothing in this loop ever needs to come out, so
   * the union is not merely safe here - it is the only correct operation. */
  if (retention?.deserialize && retention?.serialize) {
    const base = safe(() => retention.serialize());
    if (isObj(base)) {
      const days = itemsOf(state, 'retention')[''];
      const seasonScopes = itemsOf(state, 'season');
      if (days?.length || keysOf(seasonScopes).length) {
        const done = new Set(Array.isArray(base.done) ? base.done : []);
        for (const k of days ?? []) done.add(k);
        const season = new Set(Array.isArray(base.season) ? base.season : []);
        for (const id of keysOf(seasonScopes)) {
          for (const world of seasonScopes[id] ?? []) season.add(`${id}/${world}`);
        }
        if (safe(() => retention.deserialize({ done: [...done], season: [...season] })) !== false) {
          applied++;
        }
      }
    }
  }

  const steps = itemsOf(state, 'onboarding')[''];
  if (onboarding?.deserialize && steps?.length) {
    /* UNION with what this device already has, never a replacement. A phone
     * that has done three steps must not un-teach the five this desktop did,
     * and `deserialize` REPLACES by design - so the union is built here, which
     * is the same shape the objectives block uses. */
    const base = safe(() => onboarding.serialize?.());
    const done = new Set([...(isObj(base) && Array.isArray(base.done) ? base.done : []), ...steps]);
    if (safe(() => onboarding.deserialize({ done: [...done] })) !== false) applied++;
  }

  return applied;
}

/* ---------------------------------------------------------------------- */
/* The round trip                                                          */
/* ---------------------------------------------------------------------- */

/**
 * Push this device's progress, adopt the merged answer.
 *
 * One round trip and one arbitration point. Failure is not fatal and not
 * retried here: the local save is untouched either way, and the next sync
 * carries the same monotone facts, so nothing is lost by skipping one.
 *
 * `systems.trials` is a pair rather than a bare function - `{ read(), merge(best) }` -
 * because the best-time ledger has no owning system and `SaveGame` keeps it
 * itself. One callable doing both jobs depending on its arguments read as a bug
 * every time it was looked at.
 *
 * @returns {Promise<{ok:boolean, applied:number, changed:number, rejected:string[]}>}
 */
export async function syncProgress(systems, { fetch: fetchImpl, endpoint = ENDPOINT } = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, applied: 0, changed: 0, rejected: [] };

  const payload = toPayload(systems);
  try {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
    const body = await res.json();
    const applied = applyState(body?.state, systems);
    if (body?.rejected?.length) {
      console.warn('[progress] the server did not recognise:', body.rejected.join(', '));
    }
    return {
      ok: true,
      applied,
      changed: Number(body?.changed) || 0,
      rejected: body?.rejected ?? [],
    };
  } catch (err) {
    console.warn('[progress] sync failed:', err?.message ?? err);
    return { ok: false, applied: 0, changed: 0, rejected: [] };
  }
}
