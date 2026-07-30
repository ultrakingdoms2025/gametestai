'use client';

import { useState } from 'react';

export type Step = {
  order: number;
  label: string;
  type: string;
  target: string;
  count: number;
  world: string;
};

const STEP_TYPES = [
  'collect', 'visit', 'interact', 'kill', 'deliver',
  'race', 'escort', 'defend', 'investigate', 'craft', 'stealth', 'talk', 'survive', 'purchase', 'customize',
] as const;
 
const TARGET_GROUPS: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [
  {
    label: 'Interaction targets',
    options: [
      { value: 'quest_manager', label: 'Quest Manager' },
      { value: 'lorekeeper', label: 'Lorekeeper' },
      { value: 'vendor', label: 'Vendor' },
      { value: 'merchant', label: 'Merchant' },
      { value: 'quartermaster', label: 'Quartermaster' },
      { value: 'guard', label: 'Guard' },
    ],
  },
  {
    label: 'Worlds & portals',
    options: [
      { value: 'station', label: 'Station world' },
      { value: 'sports', label: 'Sports world' },
      { value: 'race', label: 'Race world' },
      { value: 'medieval', label: 'Medieval world' },
      { value: 'citadel', label: 'Citadel world' },
      { value: 'portal_station', label: 'Portal — Station' },
      { value: 'portal_sports', label: 'Portal — Sports' },
      { value: 'portal_race', label: 'Portal — Race' },
      { value: 'portal_medieval', label: 'Portal — Medieval' },
      { value: 'portal_citadel', label: 'Portal — Citadel' },
    ],
  },
  {
    label: 'Loot & pickups',
    options: [
      { value: 'credits', label: 'Credits pickup' },
      { value: 'bullet', label: 'Bullets pickup' },
      { value: 'arrow', label: 'Arrows pickup' },
      { value: 'fireball_charge', label: 'Fireball charge pickup' },
      { value: 'alloy_scrap', label: 'Alloy scrap pickup' },
      { value: 'medkit', label: 'Medkit pickup' },
      { value: 'nexus_shard', label: 'Nexus shard pickup' },
      { value: 'relic_coin', label: 'Relic coin pickup' },
    ],
  },
  {
    label: 'Purchases',
    options: [
      { value: 'bullet', label: 'Buy bullets' },
      { value: 'arrow', label: 'Buy arrows' },
      { value: 'fireball_charge', label: 'Buy fireball charges' },
      { value: 'medkit', label: 'Buy medkits' },
      { value: 'relic_coin', label: 'Buy relic coins' },
    ],
  },
  {
    label: 'Race results',
    options: [
      { value: '1st', label: 'Finish 1st' },
      { value: '2nd', label: 'Finish 2nd' },
      { value: '3rd', label: 'Finish 3rd' },
    ],
  },
  {
    label: 'Character customization',
    options: [
      { value: 'male', label: 'Male appearance' },
      { value: 'female', label: 'Female appearance' },
      { value: 'slim', label: 'Slim build' },
      { value: 'average', label: 'Average build' },
      { value: 'heavy', label: 'Heavy build' },
      { value: 'short', label: 'Short hair' },
      { value: 'crop', label: 'Crop hair' },
      { value: 'buzz', label: 'Buzz hair' },
      { value: 'ponytail', label: 'Ponytail hair' },
      { value: 'bun', label: 'Bun hair' },
      { value: 'long', label: 'Long hair' },
      { value: 'bald', label: 'Bald head' },
      { value: 'flightsuit', label: 'Flight suit outfit' },
      { value: 'jumpsuit', label: 'Jumpsuit outfit' },
      { value: 'tracksuit', label: 'Tracksuit outfit' },
      { value: 'sportskit', label: 'Sports kit outfit' },
      { value: 'tunic', label: 'Tunic outfit' },
      { value: 'robe', label: 'Robe outfit' },
    ],
  },
] as const;
 
const WORLD_OPTIONS = [
  { value: 'station', label: 'Station' },
  { value: 'sports',  label: 'Sports'  },
  { value: 'race',    label: 'Race'    },
  { value: 'medieval',label: 'Medieval'},
  { value: 'citadel', label: 'Citadel' },
] as const;

function blank(order: number): Step {
  return { order, label: '', type: 'visit', target: '', count: 1, world: '' };
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
    return TARGET_GROUPS.flatMap((group) => group.options).find((opt) => opt.value === value)?.value ?? '__custom__';
  }
 
  const nonEmpty = steps.filter((s) => s.label.trim());

  return (
    <div>
      {/* Hidden field that carries the serialised steps to the server action */}
      <input type="hidden" name="steps_json" value={JSON.stringify(nonEmpty)} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((step, idx) => (
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
                {STEP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <div className="step-col-label">Target ID</div>
              <select
                value={targetPreset(step)}
                onChange={(e) => update(idx, 'target', e.target.value === '__custom__' ? step.target : e.target.value)}
                style={{ width: '100%', marginBottom: 6 }}
              >
                <option value="">-- choose target --</option>
                {TARGET_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
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
                <option value="">-- same --</option>
                {WORLD_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
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
          </div>
        ))}
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
