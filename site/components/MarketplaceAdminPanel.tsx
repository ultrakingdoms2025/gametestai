'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  MARKETPLACE_ACTIONS,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_WORLDS,
  type MarketplaceActionId,
  type MarketplaceCategory,
  type MarketplaceItemRecord,
  type MarketplaceWorld,
} from '@/lib/marketplaceCatalog';
import { buildMarketplaceAiImageUrl } from '@/lib/marketplaceImages';

type FormState = {
  name: string;
  description: string;
  category: MarketplaceCategory;
  image: string;
  game_action: MarketplaceActionId;
  action_config: string;
  quantity: string;
  cost_buy: string;
  cost_sell: string;
  world_name: MarketplaceWorld;
  is_active: boolean;
  sort_order: string;
  source_key: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  category: 'weapons',
  image: '',
  game_action: 'ammo_pack_rifle',
  action_config: '{\n  "effect": "grant_ammo",\n  "ammo_item": "bullet",\n  "amount": 60\n}',
  quantity: '',
  cost_buy: '0',
  cost_sell: '0',
  world_name: 'station',
  is_active: true,
  sort_order: '0',
  source_key: '',
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

const CATEGORY_COLORS: Record<MarketplaceCategory, string> = {
  cosmetic: '#d46bff', weapons: '#52e9ff', tools: '#ffb44a', health: '#b6ff5a', spells: '#ff7d3c',
  mounts: '#ff8a5c',
};

const ACTION_ICONS: Record<string, [string, string]> = {
  ammo_pack_rifle:    ['🔫', '#52e9ff'],
  ammo_pack_arrow:    ['🏹', '#52e9ff'],
  ammo_pack_ember:    ['🔥', '#ff9b3c'],
  heal_25:            ['💊', '#b6ff5a'],
  heal_50:            ['❤️‍🩹', '#b6ff5a'],
  heal_full:          ['❤️', '#b6ff5a'],
  stamina_slowdown_25:  ['⚡', '#ffe97d'],
  stamina_slowdown_50:  ['⚡', '#ffe97d'],
  stamina_slowdown_75:  ['⚡', '#ffe97d'],
  stamina_slowdown_100: ['⚡', '#ffe97d'],
  firepower_boost_25:  ['💥', '#ff9b3c'],
  firepower_boost_50:  ['💥', '#ff9b3c'],
  firepower_boost_75:  ['💥', '#ff9b3c'],
  firepower_boost_100: ['💥', '#ff9b3c'],
  speed_boost_25:   ['💨', '#4cc9ff'],
  speed_boost_50:   ['💨', '#4cc9ff'],
  speed_boost_75:   ['💨', '#4cc9ff'],
  speed_boost_100:  ['💨', '#4cc9ff'],
  npc_pause_5s:  ['❄️', '#c0e8ff'],
  npc_pause_10s: ['❄️', '#c0e8ff'],
  npc_pause_30s: ['❄️', '#c0e8ff'],
  npc_pause_60s: ['❄️', '#c0e8ff'],
  shield_5s:       ['🛡️', '#7fe7ff'],
  loot_magnet_30s: ['🧲', '#7ce3a3'],
  portal_ping_30s: ['🌀', '#b08bff'],
  cosmetic_headgear: ['👒', '#d46bff'],
  cosmetic_shirt:    ['👕', '#d46bff'],
  cosmetic_pants:    ['👖', '#d46bff'],
  mount_strength_1: ['💪', '#ff8a5c'],
  mount_strength_2: ['💪', '#ff8a5c'],
  mount_strength_3: ['💪', '#ff8a5c'],
  mount_shield_1:   ['🛡️', '#ff8a5c'],
  mount_shield_2:   ['🛡️', '#ff8a5c'],
  mount_shield_3:   ['🛡️', '#ff8a5c'],
  mount_power_1:    ['🏎️', '#ff8a5c'],
  mount_power_2:    ['🏎️', '#ff8a5c'],
  mount_power_3:    ['🏎️', '#ff8a5c'],
};

const CATEGORY_FALLBACK_ART: Record<MarketplaceCategory, [string, string]> = {
  cosmetic: ['🎭', '#d46bff'],
  weapons:  ['🔫', '#52e9ff'],
  tools:    ['🔧', '#ffb44a'],
  health:   ['💊', '#b6ff5a'],
  spells:   ['✨', '#ff7d3c'],
  mounts:   ['🏎️', '#ff8a5c'],
};

function resolveArt(name: string, category: MarketplaceCategory, gameAction?: string): [string, string] {
  if (gameAction && ACTION_ICONS[gameAction]) return ACTION_ICONS[gameAction];
  return CATEGORY_FALLBACK_ART[category] ?? ['📦', '#52e9ff'];
}

function itemFallbackSvg(name: string, category: MarketplaceCategory, gameAction?: string): string {
  const [icon, fg] = resolveArt(name, category, gameAction);
  const label = (name || category || 'ITEM').toUpperCase().replace(/[^A-Z0-9 ]+/g, '').slice(0, 10);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="10" fill="#070c12"/><rect x="4" y="4" width="64" height="64" rx="9" stroke="${fg}" stroke-width="2" opacity="0.6"/><text x="36" y="42" text-anchor="middle" font-size="28" font-family="sans-serif">${icon}</text><text x="36" y="60" text-anchor="middle" font-size="9" font-family="monospace" fill="${fg}" opacity="0.8">${label}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function parseJsonConfig(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Action config must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function formFromItem(item?: MarketplaceItemRecord | null): FormState {
  if (!item) return { ...EMPTY_FORM };
  return {
    name: item.name,
    description: item.description,
    category: item.category,
    image: item.image,
    game_action: item.game_action,
    action_config: JSON.stringify(item.action_config ?? {}, null, 2),
    quantity: item.quantity == null ? '' : String(item.quantity),
    cost_buy: String(item.cost_buy),
    cost_sell: String(item.cost_sell),
    world_name: item.world_name,
    is_active: item.is_active,
    sort_order: String(item.sort_order),
    source_key: item.source_key ?? '',
  };
}

export function MarketplaceAdminPanel() {
  const [items, setItems] = useState<MarketplaceItemRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [world, setWorld] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [imageBusy, setImageBusy] = useState(false);

  const selectedAction = useMemo(
    () => MARKETPLACE_ACTIONS.find((action) => action.id === form.game_action) ?? MARKETPLACE_ACTIONS[0],
    [form.game_action]
  );

  async function loadItems() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (category) params.set('category', category);
      if (world) params.set('world', world);
      if (activeOnly) params.set('activeOnly', '1');
      const res = await fetch(`/api/admin/marketplace/items?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load marketplace items.');
      setItems(data.items ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load marketplace items.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => {
      void loadItems();
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category, world, activeOnly]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function beginEdit(item: MarketplaceItemRecord) {
    setEditingId(item.id);
    setForm(formFromItem(item));
    setMessage(`Editing ${item.name}`);
  }

  function resetForm() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setMessage('');
  }

  async function uploadImageFile(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMessage('Please choose an image file.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setMessage('Image file is too large. Please keep it under 2 MB.');
      return;
    }
    setImageBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      updateField('image', dataUrl);
      setMessage(`Uploaded image: ${file.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not upload image.');
    } finally {
      setImageBusy(false);
    }
  }

  function generateAiImage() {
    const imageUrl = buildMarketplaceAiImageUrl({
      name: form.name.trim() || 'Marketplace item',
      description: form.description.trim(),
      category: form.category,
      world: form.world_name,
      sourceKey: form.source_key.trim() || undefined,
    });
    updateField('image', imageUrl);
    setMessage('AI image applied.');
  }

  async function saveItem() {
    let actionConfig: Record<string, unknown>;
    try {
      actionConfig = parseJsonConfig(form.action_config);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Invalid action config.');
      return;
    }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      category: form.category,
      image: form.image.trim() || buildMarketplaceAiImageUrl({
        name: form.name.trim() || 'Marketplace item',
        description: form.description.trim(),
        category: form.category,
        world: form.world_name,
        sourceKey: form.source_key.trim() || undefined,
      }),
      game_action: form.game_action,
      action_config: actionConfig,
      quantity: form.quantity.trim() === '' ? null : Number(form.quantity),
      cost_buy: Number(form.cost_buy),
      cost_sell: Number(form.cost_sell),
      world_name: form.world_name,
      is_active: form.is_active,
      sort_order: Number(form.sort_order),
      source_key: form.source_key.trim() || null,
    };

    const url = editingId ? `/api/admin/marketplace/items/${editingId}` : '/api/admin/marketplace/items';
    const method = editingId ? 'PATCH' : 'POST';

    setLoading(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Save failed.');
      setMessage(editingId ? 'Item updated.' : 'Item created.');
      resetForm();
      await loadItems();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setLoading(false);
    }
  }

  async function deleteItem(item: MarketplaceItemRecord) {
    if (!confirm(`Remove ${item.name}?`)) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/marketplace/items/${item.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Delete failed.');
      setMessage(`Removed ${item.name}.`);
      if (editingId === item.id) resetForm();
      await loadItems();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  const panelStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1.1fr 1.2fr',
    gap: '20px',
    alignItems: 'start',
  };

  const cardStyle: CSSProperties = {
    border: '1px solid rgba(82, 233, 255, 0.2)',
    borderRadius: '16px',
    background: 'rgba(7, 16, 24, 0.72)',
    padding: '16px',
    boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    borderRadius: '10px',
    border: '1px solid rgba(140, 176, 200, 0.25)',
    background: 'rgba(4, 10, 15, 0.88)',
    color: 'inherit',
    padding: '10px 12px',
    font: 'inherit',
  };

  const labelStyle: CSSProperties = {
    display: 'grid',
    gap: '6px',
    fontSize: '13px',
    color: '#cfe6f2',
  };

  return (
    <div style={panelStyle}>
      <section style={cardStyle}>
        <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={labelStyle}>
              Search
              <input style={inputStyle} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items" />
            </label>
            <label style={labelStyle}>
              Category
              <select style={inputStyle} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All</option>
                {MARKETPLACE_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              World
              <select style={inputStyle} value={world} onChange={(e) => setWorld(e.target.value)}>
                <option value="">All</option>
                {MARKETPLACE_WORLDS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
            <label style={{ ...labelStyle, alignSelf: 'end' }}>
              <span>&nbsp;</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
                Active only
              </label>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" type="button" onClick={() => void loadItems()} disabled={loading}>
              {loading ? 'Working…' : 'Refresh'}
            </button>
            <button className="btn btn-ghost" type="button" onClick={resetForm}>New item</button>
            <span style={{ color: '#92adc1' }}>{message}</span>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {items.map((item) => (
            <article key={item.id} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 12, background: editingId === item.id ? 'rgba(82,233,255,0.08)' : 'rgba(0,0,0,0.14)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 12, alignItems: 'start' }}>
                <img
                  src={item.image || itemFallbackSvg(item.name, item.category, item.game_action)}
                  alt=""
                  width={64}
                  height={64}
                  onError={(e) => { e.currentTarget.src = itemFallbackSvg(item.name, item.category, item.game_action); }}
                  style={{ width: 64, height: 64, borderRadius: 12, objectFit: 'cover', background: '#0b1722', border: '1px solid rgba(255,255,255,0.08)' }}
                />
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{item.name}</strong>
                    <span style={{ color: '#9dc1d6' }}>{item.world_name}</span>
                    <span style={{ color: '#9dc1d6' }}>{item.category}</span>
                    {!item.is_active ? <span style={{ color: '#ff8b8b' }}>inactive</span> : null}
                  </div>
                  <div style={{ color: '#b8c9d6', marginTop: 4 }}>{item.description}</div>
                  <div style={{ color: '#90aabc', marginTop: 8, fontSize: 13 }}>
                    Buy {item.cost_buy} CR · Sell {item.cost_sell} CR · Qty {item.quantity == null ? 'unlimited' : item.quantity} · Action {item.game_action}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => beginEdit(item)}>Edit</button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => void deleteItem(item)}>Remove</button>
                </div>
              </div>
            </article>
          ))}
          {!items.length ? <div style={{ color: '#93a8b9' }}>No marketplace items found.</div> : null}
        </div>
      </section>

      <section style={cardStyle}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <div style={{ color: '#7fe7ff', fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
              {editingId ? 'Edit item' : 'New item'}
            </div>
            <h2 style={{ margin: '6px 0 0' }}>{form.name || 'Marketplace item'}</h2>
          </div>

          <label style={labelStyle}>
            Name
            <input style={inputStyle} value={form.name} onChange={(e) => updateField('name', e.target.value)} />
          </label>

          <label style={labelStyle}>
            Description
            <textarea style={{ ...inputStyle, minHeight: 110, resize: 'vertical' }} value={form.description} onChange={(e) => updateField('description', e.target.value)} />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <label style={labelStyle}>
              Category
              <select style={inputStyle} value={form.category} onChange={(e) => updateField('category', e.target.value as MarketplaceCategory)}>
                {MARKETPLACE_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              World
              <select style={inputStyle} value={form.world_name} onChange={(e) => updateField('world_name', e.target.value as MarketplaceWorld)}>
                {MARKETPLACE_WORLDS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
          </div>

          <label style={labelStyle}>
            Image URL or data URI
            <input
              style={inputStyle}
              value={form.image}
              onChange={(e) => updateField('image', e.target.value)}
              placeholder="Optional; leave blank to auto-generate AI image"
            />
          </label>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" type="button" onClick={generateAiImage} disabled={loading || imageBusy}>
                Generate AI image
              </button>
              <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                {imageBusy ? 'Uploading…' : 'Upload image'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    e.currentTarget.value = '';
                    void uploadImageFile(file);
                  }}
                />
              </label>
            </div>
            <div style={{ color: '#9ab3c8', fontSize: 12 }}>
              Upload supports PNG/JPG/WebP/GIF/SVG (max 2 MB). If image is blank, an AI image URL is generated automatically.
            </div>
            {form.image ? (
              <img
                src={form.image}
                alt={`${form.name || 'Marketplace item'} preview`}
                width={96}
                height={96}
                onError={(e) => { e.currentTarget.src = itemFallbackSvg(form.name, form.category, form.game_action); }}
                style={{ width: 96, height: 96, borderRadius: 12, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.1)', background: '#0b1722' }}
              />
            ) : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <label style={labelStyle}>
              Game action
              <select style={inputStyle} value={form.game_action} onChange={(e) => updateField('game_action', e.target.value as MarketplaceActionId)}>
                {MARKETPLACE_ACTIONS.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Quantity
              <input style={inputStyle} value={form.quantity} onChange={(e) => updateField('quantity', e.target.value)} placeholder="Leave blank for unlimited" />
            </label>
          </div>

          <label style={labelStyle}>
            Action config (JSON)
            <textarea style={{ ...inputStyle, minHeight: 120, resize: 'vertical' }} value={form.action_config} onChange={(e) => updateField('action_config', e.target.value)} />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
            <label style={labelStyle}>
              Buy cost
              <input style={inputStyle} value={form.cost_buy} onChange={(e) => updateField('cost_buy', e.target.value)} />
            </label>
            <label style={labelStyle}>
              Sell cost
              <input style={inputStyle} value={form.cost_sell} onChange={(e) => updateField('cost_sell', e.target.value)} />
            </label>
            <label style={labelStyle}>
              Sort order
              <input style={inputStyle} value={form.sort_order} onChange={(e) => updateField('sort_order', e.target.value)} />
            </label>
          </div>

          <label style={labelStyle}>
            Source key
            <input style={inputStyle} value={form.source_key} onChange={(e) => updateField('source_key', e.target.value)} placeholder="Optional unique seed key" />
          </label>

          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" checked={form.is_active} onChange={(e) => updateField('is_active', e.target.checked)} />
            Item is active
          </label>

          <div style={{ color: '#9ab3c8', fontSize: 13 }}>
            Selected action: <strong>{selectedAction.label}</strong> — {selectedAction.description}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" type="button" onClick={() => void saveItem()} disabled={loading}>
              {editingId ? 'Save changes' : 'Create item'}
            </button>
            <button className="btn btn-ghost" type="button" onClick={resetForm}>Clear</button>
          </div>
        </div>
      </section>
    </div>
  );
}
