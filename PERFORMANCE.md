# Performance recommendations

Quick reference for improving FPS and reducing load.

## Already implemented

- **Face culling** — Only exposed block faces are drawn (no inner faces).
- **Frustum culling** — Chunk meshes outside the camera view are not rendered.
- **Shared terrain material** — All chunk meshes use one material (fewer state changes, less memory).
- **Shadow map 512×512** — Lower resolution for cheaper shadows (see `src/core/lighting.js`).

---

## Tunables (no code change)

- **Render distance** — In-game **Settings** → lower “Render distance” (e.g. 1–2) to load fewer chunks. Biggest lever for large chunk sizes.
- **Chunk size / height** — In `src/renderer.js`, `createTerrain(scene, 1, 32, 64, null)`: reduce the third argument (chunk width/depth) or fourth (height) to lighten CPU/GPU and memory.

---

## Optional code changes

### Shadows (faster, slightly worse quality)

- **Shadow map resolution** — In `src/core/lighting.js`, `sun.shadow.mapSize.set(512, 512)` → keep 512 for performance; 1024 or 2048 for sharper shadows.
- **Shadow map type** — In `src/renderer.js`, `renderer.shadowMap.type`:
  - `THREE.BasicShadowMap` — Fastest, hard edges.
  - `THREE.PCFShadowMap` — Softer, still cheaper than PCFSoft.
  - `THREE.PCFSoftShadowMap` — Current; best quality, most expensive.

### Terrain

- **Greedy meshing (vertex merging)** — Merge adjacent same-type faces into larger quads instead of one quad per face. Cuts vertex count and can improve FPS; requires changes in `createChunkMesh` in `src/world/terrain.js`.
- **LOD for distant chunks** — Use simpler or lower-detail meshes for chunks far from the player (more work, good for very large worlds).

### Logic / systems

- **Mob updates** — In `src/systems/mobs.js`, skip or throttle AI for mobs far from the player (e.g. update every 2nd or 3rd frame when distance > N).
- **Particles** — Cap max particles and cull by distance in `src/systems/particles.js` if needed.

---

## Profiling

- **F3 overlay** — Shows FPS, chunks loaded, render distance. Use it when changing render distance or chunk size.
- **Browser/Electron devtools** — Use the Performance tab to see where time is spent (JS vs GPU).
