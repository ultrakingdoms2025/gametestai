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

## Build Windows installers

```powershell
cd desktop
npm install
npm run dist
```

The installers are written to `desktop/dist/`.

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

## Distribution note

This is an online desktop client, not an offline copy of the game. The current
web game uses same-origin authenticated API routes for account state, purchases,
quests, chat, and protected launch. A truly local game bundle would need a
separate desktop authentication bridge and API-origin configuration before it
could retain those features safely.

Never place Stripe secret keys in this package. Payments remain on the website.
