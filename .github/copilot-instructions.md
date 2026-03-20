# Copilot / AI Agent Instructions — MystOracle: Age of the Firstborn

Quick actionable notes to help an AI agent be productive when editing or extending this repo.

1. Project overview
- Electron + Vite front-end using Three.js for a voxel-based shooter.
- Electron main: `main.cjs` (CommonJS, Node/Electron entry). Client: ES modules under `src/` (Vite root).
- Render loop and game assembly live in `src/renderer.js` which composes `player`, `controls`, `terrain`, `walls`, `particles`, `models`, and `sky`.

2. How to run / build (Windows-focused but equivalent npm commands exist)
- Dev (fast): `npm run dev` (or `npx vite`) + open Electron: use `start.bat` which starts Vite, waits for port 5173, then launches `npx electron .`.
- Production build: `npm run build` (Vite) or run `build.bat` which additionally strips BOMs from JSON, auto-increments the patch version in `package.json`, builds and runs Electron.
- Launch Electron directly: `npm start` / `npx electron .` (main.cjs auto-detects dev vs prod).

3. Vite / packaging details
- `vite.config.js` sets `root: 'src'`, `publicDir: '../public'`, and `build.outDir: '../dist'` — static assets should be in `public/` (e.g. `public/models/`).
- `package.json` uses `type: "commonjs"` so Node/Electron code is CJS; client code is ES module (served by Vite).

4. Key architectural patterns & useful entry points
- Entry points:
  - Electron main: `main.cjs`
  - Client assembly & loop: `src/renderer.js`
  - Player/camera: `src/player.js`
  - Input/movement: `src/controls.js`
  - Terrain/voxel engine: `src/terrain.js`
  - Wall system (interactive scene objects): `src/walls.js`
  - Shooting & raycasting: `src/shooting.js`
  - Particles: `src/particles.js`
  - Model loading: `src/models.js` (GLTFLoader; models expected under `/models` served from `public/models`)

5. Data shapes & cross-file contracts to respect
- Terrain chunking: code expects chunks keyed by `"cx,cz"`. Voxel storage is a 3D array accessed as `[localX][y][localZ]`.
- Raycasting / walls: `createWallSystem` exposes `getRaycastBlockers()` which returns objects passed to `Raycaster.intersectObjects()` in `setupShooting()`.
- Particle system registers particles per chunk via chunk keys; when unloading chunks, agents should call `removeChunkParticles(key)`.

6. Project-specific conventions / gotchas (discoverable from code)
- BOM-safety: `build.bat` runs a Node one-liner to remove BOMs from all JSON files before building — avoid adding UTF-8 BOMs to JSON files.
- Versioning: `build.bat` auto-increments the patch (`x.y.Z`) in `package.json` — be aware when editing `package.json` during automated flows.
- Mixing module systems: Electron `main.cjs` is CommonJS; client code is ES module (served by Vite). Keep server-side code CJS and client-side code ESM.
- Devtools: `main.cjs` opens DevTools in dev mode — useful for debugging renderer-side issues.

7. Immediate checks / common edits an agent will perform
- When altering terrain APIs, confirm that `createTerrain` returns the expected properties (`chunkSize`, `voxelSize`, `height`) because multiple modules (e.g. `walls.js`, `renderer.js`) read those properties at runtime.
- When adding models, place them in `public/models/` and reference them from `src/models.js` (paths like `/models/gun.glb`).
- When adding new scene objects that must be raycast-hit, ensure they’re included in the lists returned by `wallSystem.getRaycastBlockers()` or passed directly to the raycast call.

8. Useful search terms and code anchors
- `getVoxelAt`, `updateChunks` (terrain engine)
- `createWallSystem`, `getRaycastBlockers` (interactive objects)
- `setupShooting` (input → raycast → destroy handlers)
- `loadModels` (model/asset loading)

9. Files to inspect for context when making changes
- `main.cjs`, `vite.config.js`, `build.bat`, `start.bat`, `setup.bat`, `src/renderer.js`, and any `src/*.js` module mentioned above.

If anything here is unclear or you want me to expand a specific area (e.g. list of runtime globals, a small suggested fix for the terrain export mismatch, or a short PR that documents/exposes `chunkSize` on the terrain object), tell me which part to iterate on.
