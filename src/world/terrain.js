// terrain.js

import * as THREE from 'three';
import { ASSET_BASE } from '../assets/assetBase.js';
import { BLOCK_IDS, isWater, waterLevel } from './blocksRegistry.js';
import { computeBaseHeight, worldHeightNoise } from './terrain/baseHeight.js';
import { getBiomeInfoAt, BIOMES, SEA_LEVEL } from './terrain/biomes.js';
import { LAYERED_SURFACE_THRESHOLDS } from './terrain/layeredTerrainGen.js';

// Terrain texture atlas: one row of tiles (see ATLAS indices below). Built when all images load.
let terrainAtlasTexture = null;

/** Horizontal UV width of one atlas tile (1 / number of tiles). */
const ATLAS_TILE_COUNT = 17;
const ATLAS_TILE_U = 1 / ATLAS_TILE_COUNT;

// Atlas tile indices — must match draw order in buildTerrainAtlas()
const ATLAS = {
    DIRT: 0,
    GRASS_SIDE: 1,
    GRASS_TOP: 2,
    STONE: 3,
    SAND: 4,
    OAK_LOG: 5,
    OAK_LOG_TOP: 6,
    OAK_PLANKS: 7,
    OAK_LEAVES: 8,
    WATER: 9,
    COAL_ORE: 10,
    IRON_ORE: 11,
    GOLD_ORE: 12,
    CACTUS_SIDE: 13,
    CACTUS_TOP: 14,
    CACTUS_BOTTOM: 15,
    SNOW: 16,
};

const ATLAS_LAYERS = [
    { rel: 'textures/dirt.png', fallback: '#6b3b2a' },
    { rel: 'textures/grass_side.png', fallback: '#3a7a2f' },
    { rel: 'textures/grass_top.png', fallback: '#2f6f25' },
    { rel: 'textures/stone.png', fallback: '#7a7a7a' },
    { rel: 'textures/sand.png', fallback: '#dbd383' },
    { rel: 'textures/oak_log.png', fallback: '#4a3020' },
    { rel: 'textures/items/old texters/oak_log_top.png', fallback: '#c4a574' },
    { rel: 'textures/oak_planks.png', fallback: '#9c7349' },
    { rel: 'textures/oak_leaves.png', fallback: '#2d6b28' },
    { rel: 'textures/water_still.png', fallback: '#1a5a9e' },
    { rel: 'textures/items/old texters/coal_ore.png', fallback: '#2a2a2a' },
    { rel: 'textures/items/old texters/iron_ore.png', fallback: '#8a7a72' },
    { rel: 'textures/items/old texters/gold_ore.png', fallback: '#c9a227' },
    { rel: 'textures/items/old texters/cactus_side.png', fallback: '#2a8a3a' },
    { rel: 'textures/items/old texters/cactus_top.png', fallback: '#1f6b2c' },
    { rel: 'textures/items/old texters/cactus_bottom.png', fallback: '#5a3d22' },
    { rel: 'textures/snow.png', fallback: '#e8eef5' },
];

/** Resolves when the atlas texture is ready. Game should wait for this before loading chunks. */
let _atlasReadyResolve = null;
const terrainAtlasReadyPromise = new Promise((resolve) => { _atlasReadyResolve = resolve; });

function buildTerrainAtlas() {
    const images = ATLAS_LAYERS.map(() => {
        const img = new Image();
        img.crossOrigin = '';
        return img;
    });
    let finished = 0;

    function tryBuild() {
        if (finished < ATLAS_LAYERS.length) return;

        const FALLBACK_W = 16;
        const FALLBACK_H = 16;
        let w = FALLBACK_W;
        let h = FALLBACK_H;
        for (const img of images) {
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                w = Math.max(w, img.naturalWidth);
                h = Math.max(h, img.naturalHeight);
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = w * ATLAS_TILE_COUNT;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;

        for (let i = 0; i < ATLAS_LAYERS.length; i++) {
            const img = images[i];
            const x = i * w;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, x, 0, w, h);
            } else {
                ctx.fillStyle = ATLAS_LAYERS[i].fallback;
                ctx.fillRect(x, 0, w, h);
            }
        }

        if (terrainAtlasTexture) terrainAtlasTexture.dispose();
        terrainAtlasTexture = new THREE.CanvasTexture(canvas);
        terrainAtlasTexture.magFilter = THREE.NearestFilter;
        terrainAtlasTexture.minFilter = THREE.NearestFilter;
        terrainAtlasTexture.wrapS = THREE.ClampToEdgeWrapping;
        terrainAtlasTexture.wrapT = THREE.ClampToEdgeWrapping;
        if (_notifyAtlasReady) _notifyAtlasReady(terrainAtlasTexture);
        if (_atlasReadyResolve) {
            _atlasReadyResolve(terrainAtlasTexture);
            _atlasReadyResolve = null;
        }
    }

    ATLAS_LAYERS.forEach((layer, i) => {
        const img = images[i];
        const done = () => {
            finished++;
            tryBuild();
        };
        img.onload = done;
        img.onerror = done;
        img.src = ASSET_BASE + encodeURI(layer.rel);
    });
}
/** Set by createTerrain so we can apply the atlas to all chunk meshes when it loads. */
let _notifyAtlasReady = null;
buildTerrainAtlas();

export function createTerrain(scene, voxelSize = 1, chunkSize = 16, height = 32, mobSystem = null) {
    let waterPlacementHandler = null;
    let currentLeafTint = [0.2, 0.55, 0.2];
    let currentLeafSeason = 'spring';

    function getLeafTintForSeason(seasonName) {
        const s = String(seasonName || '').toLowerCase();
        if (s === 'summer') return [0.18, 0.62, 0.2];
        if (s === 'autumn') return [0.72, 0.44, 0.14];
        if (s === 'winter') return [0.58, 0.62, 0.56];
        return [0.2, 0.55, 0.2]; // spring/default
    }

    function remeshLoadedChunks() {
        for (const [key, oldMesh] of chunks.entries()) {
            const voxels = voxelData.get(key);
            if (!voxels) continue;
            const [cx, cz] = key.split(',').map(Number);
            scene.remove(oldMesh);
            disposeChunkMesh(oldMesh);
            const newMesh = createChunkMesh(voxels, cx, cz);
            scene.add(newMesh);
            chunks.set(key, newMesh);
        }
    }

    function setLeafSeason(seasonName) {
        const next = String(seasonName || 'spring').toLowerCase();
        if (next === currentLeafSeason) return false;
        currentLeafSeason = next;
        currentLeafTint = getLeafTintForSeason(next);
        remeshLoadedChunks();
        return true;
    }

    // Returns the highest solid voxel Y at world X/Z
    function getSurfaceYAt(worldX, worldZ) {
        const vx = Math.floor(worldX);
        const vz = Math.floor(worldZ);
        const cx = Math.floor(vx / chunkSize);
        const cz = Math.floor(vz / chunkSize);
        const key = getChunkKey(cx, cz);
        let voxels = voxelData.get(key);
        if (!voxels) {
            generateChunk(cx, cz);
            voxels = voxelData.get(key);
            if (!voxels) return 0;
        }
        const lx = ((vx % chunkSize) + chunkSize) % chunkSize;
        const lz = ((vz % chunkSize) + chunkSize) % chunkSize;
        // Scan from top down
        for (let y = height - 1; y >= 0; y--) {
            const t = voxels[lx][y][lz];
            if (t === 0) continue;
            if (isWater(t)) continue;
            return y;
        }
        return 0;
    }

    // Highest solid block that is walkable (not leaves), so mobs/entities stand on ground or trunk, not on top of leaves.
    function getWalkableSurfaceYAt(worldX, worldZ) {
        const vx = Math.floor(worldX);
        const vz = Math.floor(worldZ);
        const cx = Math.floor(vx / chunkSize);
        const cz = Math.floor(vz / chunkSize);
        const key = getChunkKey(cx, cz);
        let voxels = voxelData.get(key);
        if (!voxels) {
            generateChunk(cx, cz);
            voxels = voxelData.get(key);
            if (!voxels) return 0;
        }
        const lx = ((vx % chunkSize) + chunkSize) % chunkSize;
        const lz = ((vz % chunkSize) + chunkSize) % chunkSize;
        for (let y = height - 1; y >= 0; y--) {
            const type = voxels[lx][y][lz];
            if (type === 0 || isWater(type)) continue;
            if (type === BLOCK_IDS.LEAVES) continue;
            return y;
        }
        return 0;
    }

    // Shared noise instance for terrain; lives in a separate module so
    // future terrain features (hills, mountains, rivers, oceans) can
    // reuse the same noise source without touching chunk/mesh code.
    const noise = worldHeightNoise;
    const chunks = new Map();
    const voxelData = new Map();
    let _renderDistance = 2;

    function setRenderDistance(value) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return;
        _renderDistance = Math.max(1, Math.min(16, n));
    }

    function getRenderDistance() {
        return _renderDistance;
    }

    function getChunkKey(cx, cz) {
        return `${cx},${cz}`;
    }

    // 🌍 Terrain Generation
    function generateVoxelType(wx, y, wz, baseHeightIn, biomeInfoIn) {
        // 🌄 Base surface height (rolling hills)
        const baseHeight = (baseHeightIn != null) ? baseHeightIn : computeBaseHeight(wx, wz);

        // 🗺 Biome for this column (plains/desert/swamp/ocean/river) plus a
        // smooth desertBlend factor so we can ease from plains → desert.
        // All Y values in this (wx, wz) column share the same biome.
        const biomeInfo = biomeInfoIn || getBiomeInfoAt(wx, wz, baseHeight);
        const biome = biomeInfo.biome;
        const { snowLineY, alpineStoneLine } = LAYERED_SURFACE_THRESHOLDS;
        const dirtDepth =
            biome === BIOMES.MOUNTAINS ? 2 : biome === BIOMES.FOREST ? 4 : 3;

        // 🕳 Underground cave system (higher frequency, smaller amplitude)
        const caveNoise = noise.noise3D(wx * 0.04, y * 0.04, wz * 0.04);

        // 🚪 Entrance control noise (low frequency)
        const entranceNoise = noise.noise2D(wx * 0.01 + 1000, wz * 0.01 + 1000);

        // Ocean columns: seabed then water from surface up to SEA_LEVEL (same constant as biomes + water modules).
        if (biome === BIOMES.OCEAN) {
            if (y > baseHeight) {
                // Keep top water voxel at SEA_LEVEL - 1 so visible surface is flush at SEA_LEVEL.
                if (y <= SEA_LEVEL - 1) return BLOCK_IDS.WATER_LEVEL_0;
                return BLOCK_IDS.AIR;
            }
        }

        // Land: air above surface (cactus handled above).
        if (y > baseHeight) return BLOCK_IDS.AIR;

        if (y === baseHeight) {
            if (biome === BIOMES.OCEAN) return BLOCK_IDS.SAND;
            if (biome === BIOMES.MOUNTAINS) {
                if (baseHeight >= snowLineY) return BLOCK_IDS.SNOW;
                if (baseHeight >= alpineStoneLine) return BLOCK_IDS.STONE;
                return BLOCK_IDS.GRASS;
            }
            return BLOCK_IDS.GRASS;
        }

        if (y < baseHeight && y >= baseHeight - 3 && biome === BIOMES.OCEAN) {
            return BLOCK_IDS.SAND;
        }
        if (y < baseHeight && y >= baseHeight - dirtDepth) {
            return BLOCK_IDS.DIRT;
        }

        // Default underground stone
        let blockType = BLOCK_IDS.STONE;


        // --- Deep cave carving ---
        const caveThreshold = 0.6;
        const caveStartDepth = baseHeight - 8;

        if (y < caveStartDepth && caveNoise > caveThreshold) {
            blockType = BLOCK_IDS.AIR;
        }

        // --- Controlled cave entrances ---
        const nearSurface = y >= baseHeight - 2;

        if (nearSurface && caveNoise > 0.7 && entranceNoise > 0.6) {
            blockType = BLOCK_IDS.AIR;
        }

        // --- Ores (only in stone, underground) ---
        if (blockType === BLOCK_IDS.STONE) {
            const coalNoise = noise.noise3D(wx * 0.06 + 100, y * 0.06, wz * 0.06);
            const ironNoise = noise.noise3D(wx * 0.05 + 200, y * 0.05, wz * 0.05);
            if (y < baseHeight - 3 && coalNoise > 0.62) {
                blockType = BLOCK_IDS.COAL_ORE;
            } else if (y < baseHeight - 6 && ironNoise > 0.72) {
                blockType = BLOCK_IDS.IRON_ORE;
            }
        }

        return blockType;
    }

    function generateChunk(cx, cz) {

        const key = getChunkKey(cx, cz);
        if (chunks.has(key)) return;

        let voxels;

        if (voxelData.has(key)) {
            voxels = voxelData.get(key);
        } else {
            voxels = Array.from({ length: chunkSize }, () =>
                Array.from({ length: height }, () =>
                    Array(chunkSize).fill(0)
                )
            );

            for (let x = 0; x < chunkSize; x++) {
                for (let z = 0; z < chunkSize; z++) {
                    const wx = cx * chunkSize + x;
                    const wz = cz * chunkSize + z;
                    const baseHeight = computeBaseHeight(wx, wz);
                    const biomeInfo = getBiomeInfoAt(wx, wz, baseHeight);
                    for (let y = 0; y < height; y++) {
                        voxels[x][y][z] = generateVoxelType(wx, y, wz, baseHeight, biomeInfo);
                    }
                }
            }

            voxelData.set(key, voxels);
        }

        const mesh = createChunkMesh(voxels, cx, cz);
        scene.add(mesh);
        chunks.set(key, mesh);
        // Fix stale border faces: neighbors may have been meshed before this chunk existed.
        rebuildChunkMesh(cx - 1, cz);
        rebuildChunkMesh(cx + 1, cz);
        rebuildChunkMesh(cx, cz - 1);
        rebuildChunkMesh(cx, cz + 1);

        // Notify mob system if present
        if (mobSystem && typeof mobSystem.onChunkLoad === 'function') {
            mobSystem.onChunkLoad(cx, cz);
        }
    }

    // Opaque terrain; water uses a separate mesh so it can be translucent without tinting the whole chunk.
    const sharedChunkMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        map: terrainAtlasTexture || null,
        transparent: false,
    });

    // Water top material: dedicated repeating texture so greedy-meshed quads do not stretch UVs.
    const waterTileTexture = new THREE.TextureLoader().load(
        ASSET_BASE + encodeURI('textures/water_still.png')
    );
    waterTileTexture.wrapS = THREE.RepeatWrapping;
    waterTileTexture.wrapT = THREE.RepeatWrapping;
    waterTileTexture.magFilter = THREE.NearestFilter;
    waterTileTexture.minFilter = THREE.NearestFilter;

    const sharedWaterTopMaterial = new THREE.MeshBasicMaterial({
        vertexColors: false,
        map: waterTileTexture,
        transparent: true,
        opacity: 0.78,
        depthWrite: true,
        toneMapped: true,
    });

    // Water side material: stays on atlas for side faces.
    const sharedWaterSideMaterial = new THREE.MeshBasicMaterial({
        vertexColors: false,
        map: terrainAtlasTexture || null,
        transparent: true,
        opacity: 0.78,
        depthWrite: true,
        toneMapped: true,
    });

    function disposeChunkMesh(root) {
        if (!root) return;
        root.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
        });
    }

    /** Solids draw toward air or water so seabed remains visible where water exists. */
    function shouldEmitFace(blockType, neighborType) {
        if (!blockType) return false;
        if (isWater(blockType)) return false;
        return neighborType === BLOCK_IDS.AIR || isWater(neighborType);
    }

    function unloadChunk(cx, cz) {
        const key = getChunkKey(cx, cz);
        const mesh = chunks.get(key);
        if (!mesh) return;

        scene.remove(mesh);
        disposeChunkMesh(mesh);
        // Do not dispose materials — shared across all chunks
        chunks.delete(key);
        // Mob/chest/campfire/particles are notified by the wrapper in renderer.js
    }

    function rebuildChunkMesh(cx, cz) {
        const key = getChunkKey(cx, cz);
        const voxels = voxelData.get(key);
        if (!voxels || !chunks.has(key)) return;
        const oldMesh = chunks.get(key);
        if (oldMesh) {
            scene.remove(oldMesh);
            disposeChunkMesh(oldMesh);
        }
        const newMesh = createChunkMesh(voxels, cx, cz);
        scene.add(newMesh);
        chunks.set(key, newMesh);
    }

    function rebuildNeighborChunksIfBoundary(lx, lz, cx, cz) {
        if (lx === 0) rebuildChunkMesh(cx - 1, cz);
        else if (lx === chunkSize - 1) rebuildChunkMesh(cx + 1, cz);
        if (lz === 0) rebuildChunkMesh(cx, cz - 1);
        else if (lz === chunkSize - 1) rebuildChunkMesh(cx, cz + 1);
    }

    // 🔥 Face-culling mesh generator
    function createChunkMesh(voxels, cx, cz) {
        const MAX_WATER_LEVEL = BLOCK_IDS.WATER_LEVEL_6 - BLOCK_IDS.WATER_LEVEL_0;
        function waterFillRatio(type) {
            const lvl = waterLevel(type);
            if (lvl == null) return 1;
            // level 0 = full block, level 6 = thinnest sheet.
            return (MAX_WATER_LEVEL + 1 - lvl) / (MAX_WATER_LEVEL + 1);
        }
        // dir: 0=right,1=left,2=top,3=bottom,4=front,5=back
        function getAtlasTile(type, dir) {
            if (isWater(type)) return ATLAS.WATER;

            if (type === BLOCK_IDS.DIRT) return ATLAS.DIRT;

            if (type === BLOCK_IDS.SAND) return ATLAS.SAND;

            if (type === BLOCK_IDS.STONE) return ATLAS.STONE;

            if (type === BLOCK_IDS.COAL_ORE) return ATLAS.COAL_ORE;
            if (type === BLOCK_IDS.IRON_ORE) return ATLAS.IRON_ORE;
            if (type === BLOCK_IDS.GOLD_ORE) return ATLAS.GOLD_ORE;

            if (type === BLOCK_IDS.CACTUS) {
                if (dir === 2) return ATLAS.CACTUS_TOP;
                if (dir === 3) return ATLAS.CACTUS_BOTTOM;
                return ATLAS.CACTUS_SIDE;
            }

            // Grass block: bottom = dirt, top = grass_top, sides = grass_side
            if (type === BLOCK_IDS.GRASS) {
                if (dir === 3) return ATLAS.DIRT;
                if (dir === 2) return ATLAS.GRASS_TOP;
                return ATLAS.GRASS_SIDE;
            }

            if (type === BLOCK_IDS.LOG) {
                if (dir === 2 || dir === 3) return ATLAS.OAK_LOG_TOP;
                return ATLAS.OAK_LOG;
            }

            if (type === BLOCK_IDS.PLANKS) return ATLAS.OAK_PLANKS;
            if (type === BLOCK_IDS.LEAVES) return ATLAS.OAK_LEAVES;

            if (type === BLOCK_IDS.SNOW) return ATLAS.SNOW;

            return ATLAS.DIRT;
        }
        // Quad UVs for one face: order matches indices [0,1,2, 2,3,0].
        // For grass side tile we rotate/mirror per face so the \"top\" of the
        // texture is always at the top of the block, on all four sides.
        function getFaceUVs(tile, dir) {
            const u0 = tile * ATLAS_TILE_U;
            const u1 = u0 + ATLAS_TILE_U;
            let uv4 = [
                [u0, 0], [u1, 0], [u1, 1], [u0, 1] // 0: bottom-left, 1: bottom-right, 2: top-right, 3: top-left
            ];
            // For non-grass-side tiles we just use this base
            // orientation, optionally mirrored for the north face to keep things consistent.
            if (tile !== ATLAS.GRASS_SIDE) {
                if (dir === 5) {
                    // back / north: mirror left/right
                    uv4 = [uv4[1], uv4[0], uv4[3], uv4[2]];
                }
            }
            // Expand 4-corner quad UVs to 6 vertices (two triangles)
            return [
                ...uv4[0], ...uv4[1], ...uv4[2],
                ...uv4[2], ...uv4[3], ...uv4[0]
            ];
        }

        function addFace(positions, colors, uvs, wx, wy, wz, voxelSize, dir, type) {
            const faceVertices = [
                [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]],
                [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]],
                [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]],
                [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]],
                [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
                [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]
            ];
            const verts = faceVertices[dir];
            const indices = [0, 1, 2, 2, 3, 0];

            const tile = getAtlasTile(type, dir);
            const u0 = tile * ATLAS_TILE_U;
            const u1 = u0 + ATLAS_TILE_U;
            const faceUVs = getFaceUVs(tile, dir);

            let color = [0.5, 0.5, 0.5];
            if (type === BLOCK_IDS.DIRT)   color = [0.55, 0.27, 0.07];
            if (type === BLOCK_IDS.GRASS)  color = [0.2, 0.8, 0.2];
            if (type === BLOCK_IDS.PLANKS) color = [0.7, 0.55, 0.35];
            if (type === BLOCK_IDS.LEAVES) color = currentLeafTint;
            if (type === BLOCK_IDS.SAND)   color = [0.95, 0.9, 0.4];
            if (type === BLOCK_IDS.CACTUS) color = [0.25, 0.8, 0.25];
            if (type === BLOCK_IDS.SNOW) color = [0.92, 0.95, 1.0];
            const useTexture = !!terrainAtlasTexture;
            indices.forEach((i, idx) => {
                const v = verts[i];
                positions.push(wx + v[0] * voxelSize, wy + v[1] * voxelSize, wz + v[2] * voxelSize);
                // When using textures, we normally leave vertex colors white so
                // the atlas provides the final look. For placeholder blocks
                // (sand/cactus) that don't have their own tiles yet, we still
                // apply a tint so they stand out.
                let finalColor;
                if (useTexture) {
                    // Keep texture detail, but allow seasonal tinting for leaves.
                    finalColor = (type === BLOCK_IDS.LEAVES) ? color : [1, 1, 1];
                } else {
                    finalColor = color;
                }
                colors.push(...finalColor);
                if (tile === ATLAS.GRASS_SIDE && (dir === 0 || dir === 1 || dir === 4 || dir === 5)) {
                    // Grass side: compute UVs from the actual vertex position so that
                    // the top of the texture (v=1) always maps to the top edge (y > 0),
                    // on all four horizontal faces.
                    const localX = v[0];
                    const localY = v[1];
                    const localZ = v[2];

                    // vTex: 0 at bottom (y = -0.5), 1 at top (y = +0.5)
                    const vNorm = (localY + 0.5); // 0..1
                    const vTex = vNorm; // already 0..1

                    // uTex: run 0..1 across the width of each side, with a consistent facing:
                    let uNorm;
                    if (dir === 0) { // east / right: use z increasing frontwards
                        uNorm = (localZ + 0.5); // back (-0.5) -> 0, front (+0.5) -> 1
                    } else if (dir === 1) { // west / left: reverse z so pattern isn't mirrored oddly
                        uNorm = 1 - (localZ + 0.5);
                    } else if (dir === 4) { // south / front: use x left->right
                        uNorm = (localX + 0.5);
                    } else { // dir === 5, north / back: reverse x
                        uNorm = 1 - (localX + 0.5);
                    }
                    const uTex = u0 + uNorm * (u1 - u0);
                    uvs.push(uTex, vTex);
                } else {
                    uvs.push(faceUVs[idx * 2], faceUVs[idx * 2 + 1]);
                }
            });
        }

        function addWaterTopQuad(positions, colors, uvs, x0, x1, z0, z1, y, fillRatio) {
            const yTop = y * voxelSize + voxelSize * fillRatio;
            const wx0 = (cx * chunkSize + x0) * voxelSize;
            const wx1 = (cx * chunkSize + x1) * voxelSize;
            const wz0 = (cz * chunkSize + z0) * voxelSize;
            const wz1 = (cz * chunkSize + z1) * voxelSize;
            const gx0 = cx * chunkSize + x0;
            const gx1 = cx * chunkSize + x1;
            const gz0 = cz * chunkSize + z0;
            const gz1 = cz * chunkSize + z1;

            // Top face (two triangles)
            positions.push(
                wx0, yTop, wz0,
                wx0, yTop, wz1,
                wx1, yTop, wz1,
                wx1, yTop, wz1,
                wx1, yTop, wz0,
                wx0, yTop, wz0,
            );

            for (let i = 0; i < 6; i++) colors.push(1, 1, 1);
            uvs.push(
                gx0, gz0,
                gx0, gz1,
                gx1, gz1,
                gx1, gz1,
                gx1, gz0,
                gx0, gz0,
            );
        }

        function addWaterSideQuad(positions, colors, uvs, wx, wy, wz, voxelSize, dir, fillTopRatio, fillBottomRatio = 0) {
            const x0 = wx - voxelSize * 0.5;
            const x1 = wx + voxelSize * 0.5;
            const z0 = wz - voxelSize * 0.5;
            const z1 = wz + voxelSize * 0.5;
            const yBottom = wy - voxelSize * 0.5;
            const clampedBottom = Math.max(0, Math.min(1, fillBottomRatio));
            const clampedTop = Math.max(clampedBottom, Math.min(1, fillTopRatio));
            const yStart = yBottom + voxelSize * clampedBottom;
            const yTop = yBottom + voxelSize * clampedTop;
            if (yTop <= yStart + 1e-6) return;

            let quad = null;
            // 0=right(+X),1=left(-X),4=front(+Z),5=back(-Z)
            if (dir === 0) quad = [[x1, yStart, z0], [x1, yTop, z0], [x1, yTop, z1], [x1, yStart, z1]];
            else if (dir === 1) quad = [[x0, yStart, z1], [x0, yTop, z1], [x0, yTop, z0], [x0, yStart, z0]];
            else if (dir === 4) quad = [[x0, yStart, z1], [x1, yStart, z1], [x1, yTop, z1], [x0, yTop, z1]];
            else if (dir === 5) quad = [[x1, yStart, z0], [x0, yStart, z0], [x0, yTop, z0], [x1, yTop, z0]];
            if (!quad) return;

            const tile = ATLAS.WATER;
            const u0 = tile * ATLAS_TILE_U;
            const u1 = u0 + ATLAS_TILE_U;
            const indices = [0, 1, 2, 2, 3, 0];
            // Keep side texture scale consistent for shallow layers (no vertical squash).
            // We clip geometry height, but keep full-tile UV span like Minecraft-style water sheets.
            const uv4 = [[u0, 0], [u1, 0], [u1, 1], [u0, 1]];

            for (let i = 0; i < 6; i++) {
                const v = quad[indices[i]];
                positions.push(v[0], v[1], v[2]);
                colors.push(1, 1, 1);
                uvs.push(uv4[indices[i]][0], uv4[indices[i]][1]);
            }
        }
        const directions = [
            [ 1, 0, 0], // right
            [-1, 0, 0], // left
            [ 0, 1, 0], // top
            [ 0,-1, 0], // bottom
            [ 0, 0, 1], // front
            [ 0, 0,-1], // back
        ];

        function neighborTypeAt(lx, ly, lz, d) {
            const nx = lx + directions[d][0];
            const ny = ly + directions[d][1];
            const nz = lz + directions[d][2];
            if (nx >= 0 && nx < chunkSize && ny >= 0 && ny < height && nz >= 0 && nz < chunkSize) {
                return voxels[nx][ny][nz] || 0;
            }
            const wwx = cx * chunkSize + nx;
            const wwz = cz * chunkSize + nz;
            return getVoxelAt(wwx, ny, wwz);
        }

        const opaquePositions = [];
        const opaqueColors = [];
        const opaqueUvs = [];
        const waterTopPositions = [];
        const waterTopColors = [];
        const waterTopUvs = [];
        const waterSidePositions = [];
        const waterSideColors = [];
        const waterSideUvs = [];

        for (let x = 0; x < chunkSize; x++) {
            for (let y = 0; y < height; y++) {
                for (let z = 0; z < chunkSize; z++) {
                    const type = voxels[x][y][z];
                    if (!type || isWater(type)) continue;
                    for (let d = 0; d < 6; d++) {
                        const neighbor = neighborTypeAt(x, y, z, d);
                        if (!shouldEmitFace(type, neighbor)) continue;
                        const wx = (cx * chunkSize + x) * voxelSize + voxelSize / 2;
                        const wy = y * voxelSize + voxelSize / 2;
                        const wz = (cz * chunkSize + z) * voxelSize + voxelSize / 2;
                        addFace(opaquePositions, opaqueColors, opaqueUvs, wx, wy, wz, voxelSize, d, type);
                    }
                }
            }
        }

        // Water surface pass (top faces only) with greedy meshing by Y-slice.
        for (let y = 0; y < height; y++) {
            const mask = Array.from({ length: chunkSize }, () => Array(chunkSize).fill(false));
            const levelMap = Array.from({ length: chunkSize }, () => Array(chunkSize).fill(-1));
            for (let x = 0; x < chunkSize; x++) {
                for (let z = 0; z < chunkSize; z++) {
                    const t = voxels[x][y][z];
                    if (!isWater(t)) continue;
                    levelMap[x][z] = waterLevel(t) ?? 0;
                    const above = y + 1 < height
                        ? (voxels[x][y + 1][z] || 0)
                        : getVoxelAt(cx * chunkSize + x, y + 1, cz * chunkSize + z);
                    if (above === BLOCK_IDS.AIR) mask[x][z] = true;
                }
            }

            const used = Array.from({ length: chunkSize }, () => Array(chunkSize).fill(false));
            for (let x0 = 0; x0 < chunkSize; x0++) {
                for (let z0 = 0; z0 < chunkSize; z0++) {
                    if (!mask[x0][z0] || used[x0][z0]) continue;
                    const levelHere = levelMap[x0][z0];

                    let x1 = x0 + 1;
                    while (
                        x1 < chunkSize &&
                        mask[x1][z0] &&
                        !used[x1][z0] &&
                        levelMap[x1][z0] === levelHere
                    ) x1++;

                    let z1 = z0 + 1;
                    let canGrow = true;
                    while (z1 < chunkSize && canGrow) {
                        for (let xx = x0; xx < x1; xx++) {
                            if (!mask[xx][z1] || used[xx][z1] || levelMap[xx][z1] !== levelHere) {
                                canGrow = false;
                                break;
                            }
                        }
                        if (canGrow) z1++;
                    }

                    for (let xx = x0; xx < x1; xx++) {
                        for (let zz = z0; zz < z1; zz++) used[xx][zz] = true;
                    }
                    addWaterTopQuad(
                        waterTopPositions,
                        waterTopColors,
                        waterTopUvs,
                        x0,
                        x1,
                        z0,
                        z1,
                        y,
                        waterFillRatio(BLOCK_IDS.WATER_LEVEL_0 + levelHere)
                    );
                }
            }
        }

        // Water side walls: only where adjacent cell is air; skip bottoms.
        for (let x = 0; x < chunkSize; x++) {
            for (let y = 0; y < height; y++) {
                for (let z = 0; z < chunkSize; z++) {
                    const type = voxels[x][y][z];
                    if (!isWater(type)) continue;

                    for (const d of [0, 1, 4, 5]) {
                        const neighbor = neighborTypeAt(x, y, z, d);
                        const fillTop = waterFillRatio(type);
                        let fillBottom = 0;
                        if (neighbor === BLOCK_IDS.AIR) {
                            fillBottom = 0;
                        } else if (isWater(neighbor)) {
                            const nFill = waterFillRatio(neighbor);
                            if (nFill >= fillTop - 1e-6) continue; // no exposed side between equal/higher neighbor water
                            fillBottom = nFill;
                        } else {
                            continue;
                        }
                        const wx = (cx * chunkSize + x) * voxelSize + voxelSize / 2;
                        const wy = y * voxelSize + voxelSize / 2;
                        const wz = (cz * chunkSize + z) * voxelSize + voxelSize / 2;
                        addWaterSideQuad(
                            waterSidePositions,
                            waterSideColors,
                            waterSideUvs,
                            wx,
                            wy,
                            wz,
                            voxelSize,
                            d,
                            fillTop,
                            fillBottom
                        );
                    }
                }
            }
        }

        const group = new THREE.Group();
        group.name = `chunk_${cx}_${cz}`;

        const opaqueGeo = new THREE.BufferGeometry();
        opaqueGeo.setAttribute('position', new THREE.Float32BufferAttribute(opaquePositions, 3));
        opaqueGeo.setAttribute('color', new THREE.Float32BufferAttribute(opaqueColors, 3));
        if (opaqueUvs.length > 0) opaqueGeo.setAttribute('uv', new THREE.Float32BufferAttribute(opaqueUvs, 2));
        opaqueGeo.computeVertexNormals();
        opaqueGeo.computeBoundingSphere();

        const opaqueMesh = new THREE.Mesh(opaqueGeo, sharedChunkMaterial);
        opaqueMesh.receiveShadow = true;
        opaqueMesh.castShadow = false;
        group.add(opaqueMesh);

        if (waterTopPositions.length > 0) {
            const waterTopGeo = new THREE.BufferGeometry();
            waterTopGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterTopPositions, 3));
            waterTopGeo.setAttribute('color', new THREE.Float32BufferAttribute(waterTopColors, 3));
            if (waterTopUvs.length > 0) waterTopGeo.setAttribute('uv', new THREE.Float32BufferAttribute(waterTopUvs, 2));
            waterTopGeo.computeBoundingSphere();

            const waterTopMesh = new THREE.Mesh(waterTopGeo, sharedWaterTopMaterial);
            waterTopMesh.receiveShadow = false;
            waterTopMesh.castShadow = false;
            waterTopMesh.renderOrder = 1;
            group.add(waterTopMesh);
        }

        if (waterSidePositions.length > 0) {
            const waterSideGeo = new THREE.BufferGeometry();
            waterSideGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterSidePositions, 3));
            waterSideGeo.setAttribute('color', new THREE.Float32BufferAttribute(waterSideColors, 3));
            if (waterSideUvs.length > 0) waterSideGeo.setAttribute('uv', new THREE.Float32BufferAttribute(waterSideUvs, 2));
            waterSideGeo.computeBoundingSphere();

            const waterSideMesh = new THREE.Mesh(waterSideGeo, sharedWaterSideMaterial);
            waterSideMesh.receiveShadow = false;
            waterSideMesh.castShadow = false;
            waterSideMesh.renderOrder = 1;
            group.add(waterSideMesh);
        }

        return group;
    }

    // Collision lookup
    function getVoxelAt(worldX, worldY, worldZ) {

        const vx = Math.floor(worldX);
        const vy = Math.floor(worldY);
        const vz = Math.floor(worldZ);

        const cx = Math.floor(vx / chunkSize);
        const cz = Math.floor(vz / chunkSize);

        const key = getChunkKey(cx, cz);
        const chunk = voxelData.get(key);
        if (!chunk) return 0;

        const lx = ((vx % chunkSize) + chunkSize) % chunkSize;
        const lz = ((vz % chunkSize) + chunkSize) % chunkSize;

        if (
            vy < 0 ||
            vy >= height ||
            lx < 0 || lx >= chunkSize ||
            lz < 0 || lz >= chunkSize
        ) return 0;

        return chunk[lx][vy][lz] || 0;
    }

    // Progressive chunk loading: load only a few chunks per frame to avoid memory spikes (Minecraft-style)
    const MAX_CHUNKS_TO_LOAD_PER_FRAME = 4;

    function updateChunks(playerX, playerZ) {
        const cx = Math.floor(playerX / chunkSize);
        const cz = Math.floor(playerZ / chunkSize);

        // 1. Unload first to free memory before loading new chunks
        for (const key of Array.from(chunks.keys())) {
            const [x, z] = key.split(',').map(Number);
            if (
                Math.abs(x - cx) > _renderDistance ||
                Math.abs(z - cz) > _renderDistance
            ) {
                this.unloadChunk(x, z);
            }
        }

        // 2. Collect chunks that should be loaded but aren't yet
        const pending = [];
        for (let dx = -_renderDistance; dx <= _renderDistance; dx++) {
            for (let dz = -_renderDistance; dz <= _renderDistance; dz++) {
                const nx = cx + dx;
                const nz = cz + dz;
                const key = getChunkKey(nx, nz);
                if (!chunks.has(key)) pending.push([nx, nz]);
            }
        }

        // 3. Load closest chunks first; only a few per frame to avoid OOM
        if (pending.length > 0) {
            pending.sort((a, b) => {
                const da = (a[0] - cx) ** 2 + (a[1] - cz) ** 2;
                const db = (b[0] - cx) ** 2 + (b[1] - cz) ** 2;
                return da - db;
            });
            const toLoad = Math.min(MAX_CHUNKS_TO_LOAD_PER_FRAME, pending.length);
            for (let i = 0; i < toLoad; i++) {
                generateChunk(pending[i][0], pending[i][1]);
            }
        }
    }

    // --- Remove voxel (mining / shooting) ---
    function removeVoxel(worldX, worldY, worldZ) {
        const vx = Math.floor(worldX);
        const vy = Math.floor(worldY);
        const vz = Math.floor(worldZ);

        const cx = Math.floor(vx / chunkSize);
        const cz = Math.floor(vz / chunkSize);
        const key = getChunkKey(cx, cz);
        const voxels = voxelData.get(key);
        if (!voxels) return 0;

        const lx = ((vx % chunkSize) + chunkSize) % chunkSize;
        const lz = ((vz % chunkSize) + chunkSize) % chunkSize;

        if (vy < 0 || vy >= height) return 0;

        const prev = voxels[lx][vy][lz] || 0;
        voxels[lx][vy][lz] = 0;

        // We intentionally leave blocks above in place; only dynamic entities
        // (player, mobs, item drops) fall when their supporting block is removed.

        // rebuild mesh for this chunk
        rebuildChunkMesh(cx, cz);
        rebuildNeighborChunksIfBoundary(lx, lz, cx, cz);
        return prev;
    }

    // --- Set voxel (placing blocks) ---
    function setVoxel(worldX, worldY, worldZ, type) {
        const vx = Math.floor(worldX);
        const vy = Math.floor(worldY);
        const vz = Math.floor(worldZ);

        if (vy < 0 || vy >= height) return false;

        const cx = Math.floor(vx / chunkSize);
        const cz = Math.floor(vz / chunkSize);
        const key = getChunkKey(cx, cz);
        let voxels = voxelData.get(key);

        if (!voxels) {
            // Generate chunk if it doesn't exist yet
            generateChunk(cx, cz);
            voxels = voxelData.get(key);
            if (!voxels) return false;
        }

        const lx = ((vx % chunkSize) + chunkSize) % chunkSize;
        const lz = ((vz % chunkSize) + chunkSize) % chunkSize;

        voxels[lx][vy][lz] = type;

        rebuildChunkMesh(cx, cz);
        rebuildNeighborChunksIfBoundary(lx, lz, cx, cz);
        if (isWater(type) && typeof waterPlacementHandler === 'function') {
            waterPlacementHandler(vx, vy, vz, type);
        }

        return true;
    }

    // When the texture atlas loads (async), apply it to the shared terrain materials.
    function applyAtlasToAllChunks(tex) {
        if (sharedChunkMaterial.map !== tex) {
            sharedChunkMaterial.map = tex;
            sharedChunkMaterial.needsUpdate = true;
        }
        if (sharedWaterSideMaterial.map !== tex) {
            sharedWaterSideMaterial.map = tex;
            sharedWaterSideMaterial.needsUpdate = true;
        }
    }
    _notifyAtlasReady = applyAtlasToAllChunks;
    if (terrainAtlasTexture) applyAtlasToAllChunks(terrainAtlasTexture);

    return {
        generateChunk,
        unloadChunk,
        updateChunks,
        getVoxelAt,
        getVoxelData: () => voxelData,
        removeVoxel,
        setVoxel,
        chunks,

        // Expose internal config values used elsewhere in the codebase
        voxelSize,
        chunkSize,
        height,
        get renderDistance() { return _renderDistance; },
        setRenderDistance,
        getRenderDistance,

        // Utility: expose chunk key helper for callers that need it
        getChunkKey,
        getSurfaceYAt,
        getWalkableSurfaceYAt,
        setLeafSeason,
        setWaterPlacementHandler: (fn) => {
            waterPlacementHandler = (typeof fn === 'function') ? fn : null;
        },

        /** Promise that resolves when the terrain texture atlas has loaded. Wait for this before starting the game so first chunks have textures. */
        getAtlasReadyPromise: () => terrainAtlasReadyPromise,

        /** Terrain atlas texture. For block drop entities. */
        getTerrainAtlasTexture: () => terrainAtlasTexture,

        getAtlasTileU: () => ATLAS_TILE_U,

        /**
         * Per-face atlas tiles for drop cubes (Three.js BoxGeometry order: +X, -X, +Y, -Y, +Z, -Z).
         * When non-null, overrides getBlockDropTile for UV assignment.
         */
        getBlockDropFaceTiles(blockType) {
            if (blockType === BLOCK_IDS.GRASS) {
                return [
                    ATLAS.GRASS_SIDE, ATLAS.GRASS_SIDE,
                    ATLAS.GRASS_TOP, ATLAS.DIRT,
                    ATLAS.GRASS_SIDE, ATLAS.GRASS_SIDE,
                ];
            }
            if (blockType === BLOCK_IDS.LOG) {
                return [
                    ATLAS.OAK_LOG, ATLAS.OAK_LOG,
                    ATLAS.OAK_LOG_TOP, ATLAS.OAK_LOG_TOP,
                    ATLAS.OAK_LOG, ATLAS.OAK_LOG,
                ];
            }
            if (blockType === BLOCK_IDS.CACTUS) {
                return [
                    ATLAS.CACTUS_SIDE, ATLAS.CACTUS_SIDE,
                    ATLAS.CACTUS_TOP, ATLAS.CACTUS_BOTTOM,
                    ATLAS.CACTUS_SIDE, ATLAS.CACTUS_SIDE,
                ];
            }
            return null;
        },

        /** Single atlas tile for uniform drop cubes (grass/log/cactus use getBlockDropFaceTiles). */
        getBlockDropTile(blockType) {
            if (blockType === BLOCK_IDS.GRASS || blockType === BLOCK_IDS.LOG || blockType === BLOCK_IDS.CACTUS) return null;
            if (blockType === BLOCK_IDS.DIRT) return ATLAS.DIRT;
            if (blockType === BLOCK_IDS.STONE) return ATLAS.STONE;
            if (blockType === BLOCK_IDS.SAND) return ATLAS.SAND;
            if (blockType === BLOCK_IDS.PLANKS) return ATLAS.OAK_PLANKS;
            if (blockType === BLOCK_IDS.LEAVES) return ATLAS.OAK_LEAVES;
            if (blockType === BLOCK_IDS.COAL_ORE) return ATLAS.COAL_ORE;
            if (blockType === BLOCK_IDS.IRON_ORE) return ATLAS.IRON_ORE;
            if (blockType === BLOCK_IDS.GOLD_ORE) return ATLAS.GOLD_ORE;
            if (blockType === BLOCK_IDS.SNOW) return ATLAS.SNOW;
            if (isWater(blockType)) return ATLAS.WATER;
            return ATLAS.DIRT;
        },
    };
}
