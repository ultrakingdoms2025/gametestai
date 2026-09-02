# Aether Nexus Desktop

This package wraps the production Aether Nexus site as a native desktop window.
It preserves the existing login, signup, Stripe checkout, protected game launch,
player saves, quests, custom servers, and social chat because those services stay
on `https://aethernexus.games`.

## Run locally

```powershell
cd desktop
npm install
npm start
```

To test another deployment without changing code:

```powershell
$env:AETHER_NEXUS_URL = 'https://your-preview.vercel.app/'
npm start
```

`AETHER_NEXUS_URL` works **only in a development run**. `main.cjs` ignores it
whenever `app.isPackaged` is true, and refuses any value that is not `http:` or
`https:` even in development. That gate exists because anything able to write a
user's environment — an installer, a shortcut's *Start in*, a login script,
another program spawning this one — could otherwise repoint the trusted window
at a page of its choosing, permanently and invisibly.

## Build Windows installers

```powershell
cd desktop
npm install
npm run dist
```

The artefacts are written to `desktop/release/` (`build.directories.output`).

## Store and Steam builds

The configured Windows targets are:

```powershell
# Microsoft Store package (unsigned; Partner Center signs it during submission)
npx electron-builder --win appx --config.directories.output="C:\Users\$env:USERNAME\AetherNexusRelease\MicrosoftStore"

# Steam depot package
npx electron-builder --win zip --config.directories.output="C:\Users\$env:USERNAME\AetherNexusRelease\Steam"
```

The general Windows build creates an installer and portable executable. The
AppX configuration uses the identity and publisher assigned by Microsoft
Partner Center for the Aether Nexus product. If Partner Center assigns a new
identity, update `appx.identityName`, `appx.applicationId`, and `appx.publisher`
before rebuilding; do not edit the generated `.appx` file.

## Hardening

Three things guard a window that renders remote content full time, and all three
are load-bearing. Read `main.cjs` and `afterPack.cjs` before changing any of
them — both carry the reasoning in full.

### 1. The renderer is sandboxed and has no bridge

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
`preload.cjs` exposes two read-only strings, and there is not one `ipcMain`
handler in the package. Do not add one without a handler that validates every
argument; an `ipcMain.handle` that accepts a path or a URL from the page undoes
everything else here.

### 2. Navigation and permissions are policed in the main process

`main.cjs` attaches one policy to every `WebContents` via
`app.on('web-contents-created')`, so a popup cannot come up less guarded than
the window that opened it. Top-level navigation is restricted to an origin
allowlist; `shell.openExternal` refuses anything but `https:`; camera and
microphone are denied outright (nothing in `src/`, `site/` or `admin/` calls
`getUserMedia`); `fullscreen` and `pointerLock` are granted to the app's own
origin only.

The allowlist contains `checkout.stripe.com` and `accounts.google.com` on
purpose. Both are top-level navigations the live site performs — Stripe Checkout
and Google sign-in — and removing them breaks paying and signing in from the
desktop client.

### 3. The shipped binary's fuses are flipped

`afterPack.cjs` runs `@electron/fuses` over the packaged executable, which
rewrites a bitfield inside the binary itself and so cannot be undone by an
environment variable, a flag, or an edit to anything shipped beside it:

| Fuse | Set to | Why |
| --- | --- | --- |
| `RunAsNode` | off | Otherwise `ELECTRON_RUN_AS_NODE=1 "Aether Nexus.exe" -e "…"` makes the installed game a general-purpose Node interpreter that every allowlisting and EDR product on the machine already trusts. |
| `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` can `--require` a file into the main process. |
| `EnableNodeCliInspectArguments` | off | `--inspect` opens a port that evaluates in the main process, where there is no sandbox. |
| `EnableCookieEncryption` | on | The session cookie is a logged-in Aether Nexus account. |
| `EnableEmbeddedAsarIntegrityValidation` | on | Refuses a tampered `app.asar`. electron-builder computes and injects the hash automatically while `asar` is enabled. |
| `OnlyLoadAppFromAsar` | on | Electron prefers `resources/app/` over `resources/app.asar`; without this, anything that can write the install directory owns the app by dropping one file. |

`nsis.perMachine` is `true` for the same reason as the last row: a per-user
install root is writable by any non-admin process on the machine.

**If you set `asar: false` or `disableAsarIntegrity: true`, take
`EnableEmbeddedAsarIntegrityValidation` off in the same commit** — the app will
refuse to start otherwise.

## Code signing — what the operator must supply

The build is **wired for signing and deliberately unconfigured**. No certificate
ships in this repository and none should. `build.win.signtoolOptions` pins the
hash algorithm and an RFC-3161 timestamp server; electron-builder skips signing
with a warning when it finds no certificate, so `npm run dist` works today and
produces an **unsigned** installer.

Windows shows SmartScreen's "unrecognised app" warning on every unsigned
download, and an unsigned build cannot be shipped through Steam or the Microsoft
Store as a trusted publisher. To sign:

1. **Buy an OV or EV code-signing certificate** from a CA (DigiCert, Sectigo,
   GlobalSign). As of June 2023 every code-signing key must live on hardware —
   a FIPS 140-2 Level 2 token, or the CA's cloud HSM. An EV certificate clears
   SmartScreen reputation immediately; an OV one has to earn it over time and
   downloads.
2. **Export or reference the certificate**, then set these two environment
   variables in the build environment (never in a file in this repository):

   ```powershell
   $env:CSC_LINK = 'C:\path\to\certificate.pfx'   # or a base64 data URI / https URL
   $env:CSC_KEY_PASSWORD = '<the .pfx password>'
   ```

   electron-builder reads both natively; nothing in `package.json` needs to
   change. In CI, hold them as encrypted secrets.
3. **For a cloud HSM or an Azure Trusted Signing account**, `CSC_LINK` does not
   apply — configure `build.win.azureSignOptions` (Azure Trusted Signing) or a
   custom `build.win.sign` hook that shells out to the CA's signing tool, and
   supply that tool's own credentials as environment variables.
4. **Verify** after a build:

   ```powershell
   Get-AuthenticodeSignature 'release\Aether Nexus Setup 1.0.0.exe' | Format-List
   ```

   `Status` must be `Valid` and the timestamp must be present, or the signature
   expires with the certificate rather than outliving it.

The AppX/Microsoft Store target is the exception: Partner Center re-signs it
during submission, so it is built unsigned on purpose.

## Distribution note

This is an online desktop client, not an offline copy of the game. The current
web game uses same-origin authenticated API routes for account state, purchases,
quests, chat, and protected launch. A truly local game bundle would need a
separate desktop authentication bridge and API-origin configuration before it
could retain those features safely.

Never place Stripe secret keys in this package. Payments remain on the website.
