/**
 * Aether Nexus desktop launcher — main process.
 *
 * This window renders REMOTE CONTENT full time: it is a chrome-less browser
 * pointed at https://aethernexus.games/. That single fact is what decides
 * everything below. A local-HTML Electron app can be sloppy about navigation
 * because the only pages it ever loads are its own; this one loads whatever
 * the site serves, including pages the site did not write (Stripe Checkout,
 * Google's consent screen), so every boundary the renderer can reach has to
 * have a policy attached to it in the MAIN process, where the page cannot
 * touch it.
 *
 * ── WHAT WAS ALREADY RIGHT, AND MUST STAY RIGHT ───────────────────────────
 * `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true` are
 * the three that matter most, and they were all correct before this file was
 * hardened. `preload.cjs` exposes two read-only strings and nothing else, and
 * there is not one `ipcMain` handler in the package — so there is no bridge
 * for a compromised renderer to walk across. Do not add one without a matching
 * argument-validating handler; an `ipcMain.handle` that takes a path or a URL
 * from the page undoes the whole of the above.
 *
 * ── WHAT WAS WRONG (the September 2026 audit) ─────────────────────────────
 *  1. `setWindowOpenHandler` allowed the site's own origin and then called
 *     `shell.openExternal(url)` UNCONDITIONALLY for everything else. On
 *     Windows `shell.openExternal` is ShellExecute: a page-supplied
 *     `file:///C:/Users/…/payload.exe`, a UNC path (`\\attacker\share\x.exe`),
 *     or any registered protocol handler would have been RUN, not opened.
 *     Now: only `https:` ever reaches `openExternal`, checked by parsing the
 *     URL rather than by prefix — `startsWith('https://')` is satisfied by
 *     `https://evil.example@aethernexus.games/`, `new URL().protocol` is not.
 *  2. There was NO `will-navigate` handler at all, so a single
 *     `location.href = 'https://evil.example/'` — from an XSS on the site, a
 *     compromised third-party script, or a hostile ad — silently replaced the
 *     trusted window's contents while the frame, the title and the taskbar
 *     icon all still said Aether Nexus. That is the whole phishing attack, and
 *     it needed no exploit.
 *  3. The window-open policy was attached per-window inside `createWindow`, so
 *     any popup that WAS allowed came up with no policy of its own. The policy
 *     now hangs off `app.on('web-contents-created')`, which fires for every
 *     WebContents the app will ever have — windows, popups, webviews — so a
 *     child cannot be less guarded than its parent.
 *  4. The permission handler auto-granted `media` (that is CAMERA AND
 *     MICROPHONE, one string covers both) and `fullscreen` to whatever asked,
 *     discarding the requesting origin entirely — an embedded frame from any
 *     origin got the same answer as the site itself.
 *  5. `AETHER_NEXUS_URL` could repoint a SHIPPED build at any URL by setting
 *     one environment variable, which is a per-user persistent redirect of the
 *     trusted window that survives restarts.
 */

const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');

/** Where a shipped build always points. Not overridable — see SITE_URL. */
const PRODUCTION_URL = 'https://aethernexus.games/';

/**
 * The env override is a DEVELOPMENT convenience (README documents pointing it
 * at a preview deployment) and it is gated on `!app.isPackaged`, so it does
 * nothing in an installed build. Without that gate, anything able to write the
 * user's environment — an installer, a shortcut's "Start in", a login script,
 * another program's child-process env — permanently repoints the trusted
 * window at a page of its choosing, and every subsequent launch looks normal.
 *
 * It is parsed rather than trusted: a malformed value falls back to production
 * instead of throwing at startup, and a non-http(s) value (`file:`, `data:`)
 * is refused outright even in development, because `loadURL` will happily load
 * either and the rest of this file's origin checks have nothing to compare a
 * `file:` URL against.
 */
const SITE_URL = resolveSiteUrl();

function resolveSiteUrl() {
  const override = process.env.AETHER_NEXUS_URL;
  if (!override) return PRODUCTION_URL;
  if (app.isPackaged) {
    console.warn('[aether-nexus] AETHER_NEXUS_URL ignored: this is a packaged build.');
    return PRODUCTION_URL;
  }
  try {
    const parsed = new URL(override);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      console.warn(`[aether-nexus] AETHER_NEXUS_URL ignored: ${parsed.protocol} is not http(s).`);
      return PRODUCTION_URL;
    }
    return parsed.toString();
  } catch {
    console.warn('[aether-nexus] AETHER_NEXUS_URL ignored: not a URL.');
    return PRODUCTION_URL;
  }
}

/**
 * ORIGINS THE TRUSTED WINDOW MAY NAVIGATE TO.
 *
 * Origins, not prefixes. `https://evil.example/?x=https://aethernexus.games/`
 * passes a `startsWith` check and fails this one, which is the entire point.
 *
 * The last two are not decoration and must not be trimmed as "third parties":
 * both are TOP-LEVEL navigations the live site performs today, and removing
 * them breaks paying and signing in from the desktop client.
 *
 *   * `checkout.stripe.com` — `PayButton`, `CreditPicker` and
 *     `HostingSubscribeButton` all do `window.location.href = data.url` with
 *     the Session URL that `app/api/checkout/route.ts` returns.
 *   * `accounts.google.com` — `signIn('google', …)` on the login and register
 *     pages leaves the origin through NextAuth's `/api/auth/signin/google`.
 *
 * Anything else is denied and, if it is https, handed to the user's real
 * browser — where it gets a URL bar, the user's own extensions, and no
 * confusion about whose window it is.
 */
const ALLOWED_ORIGINS = new Set([
  new URL(SITE_URL).origin,
  'https://aethernexus.games',
  'https://www.aethernexus.games',
  'https://checkout.stripe.com',
  'https://accounts.google.com',
]);

function isAllowedNavigation(url) {
  try {
    return ALLOWED_ORIGINS.has(new URL(url).origin);
  } catch {
    return false; // unparseable is not allowed; there is nothing to compare
  }
}

/**
 * The ONLY path from page-supplied data to the operating system's shell.
 *
 * `shell.openExternal` on Windows is ShellExecute, which will run an
 * executable, mount and run from a UNC share, and invoke any protocol handler
 * the machine has registered. Restricting it to `https:` — by protocol, after
 * parsing — is what turns "the page picked a program to run" back into "the
 * page picked a web page to open".
 */
function openExternalIfSafe(url) {
  let protocol;
  try {
    ({ protocol } = new URL(url));
  } catch {
    return;
  }
  if (protocol !== 'https:') {
    console.warn(`[aether-nexus] refused to open ${protocol} externally.`);
    return;
  }
  shell.openExternal(url).catch(() => {
    /* The user's browser refusing to start is not this process's problem. */
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#070c12',
    title: 'Aether Nexus',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.setMenuBarVisibility(false);
  window.loadURL(SITE_URL);
}

/**
 * ONE POLICY, ATTACHED TO EVERY WebContents THE APP WILL EVER CREATE.
 *
 * `web-contents-created` fires for the main window, for any popup the
 * window-open handler allows, and for a `<webview>` if one ever appears — so a
 * child window cannot come up less guarded than its parent, which is exactly
 * what the per-window version of this code allowed.
 */
function applyNavigationPolicy(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) return { action: 'allow' };
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  // Top-level navigation of an existing window: the phishing case.
  contents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  });

  /**
   * SUB-FRAMES. `will-navigate` covers the main frame and nothing else, so
   * without this an `<iframe>` was unpoliced.
   *
   * It returns early for the main frame ON PURPOSE, and not because the main
   * frame does not matter: `will-frame-navigate` fires for the main frame too,
   * and if both handlers took it, a blocked top-level navigation would hand the
   * URL to `shell.openExternal` TWICE and the user would get two browser tabs.
   * One frame, one handler; `will-navigate` owns the main one.
   *
   * Sub-frames deliberately do NOT get the origin allowlist. Stripe Checkout
   * is itself a page full of `stripe.com` iframes, and 3-D Secure adds an
   * issuing bank's frame whose origin nobody can enumerate in advance, so an
   * origin allowlist here would fail closed on a card payment and be deleted
   * by whoever debugged it next.
   *
   * What a sub-frame is refused is a change of SCHEME. `file:`, `data:` and
   * any registered protocol are the ones worth stopping — a frame navigating
   * to `file:///` is trying to read the disk, and none of that is something a
   * payment page or a consent screen ever needs. http(s) inside a frame is
   * bounded by the sandbox and by web security, and is the price of hosted
   * checkout working at all.
   */
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    let protocol;
    try {
      ({ protocol } = new URL(event.url));
    } catch {
      event.preventDefault();
      return;
    }
    if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'about:') {
      console.warn(`[aether-nexus] blocked a sub-frame navigation to ${protocol}`);
      event.preventDefault();
    }
  });

  /* Nothing in this app uses a <webview>, and one attached by a compromised
   * page is a fresh renderer with attributes the page chose — including its
   * own preload. Refuse the tag outright rather than trying to sanitise it. */
  contents.on('will-attach-webview', (event) => {
    console.warn('[aether-nexus] blocked a <webview> attachment.');
    event.preventDefault();
  });
}

/**
 * WHAT THE PAGE MAY ASK THE OPERATING SYSTEM FOR.
 *
 * Two answers, and the origin is now part of both.
 *
 * DENIED: `media`. That one string covers the camera AND the microphone, and
 * it was being granted to anything that asked. `grep -rn "getUserMedia\|
 * mediaDevices\|getDisplayMedia\|MediaRecorder"` over `src/`, `site/` and
 * `admin/` returns ZERO hits — the game has no voice chat, no webcam avatar
 * and no screen capture — so there is nothing to break by refusing it. If
 * voice chat is ever built, add the permission back HERE, gated on the app's
 * own origin, and not by widening the default.
 *
 * GRANTED, to the app's own origin only. The list is short because it was
 * built by grepping for the APIs the code actually calls, not by guessing:
 *   * `fullscreen` — `src/core/Input.js` and `src/main.js` both call
 *     `requestFullscreen`, and the pause menu has a fullscreen preference.
 *   * `pointerLock` — it is a first-person shooter; mouse-look is pointer
 *     lock. The previous handler granted `['fullscreen', 'media']` and so
 *     denied this one.
 *   * `clipboard-sanitized-write` — `site/components/CopyableReference.tsx`
 *     calls `navigator.clipboard.writeText`. Write only, and sanitized;
 *     `clipboard-read` stays denied, because a page that can read the
 *     clipboard reads whatever the user last copied, which is routinely a
 *     password.
 *
 * `setPermissionCheckHandler` is the synchronous half of the same question
 * (`navigator.permissions.query`, and the checks Chromium makes without
 * raising a prompt). Setting only the request handler leaves the check handler
 * at Electron's default, which is a DIFFERENT answer to the same question — so
 * both are set, from one table. That is also why the clipboard entry is here:
 * adding a check handler without it would have silently broken a copy button
 * that works today.
 *
 * `navigator.storage.persist()` in `src/systems/SaveGame.js` is deliberately
 * NOT in this list. It already resolved false under the previous handler, and
 * `persistSave()` treats false as an answer rather than an error.
 */
const GRANTED_PERMISSIONS = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
]);

function permitted(permission, requestingOrigin) {
  if (!GRANTED_PERMISSIONS.has(permission)) return false;
  return ALLOWED_ORIGINS.has(requestingOrigin);
}

/** The requesting origin, from whichever of the two shapes Electron passes. */
function originOf(webContents, details) {
  const raw = details?.requestingUrl || details?.securityOrigin || webContents?.getURL?.() || '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permitted(permission, originOf(webContents, details)));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    permitted(permission, requestingOrigin || originOf(webContents, null))
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('web-contents-created', (_event, contents) => applyNavigationPolicy(contents));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
