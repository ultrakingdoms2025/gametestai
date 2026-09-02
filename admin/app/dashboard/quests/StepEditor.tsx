'use client';

import { useState } from 'react';
import {
  QUEST_WORLD_OPTIONS,
  STEP_TYPES,
  STEP_WORLD_OPTIONS,
  UNFINISHABLE_STEP_TYPES,
  targetsFor,
  worldLabel,
} from '@/lib/questVocab';

export type Step = {
  order: number;
  label: string;
  type: string;
  target: string;
  count: number;
  world: string;
};

/**
 * The step editor.
 *
 * ── Nothing in this file lists a step type, a world or a target ─────────────
 *
 * It used to list all three, and all three had drifted from the engine:
 *
 *   - `STEP_TYPES` offered `deliver`, `escort`, `investigate`, `craft` and
 *     `stealth`. There is no crafting system, no delivery mechanic, no escort
 *     AI and no stealth meter — none of the five has an emitter anywhere in
 *     `src/`, so every one of them authored a step no player action can ever
 *     advance, inside a quest the player can accept.
 *   - It omitted `minigame`, `mine` and `pilot`, which the engine handles and
 *     which eleven shipped quests already use. Opening one of those in the
 *     editor put the select on a value it did not have, so saving rewrote the
 *     step's type and quietly broke a working quest.
 *   - `WORLD_OPTIONS` named five worlds. `dock` was missing, and steps may in
 *     fact be scoped to any of eighteen registered worlds, because
 *     `_advanceSteps` gates on the world the player is standing in and nothing
 *     else — an accepted engagement keeps advancing after the player walks
 *     into a quest-less world.
 *   - The target list was a hand-picked forty-odd ids, several of which no
 *     world can emit.
 *
 * Everything now comes from `lib/questVocab.ts`, which is generated from
 * `scripts/quest-vocab.mjs` — the same vocabulary the test suite judges the
 * seeded content with. The server refuses anything outside it (see
 * `questSaveSchema`); this half is so the operator does not have to be refused
 * to find out.
 */

const TYPE_HINT: Record<string, string> = {
  visit:     'entering the world',
  collect:   'picking an item out of a pickup',
  talk:      'pressing E on an NPC that is NOT a quest desk',
  interact:  'a quest desk, or walking a portal',
  kill:      'killing a hostile',
  defend:    'each hit landed on a hostile',
  race:      'finishing a race, or a lap when count > 1',
  purchase:  'a marketplace trade',
  customize: 'changing the character',
  survive:   'each 30 damage-free seconds',
  mine:      'cutting a mineral seam',
  pilot:     'setting a hull down — a crash does not count',
  minigame:  'finishing a contest, win or loss',
};

function blank(order: number): Step {
  return { order, label: '', type: 'visit', target: '', count: 1, world: '' };
}

/**
 * The targets this step could name, grouped by the world that emits them.
 *
 * A step with no world of its own inherits the QUEST's world, which this
 * component cannot see — the world select lives in the server-rendered form
 * beside it and can change without a round trip. So rather than guess, a
 * world-less step is offered every quest world's vocabulary with the world
 * named on each group, and the server rejects a mismatch by name.
 */
function targetGroups(step: Step): Array<{ label: string; options: readonly string[] }> {
  if (step.world) {
    const options = targetsFor(step.type, step.world);
    return options.length ? [{ label: worldLabel(step.world), options }] : [];
  }
  return QUEST_WORLD_OPTIONS
    .map((w) => ({ label: `${w.displayName} (${w.id})`, options: targetsFor(step.type, w.id) }))
    .filter((group) => group.options.length > 0);
}

export default function QuestStepEditor({ initial }: { initial: Step[] }) {
  const [steps, setSteps] = useState<Step[]>(initial.length ? initial : [blank(1)]);

  function add() {
    setSteps((prev) => [...prev, blank(prev.length + 1)]);
  }

  function remove(idx: number) {
    setSteps((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.map((s, i) => ({ ...s, order: i + 1 }));
    });
  }

  function update<K extends keyof Step>(idx: number, key: K, val: Step[K]) {
    setSteps((prev) => prev.map((s, i) => i === idx ? { ...s, [key]: val } : s));
  }

  function targetPreset(step: Step) {
    const value = step.target?.trim() ?? '';
    if (!value) return '';
    const known = targetGroups(step).some((group) => group.options.includes(value));
    return known ? value : '__custom__';
  }

  const nonEmpty = steps.filter((s) => s.label.trim());

  return (
    <div>
      {/* Hidden field that carries the serialised steps to the server action */}
      <input type="hidden" name="steps_json" value={JSON.stringify(nonEmpty)} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((step, idx) => {
          /* A quest authored before the type list was fixed can hold a type
             the engine cannot advance. Keep it in the select rather than
             silently rewriting it on save, and say what it is. */
          const dead = UNFINISHABLE_STEP_TYPES.includes(step.type);
          const unknown = !dead && !STEP_TYPES.includes(step.type) && step.type !== '';
          const groups = targetGroups(step);

          return (
          <div
            key={idx}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 110px 140px 60px 110px auto',
              gap: 6,
              alignItems: 'end',
              background: 'var(--bg-alt, #1a1a2e)',
              padding: '10px 12px',
              borderRadius: 6,
            }}
          >
            <div>
              <div className="step-col-label">Step {idx + 1} — label</div>
              <input
                placeholder={`e.g. "Collect 5 relay crystals"`}
                value={step.label}
                onChange={(e) => update(idx, 'label', e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className="step-col-label">Type</div>
              <select value={step.type} onChange={(e) => update(idx, 'type', e.target.value)}>
                {STEP_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
                {dead || unknown ? (
                  <option value={step.type}>{step.type} — unfinishable</option>
                ) : null}
              </select>
            </div>
            <div>
              <div className="step-col-label">Target ID</div>
              <select
                value={targetPreset(step)}
                onChange={(e) => update(idx, 'target', e.target.value === '__custom__' ? step.target : e.target.value)}
                style={{ width: '100%', marginBottom: 6 }}
              >
                <option value="">-- any {step.type} counts --</option>
                {groups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((option) => (
                      <option key={`${group.label}:${option}`} value={option}>{option}</option>
                    ))}
                  </optgroup>
                ))}
                <option value="__custom__">Custom…</option>
              </select>
              {targetPreset(step) === '__custom__' && (
                <input
                  placeholder="Custom target id"
                  value={step.target}
                  onChange={(e) => update(idx, 'target', e.target.value)}
                  style={{ width: '100%' }}
                />
              )}
            </div>
            <div>
              <div className="step-col-label">Count</div>
              <input
                type="number"
                min="1"
                value={step.count}
                onChange={(e) => update(idx, 'count', Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div>
              <div className="step-col-label">World</div>
              <select value={step.world} onChange={(e) => update(idx, 'world', e.target.value)}>
                <option value="">-- same as quest --</option>
                <optgroup label="Quest worlds">
                  {QUEST_WORLD_OPTIONS.map((w) => (
                    <option key={w.id} value={w.id}>{w.displayName}</option>
                  ))}
                </optgroup>
                {/* A step scoped to a quest-less world still advances there —
                    only ACCEPTING a quest is gated by the `quests` rule. */}
                <optgroup label="No quest board — steps still advance">
                  {STEP_WORLD_OPTIONS.filter((w) => !w.quests).map((w) => (
                    <option key={w.id} value={w.id}>{w.displayName}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="button"
                onClick={() => remove(idx)}
                title="Remove step"
                style={{
                  background: 'rgba(255,85,102,0.15)',
                  border: '1px solid rgba(255,85,102,0.4)',
                  color: '#ff8899',
                  borderRadius: 4,
                  width: 28,
                  height: 28,
                  cursor: 'pointer',
                  fontSize: 16,
                  lineHeight: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                &times;
              </button>
            </div>

            {(dead || unknown || groups.length === 0) ? (
              <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--red)' }}>
                {dead || unknown
                  ? `"${step.type}" has no emitter in the game — no player action can advance this
                     step. Pick the closest real verb and make the label honest about the goal.`
                  : `Nothing in ${step.world ? worldLabel(step.world) : 'any quest world'} can emit a
                     "${step.type}" event, so this step cannot complete there.`}
              </div>
            ) : (
              <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--txt-dim)' }}>
                Advances on {TYPE_HINT[step.type] ?? 'the matching game event'}.
              </div>
            )}
          </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={add}
        style={{
          marginTop: 10,
          background: 'rgba(82,233,255,0.08)',
          border: '1px dashed rgba(82,233,255,0.35)',
          color: 'var(--cy)',
          borderRadius: 6,
          padding: '7px 18px',
          cursor: 'pointer',
          fontSize: 13,
          fontFamily: 'inherit',
        }}
      >
        + Add step
      </button>

      {steps.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--txt-dim)', marginTop: 6 }}>
          No steps defined yet. Click &ldquo;+ Add step&rdquo; to add the first one.
        </div>
      )}
    </div>
  );
}
