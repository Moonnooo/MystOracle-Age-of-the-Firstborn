# MystOracle: Age of the Firstborn

A voxel-style first-person game: mine blocks, fight mobs, use chests and campfires. Built with Three.js and Electron.

---

## For players (just want to play)

**You don’t need to install Node.js or look at any code.**

1. Go to the [Releases](https://github.com/YOUR_USERNAME/voxel-shooter/releases) page for this repo.
2. Download the latest **Windows** build:
   - **MystOracle Age of the Firstborn X.X.X.exe** (portable – run directly, no install), or  
   - **MystOracle Age of the Firstborn Setup X.X.X.exe** (installer).
3. Run the `.exe`.  
   - Portable: double-click the exe.  
   - Installer: run the setup, then start “MystOracle: Age of the Firstborn” from the Start menu or desktop shortcut.

**Controls (in-game):**

- **WASD** – move  
- **Mouse** – look  
- **Click** – lock pointer / shoot or mine (depends on hotbar)  
- **E** – open/close backpack  
- **F** – interact (open chest, use campfire when looking at one)  
- **1–9** – hotbar  
- **Esc** – pause / close UI  

---

## For developers (clone and build)

If you want to run from source or create new player builds:

### Requirements

- Node.js 18+
- npm

### Setup and run (from source)

```bash
git clone https://github.com/YOUR_USERNAME/voxel-shooter.git
cd voxel-shooter
npm install
```

**Assets:** Put game assets in `public/` so the build can find them:

- `public/models/` – e.g. `character.glb`, `gun.glb`, `pickaxe.glb`, `chest.glb`, `campfire.glb`, `little_rambling.glb`
- `public/textures/` – e.g. `dirt.png`, `grass_side.png`, `grass_top.png`, `stone.png`, `sand.png`, `oak_log.png`, `oak_planks.png`, `oak_leaves.png`, `water_still.png` (ores/cactus/log ends also load from `public/textures/items/old texters/`)

Then:

```bash
npm run build
npm start
```

This builds the game into `dist/` and starts the Electron app (loads from `dist/` in production).

**Development (with hot reload):**

```bash
npm run dev
```

In another terminal:

```bash
npm start
```

The app will use the Vite dev server (no need to run `npm run build` each time).

### Create a player build (no source, shareable)

To generate the same kind of build that players download (packaged app, no editable source):

```bash
npm run dist
```

Output is in the `release/` folder:

- **Portable:** `release/win-unpacked/MystOracle Age of the Firstborn.exe` (or inside that folder)
- **Installer:** `release/MystOracle Age of the Firstborn Setup X.X.X.exe`

You can upload these to GitHub Releases so players can download and run them without seeing or editing the code. In your repo, go to **Releases** → **Create a new release** → tag a version (e.g. `v1.0.0`) → attach the portable `.exe` and/or the Setup `.exe` from `release/` → publish. Replace `YOUR_USERNAME` in the "For players" link above with your GitHub username.

---

## License

See the repository license file.
