// @vitest-environment jsdom
/**
 * The first component test in this repository.
 *
 * ── Why this one, and why it is the shape it is ───────────────────────────
 *
 * `MarketplaceAdminPanel` reported NOTHING on a successful save. The cause was
 * two state writes in one synchronous continuation — `setMessage('Item
 * updated.')` immediately followed by a `resetForm()` that cleared it — so
 * React batched them and the blank won. Every save in the marketplace admin was
 * silent, in production, for as long as the panel has existed.
 *
 * It survived because nothing here has ever rendered a component. `lib/` has
 * eighty test files; `components/` had scene-determinism tests and no `.tsx` at
 * all, and this class of bug is invisible to every one of them: the reducer
 * logic is correct in isolation, the network call is correct, the copy is
 * correct. Only a render shows that the string never reaches the screen.
 *
 * ── Deliberately no testing-library ───────────────────────────────────────
 *
 * `react`'s own `act` and `react-dom/client` are already dependencies. Adding
 * `@testing-library/react` and `@testing-library/dom` to assert on
 * `textContent` would be two more packages between this file and the DOM for no
 * assertion it could not already make. `jsdom` is the one thing genuinely
 * missing, and the docblock pragma above scopes it to this file, so nothing
 * else in the suite changes environment.
 *
 * ── What is stubbed ───────────────────────────────────────────────────────
 *
 * `fetch` only. The panel talks to two routes — the list and the save — and
 * both are stubbed to succeed; everything else is the real component. Stubbing
 * `resetForm` or the message state would be testing the fix rather than the
 * behaviour, and the behaviour is the thing that broke.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarketplaceAdminPanel } from './MarketplaceAdminPanel';

/* React 19 requires this flag before `act` will drive updates. */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ITEM = {
  id: 'itm_1',
  name: 'Rifle rounds',
  description: 'Sixty of them.',
  category: 'weapons',
  image: '',
  game_action: 'ammo_pack_rifle',
  action_config: { effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 },
  quantity: null,
  cost_buy: 40,
  cost_sell: 10,
  world_name: 'station',
  is_active: true,
  sort_order: 0,
  source_key: null,
};

let container: HTMLDivElement;
let root: Root;

/** Every fetch this component makes, answered with a 200 and a plausible body. */
function stubFetch() {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const body = url.includes('?') || !init?.method || init.method === 'GET'
      ? { items: [ITEM] }
      : { item: ITEM };
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const status = () =>
  container.querySelector('[data-testid="marketplace-status"]')?.textContent ?? '';
const alert = () =>
  container.querySelector('[data-testid="marketplace-alert"]')?.textContent ?? '';

/** Click the button whose visible label is exactly `label`. */
async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button'))
    .find((b) => b.textContent?.trim() === label);
  if (!button) {
    throw new Error(
      `No button labelled "${label}". Found: `
      + Array.from(container.querySelectorAll('button'))
        .map((b) => JSON.stringify(b.textContent?.trim())).join(', ')
    );
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount() {
  await act(async () => { root.render(<MarketplaceAdminPanel />); });
  /* The initial list load is behind a 250 ms debounce. */
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
}

describe('MarketplaceAdminPanel', () => {
  it('reports a successful create in the status region', async () => {
    stubFetch();
    await mount();

    expect(status().trim()).toBe('');

    await click('Create item');

    /* THE REGRESSION. Before `keepMessage`, `resetForm()` cleared this in the
     * same React batch that set it and the assertion below saw an empty
     * string — which is exactly what every human operator saw. */
    expect(status()).toContain('Item created.');
    expect(alert().trim()).toBe('');
  });

  it('reports a successful edit, and does not lose it to the form reset', async () => {
    stubFetch();
    await mount();

    /* Edit puts the panel in `editingId` mode, which is the branch where the
     * save calls `resetForm()` — the exact path the bug lived on. */
    await click('Edit');
    expect(status()).toContain(`Editing ${ITEM.name}`);

    await click('Save changes');

    expect(status()).toContain('Item updated.');
    /* And the reset still happened: the form is back to "New item". */
    expect(container.textContent).toContain('New item');
  });

  it('puts a failure in the alert region and not the status region', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'Buy cost must be a whole number.' }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ items: [ITEM] }) } as unknown as Response;
    }));
    await mount();

    await click('Create item');

    expect(alert()).toContain('Buy cost must be a whole number.');
    expect(status().trim()).toBe('');
  });
});
