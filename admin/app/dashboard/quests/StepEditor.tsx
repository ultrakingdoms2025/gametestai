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
  'race', 'escort', 'defend', 'investigate', 'craft', 'stealth', 'talk', 'survive',
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
              <input
                placeholder="relay_node"
                value={step.target}
                onChange={(e) => update(idx, 'target', e.target.value)}
              />
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
