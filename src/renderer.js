let selectedHotbar = 0; // Declare before any usage
let backpackOpen = false; // Declare before any usage
let gamePaused = false; // Game pause state
if (typeof window !== 'undefined') window.getGamePaused = () => gamePaused;
let referenceOverlayOpen = false; // F1 reference / help overlay
let performanceOverlayOpen = false; // F3 performance / debug overlay
let settingsOverlayOpen = false; // Settings UI (opened from pause menu)
let saveLoadOverlayOpen = false;  // Save/Load UI (opened from pause menu)
let fpsSmoothed = 60;
let chunkOutlinesGroup = null; // THREE.Group for chunk boundary lines when F3 is on
let _chunkFrustum = null;      // reused for frustum culling of chunk meshes
let _chunkProjScreenMatrix = null;
const canvas = document.getElementById('gameCanvas');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingStatusEl = document.getElementById('loadingStatus');
const loadingBarFillEl = document.getElementById('loadingBarFill');

let loadingStep = 0;
const LOADING_STEPS_TOTAL = 4; // rough phases: renderer, terrain, systems, spawn
let loadingDotsInterval = null;
let loadingBaseMessage = '';

function setLoadingStatus(message, stepIncrement = 0) {
    if (loadingStatusEl && typeof message === 'string') {
        loadingBaseMessage = message;
        loadingStatusEl.textContent = message;
    }
    if (loadingBarFillEl) {
        loadingStep = Math.min(LOADING_STEPS_TOTAL, loadingStep + stepIncrement);
        const pct = (loadingStep / LOADING_STEPS_TOTAL) * 100;
        loadingBarFillEl.style.width = `${pct}%`;
    }

    // Simple animated dots so the loading screen clearly looks alive
    if (loadingStatusEl && !loadingDotsInterval) {
        let dotCount = 0;
        loadingDotsInterval = setInterval(() => {
            if (!loadingStatusEl) return;
            dotCount = (dotCount + 1) % 4; // 0,1,2,3
            const dots = dotCount === 0 ? '' : '.'.repeat(dotCount);
            loadingStatusEl.textContent = `${loadingBaseMessage}${dots}`;
        }, 500);
    }
}

function showLoadingOverlay() {
    if (loadingDotsInterval) {
        clearInterval(loadingDotsInterval);
        loadingDotsInterval = null;
    }
    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
    }
    loadingStep = 0;
    if (loadingBarFillEl) {
        loadingBarFillEl.style.width = '0%';
    }
}

function hideLoadingOverlay() {
    if (loadingOverlay) {
        loadingOverlay.style.display = 'none';
    }
    if (loadingDotsInterval) {
        clearInterval(loadingDotsInterval);
        loadingDotsInterval = null;
    }
}

function showWebGLLostOverlay() {
    const el = document.getElementById('webglLostOverlay');
    if (el) {
        el.style.display = 'flex';
    }
}

let webglContextLost = false;
canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    webglContextLost = true;
    showWebGLLostOverlay();
}, false);

let webglUnavailable = false;
setLoadingStatus('Initializing renderer…', 1);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.localClippingEnabled = true; // Required for material.clippingPlanes (near-block clipping)
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
if (!gl || (typeof gl.isContextLost === 'function' && gl.isContextLost())) {
    webglUnavailable = true;
    showWebGLLostOverlay();
} else {
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap = best quality, costliest. Use THREE.PCFShadowMap or THREE.BasicShadowMap for better FPS.
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

const scene = new THREE.Scene();
// Chunk dimensions: (voxelSize, chunkSize, height). Larger = more build space, heavier on CPU/GPU/memory.
// Default was 16×32×16; 32×64×32 = 8× voxels per chunk — tune here for performance vs playable area.
setLoadingStatus('Preparing terrain…', 1);
const terrain = createTerrain(scene, 1, 32, 64, null);
// Water system runs after terrain generation and post-processes voxel data
// to place rivers, lakes, oceans, waterfalls, and swamps in a modular way.
let waterSystem = createWaterSystem(scene, terrain);
let creativeMode = false;
if (typeof window !== 'undefined') {
    window.DEBUG_WATER_LEVEL_OFFSET = window.DEBUG_WATER_LEVEL_OFFSET || 0;
    window.isCreativeMode = () => creativeMode;
}
if (typeof window !== 'undefined') {
    window.DEBUG_WATER_LEVEL_OFFSET = window.DEBUG_WATER_LEVEL_OFFSET || 0;
}
// Apply saved render distance from settings (Minecraft-style view distance)
const savedRenderDistance = parseInt(localStorage.getItem('voxelShooter_renderDistance'), 10);
if (Number.isInteger(savedRenderDistance) && savedRenderDistance >= 1 && savedRenderDistance <= 16 && terrain.setRenderDistance) {
    terrain.setRenderDistance(savedRenderDistance);
}
/** Game does not run (no chunk loading, no movement) until terrain texture atlas has loaded and spawn is ready. */
let terrainAtlasReady = false;
// Warm-up time: game loop runs behind the loading screen so chunks, mobs, and physics settle for a smooth start.
const LOADING_SETTLE_MS = 2000;

terrain.getAtlasReadyPromise().then(async () => {
    setLoadingStatus('Loading terrain textures', 0);
    setLoadingStatus('Generating terrain around spawn', 0);
    await ensureSpawnChunksGenerated();
    setLoadingStatus('Finding safe spawn point', 0);
    runSpawnInit();
    setLoadingStatus('Warming up world', 1);
    terrainAtlasReady = true;
    // Keep loading screen up so the game loop can run (mobs, physics, systems) without visible lag or jerking.
    setTimeout(() => {
        hideLoadingOverlay();
        canvas.requestPointerLock().catch(() => {});
    }, LOADING_SETTLE_MS);
});

// Re-lock pointer when the app window gains focus (e.g. alt-tab back), like Minecraft
window.addEventListener('focus', () => {
    if (!terrainAtlasReady || gamePaused || backpackOpen || craftingOpen || openChest || openCampfire || openFurnace || openLoom || devConsoleOpen) return;
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock().catch(() => {});
});
// Mob system will be created after player is initialized
let mobSystem = null;
terrain.generateChunk = ((orig) => function(cx, cz) {
    orig.call(this, cx, cz);
    // When loading a save, voxel data already has trees; skip regenerating them
    if (!this._skipTreeGeneration) {
        generateTreesForChunk(this, cx, cz, 2);
    }
    if (this.mobSystem && typeof this.mobSystem.onChunkLoad === 'function') {
        this.mobSystem.onChunkLoad(cx, cz);
    }
    // Call chest and campfire chunk load handlers if systems are initialized
    if (this.chestSystem && typeof this.chestSystem.onChunkLoad === 'function') {
        this.chestSystem.onChunkLoad(cx, cz);
    }
    if (this.campfireSystem && typeof this.campfireSystem.onChunkLoad === 'function') {
        this.campfireSystem.onChunkLoad(cx, cz);
    }
    if (this.bedSystem && typeof this.bedSystem.onChunkLoad === 'function') {
        this.bedSystem.onChunkLoad(cx, cz);
    }
    if (this.treeSystem && typeof this.treeSystem.onChunkLoad === 'function') {
        this.treeSystem.onChunkLoad(cx, cz);
    }
    if (this.stonePebblesSystem && typeof this.stonePebblesSystem.onChunkLoad === 'function') {
        this.stonePebblesSystem.onChunkLoad(cx, cz);
    }
    if (oreDecorationsSystem && typeof oreDecorationsSystem.onChunkLoad === 'function') {
        oreDecorationsSystem.onChunkLoad(cx, cz);
    }
    if (this.furnaceSystem && typeof this.furnaceSystem.onChunkLoad === 'function') {
        this.furnaceSystem.onChunkLoad(cx, cz);
    }
    if (this.loomSystem && typeof this.loomSystem.onChunkLoad === 'function') {
        this.loomSystem.onChunkLoad(cx, cz);
    }
    if (waterSystem && typeof waterSystem.onChunkGenerated === 'function') {
        waterSystem.onChunkGenerated(cx, cz);
    }
})(terrain.generateChunk);
terrain.unloadChunk = ((orig) => function(cx, cz) {
    orig.call(this, cx, cz);
    const chunkKey = this.getChunkKey ? this.getChunkKey(cx, cz) : `${cx},${cz}`;
    if (this.mobSystem && typeof this.mobSystem.onChunkUnload === 'function') {
        this.mobSystem.onChunkUnload(cx, cz);
    }
    if (this.chestSystem && typeof this.chestSystem.onChunkUnload === 'function') {
        this.chestSystem.onChunkUnload(cx, cz);
    }
    if (this.campfireSystem && typeof this.campfireSystem.onChunkUnload === 'function') {
        this.campfireSystem.onChunkUnload(cx, cz);
    }
    if (this.bedSystem && typeof this.bedSystem.onChunkUnload === 'function') {
        this.bedSystem.onChunkUnload(cx, cz);
    }
    if (this.treeSystem && typeof this.treeSystem.onChunkUnload === 'function') {
        this.treeSystem.onChunkUnload(cx, cz);
    }
    if (this.stonePebblesSystem && typeof this.stonePebblesSystem.onChunkUnload === 'function') {
        this.stonePebblesSystem.onChunkUnload(cx, cz);
    }
    if (oreDecorationsSystem && typeof oreDecorationsSystem.onChunkUnload === 'function') {
        oreDecorationsSystem.onChunkUnload(cx, cz);
    }
    if (this.furnaceSystem && typeof this.furnaceSystem.onChunkUnload === 'function') {
        this.furnaceSystem.onChunkUnload(cx, cz);
    }
    if (this.loomSystem && typeof this.loomSystem.onChunkUnload === 'function') {
        this.loomSystem.onChunkUnload(cx, cz);
    }
    if (waterSystem && typeof waterSystem.onChunkUnload === 'function') {
        waterSystem.onChunkUnload(cx, cz);
    }
    if (this.particleSystem) {
        if (typeof this.particleSystem.removeChunkParticles === 'function') {
            this.particleSystem.removeChunkParticles(chunkKey);
        }
        if (typeof this.particleSystem.removeParticlesInChunk === 'function') {
            this.particleSystem.removeParticlesInChunk(cx, cz);
        }
    }
})(terrain.unloadChunk);
// Chunk (0,0) is created when spawn runs (after atlas ready) so it gets textures; do not generate here.
const BLOCK_TYPES = {
    1: { name: 'Dirt', color: [0.55, 0.27, 0.07] },
    2: { name: 'Stone', color: [0.5, 0.5, 0.5] },
    3: { name: 'Grass', color: [0.2, 0.8, 0.2] },
    9: { name: 'Sand',  color: [0.95, 0.9, 0.4] },
    10:{ name: 'Cactus', color: [0.25, 0.8, 0.25] },
    4: { name: 'Oak Log', color: [0.55, 0.35, 0.2] },
    5: { name: 'Oak Leaves', color: [0.2, 0.55, 0.2] },
    6: { name: 'Planks', color: [0.7, 0.55, 0.35] },
    planks: { name: 'Planks', color: [0.7, 0.55, 0.35] },
    7: { name: 'Coal Ore', color: [0.2, 0.2, 0.2] },
    8: { name: 'Iron Ore', color: [0.5, 0.4, 0.35] },
    11: { name: 'Gold Ore', color: [0.9, 0.8, 0.2] },
    12: { name: 'Water', color: [0.2, 0.4, 0.9] },
    13: { name: 'Water', color: [0.2, 0.4, 0.9] },
    14: { name: 'Water', color: [0.2, 0.4, 0.9] },
    15: { name: 'Water', color: [0.2, 0.4, 0.9] },
    16: { name: 'Water', color: [0.2, 0.4, 0.9] },
    17: { name: 'Water', color: [0.2, 0.4, 0.9] },
    18: { name: 'Water', color: [0.2, 0.4, 0.9] },
    19: { name: 'Snow', color: [0.92, 0.95, 1.0] },
    gun: { name: 'Gun', color: [0.7, 0.7, 0.7] },
    pickaxe: { name: 'Pickaxe', color: [0.7, 0.7, 0.7] },
    axe: { name: 'Axe', color: [0.6, 0.4, 0.2] },
    stone_axe: { name: 'Stone Axe', color: [0.5, 0.5, 0.5] },
    stone_pickaxe: { name: 'Stone Pickaxe', color: [0.5, 0.5, 0.5] },
    spade: { name: 'Spade', color: [0.4, 0.35, 0.3] },
    wood: { name: 'Oak Log', color: [0.55, 0.35, 0.2] },
    stick: { name: 'Stick', color: [0.6, 0.45, 0.25] },
    sapling: { name: 'Sapling', color: [0.2, 0.6, 0.2] },
    leaves: { name: 'Oak Leaves', color: [0.2, 0.55, 0.2] },
    stone: { name: 'Stone', color: [0.5, 0.5, 0.5] },
    raw_beef: { name: 'Raw Beef', color: [0xA52A2A/255, 0.2, 0.2] },
    cooked_beef: { name: 'Cooked Beef', color: [0.7, 0.3, 0.2] },
    leather: { name: 'Leather', color: [0x8B4513/255, 0.5, 0.2] },
    bone: { name: 'Bone', color: [0.9, 0.9, 0.9] },
    raw_mutton: { name: 'Raw Mutton', color: [0xEEDFCC/255, 0.7, 0.7] },
    cooked_mutton: { name: 'Cooked Mutton', color: [0.9, 0.7, 0.5] },
    wool: { name: 'Wool', color: [1, 1, 1] },
    chest: { name: 'Chest', color: [0.8, 0.6, 0.4] },
    campfire: { name: 'Campfire', color: [1.0, 0.6, 0.2] },
    bed: { name: 'Bed', color: [0.55, 0.35, 0.2] },
    furnace: { name: 'Furnace', color: [0.35, 0.35, 0.4] },
    coal: { name: 'Coal', color: [0.15, 0.15, 0.15] },
    iron_ore: { name: 'Iron Ore', color: [0.45, 0.35, 0.3] },
    iron_bar: { name: 'Iron Bar', color: [0.6, 0.55, 0.5] },
    gold_ore: { name: 'Gold Ore', color: [0.9, 0.8, 0.2] },
    gold_ingot: { name: 'Gold Ingot', color: [0.95, 0.85, 0.25] },
    string: { name: 'String', color: [0.95, 0.9, 0.85] },
    spares: { name: 'Spares', color: [0.5, 0.45, 0.4] },
    bow: { name: 'Bow', color: [0.55, 0.35, 0.2] },
    arrow: { name: 'Crude Arrow', color: [0.5, 0.4, 0.3] },
    feathered_arrow: { name: 'Feathered Arrow', color: [0.9, 0.9, 0.95] },
    loom: { name: 'Loom', color: [0.55, 0.45, 0.35] },
    feather: { name: 'Feather', color: [0.95, 0.95, 0.9] },
    ring: { name: 'Ring', color: [0.85, 0.85, 0.9] },
    necklace: { name: 'Necklace', color: [0.85, 0.85, 0.9] },
    iron_ring: { name: 'Iron Ring', color: [0.7, 0.7, 0.75] },
    iron_necklace: { name: 'Iron Necklace', color: [0.7, 0.7, 0.75] },
    gold_ring: { name: 'Gold Ring', color: [0.95, 0.85, 0.3] },
    gold_necklace: { name: 'Gold Necklace', color: [0.95, 0.85, 0.3] },
    helmet: { name: 'Helmet', color: [0.5, 0.5, 0.55] },
    body_armour: { name: 'Body Armour', color: [0.45, 0.45, 0.5] },
    leggings: { name: 'Leggings', color: [0.4, 0.4, 0.45] },
    boots: { name: 'Boots', color: [0.35, 0.35, 0.4] },
};

// Terrain block breaking state (per-block hit progress)
const terrainHitProgress = new Map();
const TERRAIN_PROGRESS_MEMORY_MS = 2500;

function makeBlockKey(x, y, z) {
    return `${x}|${y}|${z}`;
}

function classifyToolForBlockBreaking(current, getSlotTypeFn) {
    if (!current) return 'hand';
    const t = typeof current === 'string' ? current : getSlotTypeFn(current);
    if (t === 'pickaxe' || t === 'stone_pickaxe') return t;
    if (t === 'axe' || t === 'stone_axe') return t;
    if (t === 'spade') return 'spade';
    return 'other';
}

function getHitsToBreakBlock(voxelType, toolKind) {
    // Numeric IDs from terrain / blocksRegistry: 4 = Log, 6 = Planks
    // 1: Dirt, 2: Stone, 3: Grass, 4: Log, 7: Coal ore, 8: Iron ore,
    // 9: Sand, 10: Cactus, 11: Gold ore
    const isStoneLike = voxelType === 2 || voxelType === 7 || voxelType === 8 || voxelType === 11;
    const isDirtLike = voxelType === 1 || voxelType === 3 || voxelType === 19;
    const isWoodLike = voxelType === 4;
    const isSandLike = voxelType === 9;
    const isCactus = voxelType === 10;

    if (isStoneLike) {
        // Only pickaxes can break stone/ores.
        if (toolKind === 'stone_pickaxe') return 2;
        if (toolKind === 'pickaxe') return 3;
        return 0; // cannot break with other tools
    }

    if (isDirtLike) {
        if (toolKind === 'spade') return 1;                               // spade: fastest on soil
        if (toolKind === 'pickaxe' || toolKind === 'stone_pickaxe') return 5; // pickaxe: slower than spade
        if (toolKind === 'axe' || toolKind === 'stone_axe') return 4;
        if (toolKind === 'hand' || toolKind === 'other') return 6;        // hand: can break, but noticeably slower
    }

    if (isSandLike) {
        if (toolKind === 'spade') return 1;                               // spade: best for sand
        if (toolKind === 'pickaxe' || toolKind === 'stone_pickaxe') return 4; // can break sand, but slower
        if (toolKind === 'hand' || toolKind === 'other') return 6;        // hand: can break, slower
    }

    if (isWoodLike) {
        if (toolKind === 'axe' || toolKind === 'stone_axe') return 2;         // axe: very good on wood
        if (toolKind === 'pickaxe' || toolKind === 'stone_pickaxe') return 5; // pickaxe: slow on wood
        if (toolKind === 'spade') return 4;
        if (toolKind === 'hand' || toolKind === 'other') return 8;            // hand: can break logs, but quite slow
    }

    if (isCactus) {
        if (toolKind === 'spade') return 1;
        if (toolKind === 'axe' || toolKind === 'stone_axe') return 2;
        if (toolKind === 'pickaxe' || toolKind === 'stone_pickaxe') return 3;
        if (toolKind === 'hand' || toolKind === 'other') return 4;
    }

    // Default for other solid blocks: 1 hit with any tool/hand.
    return 1;
}

function applyCactusFallAfterBreak(terrain, vx, vy, vz, removedType) {
    if (removedType !== 10) return; // 10 = Cactus
    const maxY = terrain.height || 64;
    let y = vy + 1;
    const cactusYs = [];
    while (y < maxY) {
        const t = terrain.getVoxelAt(vx, y, vz);
        if (t === 10) {
            cactusYs.push(y);
            y++;
        } else {
            break;
        }
    }
    if (!cactusYs.length) return;
    for (const fromY of cactusYs) {
        const toY = fromY - 1;
        terrain.setVoxel(vx, fromY, vz, 0);
        terrain.setVoxel(vx, toY, vz, 10);
    }
}

const LOG_BLOCK_ID = 4;
const LEAVES_BLOCK_ID_TREE = 5;

/** When a log or leaf block is broken, clear the entire connected tree (logs + leaves) into item entities. */
function applyTreeColumnCollapse(terrain, vx, vy, vz, removedType) {
    if (removedType !== LOG_BLOCK_ID && removedType !== LEAVES_BLOCK_ID_TREE) return;
    if (!itemDropSystem || !particleSystem) return;

    const downDir = new THREE.Vector3(0, -1, 0);
    const visited = new Set();
    const queue = [];

    function enqueue(x, y, z) {
        const key = `${x}|${y}|${z}`;
        if (visited.has(key)) return;
        const t = terrain.getVoxelAt(x, y, z);
        if (t !== LOG_BLOCK_ID && t !== LEAVES_BLOCK_ID_TREE) return;
        visited.add(key);
        terrain.setVoxel(x, y, z, 0);
        queue.push({ x, y, z, type: t });
    }

    // Seed BFS from the broken block's immediate neighborhood (including itself)
    enqueue(vx, vy, vz);
    const seeds = [
        [vx + 1, vy, vz],
        [vx - 1, vy, vz],
        [vx, vy, vz + 1],
        [vx, vy, vz - 1],
        [vx, vy + 1, vz],
        [vx, vy - 1, vz],
    ];
    for (const [sx, sy, sz] of seeds) {
        enqueue(sx, sy, sz);
    }

    while (queue.length > 0) {
        const { x, y, z, type } = queue.shift();
        const origin = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
        const color = BLOCK_TYPES[type] && BLOCK_TYPES[type].color
            ? BLOCK_TYPES[type].color
            : [0.5, 0.5, 0.5];
        particleSystem.spawn(origin, downDir, null, color);

        const basePos = origin.clone();
        const randOffset = () => new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4);
        if (type === LOG_BLOCK_ID) {
            itemDropSystem.spawnDrop('wood', 1, basePos.clone().add(randOffset()));
        } else if (type === LEAVES_BLOCK_ID_TREE) {
            itemDropSystem.spawnDrop('leaves', 1, basePos.clone().add(randOffset()));
            // Chance for extra sticks from canopy decay
            if (Math.random() < 0.5) {
                const sticks = 1 + Math.floor(Math.random() * 2);
                for (let i = 0; i < sticks; i++) {
                    itemDropSystem.spawnDrop('stick', 1, basePos.clone().add(randOffset()));
                }
            }
            // Occasional extra saplings from upper leaves
            if (Math.random() < 0.25) {
                itemDropSystem.spawnDrop('sapling', 1, basePos.clone().add(randOffset()));
            }
        }

        // Explore 26-connected neighbors (faces, edges, corners) so corner leaves
        // that only touch diagonally are also included in the cascade.
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    enqueue(x + dx, y + dy, z + dz);
                }
            }
        }
    }
}

// Fuel burn time in seconds (for campfire and furnace)
const FUEL_BURN_TIME = {
    coal: 80,
    wood: 15,
    planks: 4,
    stick: 2,
};

function getFuelBurnTime(type) {
    if (type === 'wood' || type === 4 || type === 'planks' || type === 'stick' || type === 'coal') return FUEL_BURN_TIME[type] ?? (type === 4 ? FUEL_BURN_TIME.planks : 0) ?? 0;
    return 0;
}

// Map inventory item types to voxel block IDs for placement.
// Allows placing e.g. 'stone' (item) as the stone block (ID 2).
function itemTypeToBlockId(type) {
    if (typeof type === 'number') return type;
    if (type === 'stone') return 2;
    if (type === 'wood') return 4;       // place as log
    if (type === 'leaves' || type === 'leaf') return 5;
    if (type === 'iron_ore') return 8;
    if (type === 'gold_ore') return 11;
    if (type === 'coal') return 7;
    return null;
}

function cookItem(type) {
    if (type === 'raw_beef') return 'cooked_beef';
    if (type === 'raw_mutton') return 'cooked_mutton';
    return null;
}
function smeltItem(type) {
    if (type === 'iron_ore') return 'iron_bar';
    if (type === 'gold_ore') return 'gold_ingot';
    return null;
}
function getBlockName(type) {
    return BLOCK_TYPES[type]?.name || 'unknown';
}
function isValidBlockType(type) {
    return type in BLOCK_TYPES;
}
import { setupCompassAndClock, setupHealthBar, updateHealthBar, setupStaminaBar, updateStaminaBar, setCreativeModeUI } from './ui/ui.js';
setupCompassAndClock();
setupHealthBar();
setupStaminaBar();

// Pause menu button handlers
function setupPauseMenu() {
    const resumeButton = document.getElementById('resumeButton');
    const settingsButton = document.getElementById('settingsButton');
    const exitButton = document.getElementById('exitButton');
    const pauseOverlay = document.getElementById('pauseOverlay');
    const pointerHint = document.getElementById('pointerHint');
    const newWorldButton = document.getElementById('newWorldButton');
    
    // Resume button - unpauses the game (same as pressing Escape)
    if (resumeButton) {
        resumeButton.addEventListener('click', () => {
            if (gamePaused) {
                gamePaused = false;
                document.body.classList.remove('game-paused');
                if (pauseOverlay) {
                    pauseOverlay.style.display = 'none';
                }
                renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                canvas.focus();
                canvas.requestPointerLock().catch(() => {}); // app: never show hint
                if (typeof controls !== 'undefined' && controls && typeof controls.resetMovementState === 'function') {
                    controls.resetMovementState();
                }
                updateCursorForBackpack();
            }
        });
    }

    // Settings button - hide pause, show settings, release pointer so mouse is visible
    if (settingsButton) {
        settingsButton.addEventListener('click', () => {
            if (!gamePaused) return;
            if (document.pointerLockElement === canvas) document.exitPointerLock();
            settingsOverlayOpen = true;
            if (pauseOverlay) pauseOverlay.style.display = 'none';
            const settingsEl = document.getElementById('settingsOverlay');
            if (settingsEl) settingsEl.style.display = 'flex';
            const saveLoadEl = document.getElementById('saveLoadOverlay');
            if (saveLoadEl) saveLoadEl.style.display = 'none';
            saveLoadOverlayOpen = false;
            const rdInput = document.getElementById('renderDistanceInput');
            const rdValue = document.getElementById('renderDistanceValue');
            if (rdInput && rdValue && terrain && terrain.setRenderDistance) {
                const current = typeof terrain.getRenderDistance === 'function' ? terrain.getRenderDistance() : (terrain.renderDistance ?? 2);
                rdInput.value = current;
                rdValue.textContent = current;
            }
            const gameVolumeInput = document.getElementById('gameVolumeInput');
            const gameVolumeValue = document.getElementById('gameVolumeValue');
            const gameMuteCheckbox = document.getElementById('gameMuteCheckbox');
            if (gameVolumeInput && gameVolumeValue) {
                const vol = Math.round(getGameVolume() * 100);
                gameVolumeInput.value = vol;
                gameVolumeValue.textContent = vol + '%';
            }
            if (gameMuteCheckbox) {
                gameMuteCheckbox.checked = getGameMuted();
            }
            const bloodParticlesCheckbox = document.getElementById('bloodParticlesCheckbox');
            if (bloodParticlesCheckbox) {
                bloodParticlesCheckbox.checked = getBloodParticlesEnabled();
            }
            updateCursorForBackpack();
        });
    }

    // Save / Load button - hide pause, show Save/Load overlay
    const saveLoadButton = document.getElementById('saveLoadButton');
    if (saveLoadButton) {
        saveLoadButton.addEventListener('click', () => {
            if (!gamePaused) return;
            if (document.pointerLockElement === canvas) document.exitPointerLock();
            saveLoadOverlayOpen = true;
            if (pauseOverlay) pauseOverlay.style.display = 'none';
            const saveLoadEl = document.getElementById('saveLoadOverlay');
            if (saveLoadEl) saveLoadEl.style.display = 'flex';
            const settingsEl = document.getElementById('settingsOverlay');
            if (settingsEl) settingsEl.style.display = 'none';
            settingsOverlayOpen = false;
            refreshSaveLoadUI();
            updateCursorForBackpack();
        });
    }

    // New World button - clears voxel modifications and regenerates around spawn.
    // This does not reload the whole page.
    if (newWorldButton) {
        newWorldButton.addEventListener('click', async () => {
            if (!gamePaused) return;
            // Immediately close pause UI so controls/audio/UI state looks responsive.
            gamePaused = false;
            document.body.classList.remove('game-paused');
            if (pauseOverlay) pauseOverlay.style.display = 'none';
            if (document.pointerLockElement === canvas) document.exitPointerLock();

            try {
                await startNewWorld();
            } catch (e) {
                console.error('[NewWorld] Failed:', e);
            }
        });
    }

    // Save/Load overlay: Back button
    const saveLoadBackButton = document.getElementById('saveLoadBackButton');
    if (saveLoadBackButton) {
        saveLoadBackButton.addEventListener('click', () => {
            saveLoadOverlayOpen = false;
            const saveLoadEl = document.getElementById('saveLoadOverlay');
            const pauseEl = document.getElementById('pauseOverlay');
            if (saveLoadEl) saveLoadEl.style.display = 'none';
            if (pauseEl) pauseEl.style.display = 'block';
            updateCursorForBackpack();
        });
    }
    
    // Exit button - closes the game/window
    if (exitButton) {
        exitButton.addEventListener('click', () => {
            // Close the window/tab
            window.close();
            // If window.close() doesn't work (some browsers block it), try other methods
            // For Electron apps, you might want to use: window.electronAPI?.quit()
            // For regular browser, we can try to navigate away or show a message
            if (typeof window.electronAPI !== 'undefined' && window.electronAPI.quit) {
                window.electronAPI.quit();
            } else {
                // Fallback: try to close or navigate
                try {
                    window.close();
                } catch (e) {
                    // If we can't close, at least show a message
                    alert('To exit the game, please close this browser tab/window.');
                }
            }
        });
    }

    // Settings overlay: Back button and render distance slider
    const settingsBackButton = document.getElementById('settingsBackButton');
    const renderDistanceInput = document.getElementById('renderDistanceInput');
    const renderDistanceValue = document.getElementById('renderDistanceValue');
    if (settingsBackButton) {
        settingsBackButton.addEventListener('click', () => {
            settingsOverlayOpen = false;
            const settingsEl = document.getElementById('settingsOverlay');
            const pauseEl = document.getElementById('pauseOverlay');
            if (settingsEl) settingsEl.style.display = 'none';
            if (pauseEl) pauseEl.style.display = 'block';
            updateCursorForBackpack();
        });
    }
    if (renderDistanceInput && renderDistanceValue && terrain) {
        renderDistanceInput.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            if (!Number.isNaN(v) && terrain.setRenderDistance) {
                terrain.setRenderDistance(v);
                renderDistanceValue.textContent = v;
                localStorage.setItem('voxelShooter_renderDistance', String(v));
                if (typeof updateDistanceFog === 'function') updateDistanceFog();
            }
        });
    }
    const gameVolumeInput = document.getElementById('gameVolumeInput');
    const gameVolumeValue = document.getElementById('gameVolumeValue');
    const gameMuteCheckbox = document.getElementById('gameMuteCheckbox');
    if (gameVolumeInput && gameVolumeValue) {
        gameVolumeInput.addEventListener('input', (e) => {
            const pct = parseInt(e.target.value, 10);
            if (!Number.isNaN(pct)) {
                const v = pct / 100;
                setGameVolume(v);
                gameVolumeValue.textContent = pct + '%';
            }
        });
    }
    if (gameMuteCheckbox) {
        gameMuteCheckbox.addEventListener('change', () => {
            setGameMuted(gameMuteCheckbox.checked);
        });
    }
    const bloodParticlesCheckbox = document.getElementById('bloodParticlesCheckbox');
    if (bloodParticlesCheckbox) {
        bloodParticlesCheckbox.addEventListener('change', () => {
            setBloodParticlesEnabled(bloodParticlesCheckbox.checked);
        });
    }
}

// Setup pause menu buttons after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupPauseMenu);
} else {
    setupPauseMenu();
}
function setSelectedHotbar(i) {
    selectedHotbar = i;
    renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
    updateHeldModelVisibility();
}
renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
renderEquipment(getBlockName, isValidBlockType, updateHeldModelVisibility);
document.addEventListener('inventoryChanged', () => {
    renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
    renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
    renderEquipment(getBlockName, isValidBlockType, updateHeldModelVisibility);
    updateHeldModelVisibility();
});
if (!document.getElementById('compassOverlay')) {
    const compass = document.createElement('div');
    compass.id = 'compassOverlay';
    compass.style.position = 'fixed';
    compass.style.top = '12px';
    compass.style.left = '50%';
    compass.style.transform = 'translateX(-50%)';
    compass.style.color = 'white';
    compass.style.fontSize = '1.2em';
    compass.style.zIndex = 1000;
    document.body.appendChild(compass);
}
if (!document.getElementById('clockOverlay')) {
    const clock = document.createElement('div');
    clock.id = 'clockOverlay';
    clock.style.position = 'fixed';
    clock.style.top = '40px';
    clock.style.left = '50%';
    clock.style.transform = 'translateX(-50%)';
    clock.style.color = 'white';
    clock.style.fontSize = '1.1em';
    clock.style.zIndex = 1000;
    document.body.appendChild(clock);
}
import * as THREE from 'three';
import { createPlayer, playerHeight } from './core/player.js';
import { setupControls } from './core/controls.js';
import { setupShooting } from './game/shooting.js';
import { createParticleSystem } from './systems/particles.js';
import { createTerrain } from './world/terrain.js'; 
import { createWaterSystem } from './world/water/WaterSystem.js';
import { getBiomeInfoAt, SEA_LEVEL } from './world/terrain/biomes.js';
import { computeBaseHeight } from './world/terrain/baseHeight.js';
import { createSky } from './world/sky.js';
import { createLighting } from './core/lighting.js';
import { loadModels } from './assets/models.js';
import { loadAllTextures } from './assets/textures.js';
import { checkCollision } from './utils/collision.js';
import { BLOCK_IDS, isWater } from './world/blocksRegistry.js';
import { createChestSystem, CHEST_SLOTS } from './systems/chest.js';
import { createCampfireSystem } from './systems/campfire.js';
import { createFurnaceSystem } from './systems/furnace.js';
import { createLoomSystem } from './systems/loom.js';
import { createBedSystem } from './systems/bed.js';
import { createTreeSystem } from './world/trees.js';
import { createStonePebblesSystem } from './world/stonePebbles.js';
import { createOreDecorationsSystem } from './world/oreDecorations.js';
import { backpackSlots, createStackItem, getSlotType, getSlotCount, hotbar, getEquippedHead, setEquippedHead, getEquippedBody, setEquippedBody, getEquippedLegs, setEquippedLegs, getEquippedFeet, setEquippedFeet, getEquippedRing1, setEquippedRing1, getEquippedRing2, setEquippedRing2, getEquippedNecklace, setEquippedNecklace } from './game/inventory.js';
import { getItemIconUrl } from './game/itemIcons.js';
import { createItemDropSystem } from './systems/itemDrops.js';
import { createProjectileSystem } from './systems/projectiles.js';
import { generateTreesForChunk } from './world/treeGenerator.js';
import { getWorldStateForSave, restoreWorldState } from './world/worldState.js';
import { saveGame, loadGame, listSaves, deleteSave, NUM_SLOTS } from './game/saveLoad.js';
import { t } from './game/messages.js';
import { getGameVolume, getGameMuted, setGameVolume, setGameMuted } from './game/audioSettings.js';
import { getBloodParticlesEnabled, setBloodParticlesEnabled } from './game/settings.js';
import { createDevConsole } from './game/devConsole.js';
import { createWeatherEffects } from './world/weatherEffects.js';

// selectedHotbar already declared above
// backpackOpen already declared above
let craftingOpen = false;
let openChest = null;
let chestUI = null;
let openCampfire = false;
let openFurnace = false;
let openLoom = false;
let campfireUI = null;
let loomUI = null;
let devConsoleOpen = false;
/** Set when createDevConsole runs; Escape closes chat before pause (document capture runs first). */
let devConsoleApi = null;

function updateInventoryOverlay() {
    const overlay = document.getElementById('inventory-overlay');
    const craftingPanelEl = document.getElementById('crafting-panel');
    if (!overlay) return;
    const show = backpackOpen || openChest || openCampfire || openFurnace || openLoom || craftingOpen;
    overlay.style.display = show ? 'flex' : 'none';
    if (craftingPanelEl) craftingPanelEl.style.display = craftingOpen ? 'block' : 'none';
}

// Health & core stats system
let playerHealth = 100;
const BASE_MAX_HEALTH = 100;
const BASE_MAX_STAMINA = 100; // UI-side stamina "max" for normalized 0–1 stamina

// Jewellery-based stat bonuses (per equipped item)
const JEWELLERY_BONUSES = {
    ring:          { maxHealth: 5,  maxStamina: 5  },
    iron_ring:     { maxHealth: 10, maxStamina: 10 },
    gold_ring:     { maxHealth: 20, maxStamina: 20 },
    necklace:      { maxHealth: 10, maxStamina: 10 },
    iron_necklace: { maxHealth: 20, maxStamina: 20 },
    gold_necklace: { maxHealth: 30, maxStamina: 30 },
};

function computeMaxHealth() {
    let bonus = 0;
    const r1 = getEquippedRing1();
    const r2 = getEquippedRing2();
    const n = getEquippedNecklace();
    const addFrom = (slot) => {
        if (!slot) return;
        const t = getSlotType(slot);
        const b = JEWELLERY_BONUSES[t];
        if (b && typeof b.maxHealth === 'number') bonus += b.maxHealth;
    };
    addFrom(r1);
    addFrom(r2);
    addFrom(n);
    return BASE_MAX_HEALTH + bonus;
}

function computeMaxStamina() {
    let bonus = 0;
    const r1 = getEquippedRing1();
    const r2 = getEquippedRing2();
    const n = getEquippedNecklace();
    const addFrom = (slot) => {
        if (!slot) return;
        const t = getSlotType(slot);
        const b = JEWELLERY_BONUSES[t];
        if (b && typeof b.maxStamina === 'number') bonus += b.maxStamina;
    };
    addFrom(r1);
    addFrom(r2);
    addFrom(n);
    return BASE_MAX_STAMINA + bonus;
}

function getCurrentMaxHealth() {
    return computeMaxHealth();
}

function getCurrentMaxStamina() {
    return computeMaxStamina();
}

// Small periodic damage when standing in hazardous blocks (e.g. cactus)
let cactusDamageCooldownPlayer = 0;

// Store initial spawn position for respawn
let spawnPosition = null;
let defaultSpawnPosition = null;

/** Single entry point for all player damage: cactus, fall, skeleton arrows, goblin melee, etc. */
function takeDamage(amount) {
    if (creativeMode) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    amount = n;
    // Armour: each piece reduces damage (body 25%, helmet 15%, leggings 20%, boots 15%; max 75%)
    let mult = 1;
    if (getEquippedBody() && getSlotType(getEquippedBody()) === 'body_armour') mult -= 0.25;
    if (getEquippedHead() && getSlotType(getEquippedHead()) === 'helmet') mult -= 0.15;
    if (getEquippedLegs() && getSlotType(getEquippedLegs()) === 'leggings') mult -= 0.20;
    if (getEquippedFeet() && getSlotType(getEquippedFeet()) === 'boots') mult -= 0.15;
    amount *= Math.max(0.25, mult);
    const maxHealthNow = getCurrentMaxHealth();
    playerHealth = Math.max(0, Math.min(maxHealthNow, playerHealth - amount));
    updateHealthBar(playerHealth, maxHealthNow);
    if (playerHealth <= 0) {
        // Player died - respawn at starting position
        respawnPlayer();
    }
}

function respawnPlayer() {
    if (spawnPosition) {
        // On respawn, recompute a safe surface position at the saved spawn X/Z
        placePlayerAtSpawn(spawnPosition.x, spawnPosition.z);
        const maxHealthNow = getCurrentMaxHealth();
        playerHealth = maxHealthNow;
        updateHealthBar(playerHealth, maxHealthNow);
    }
}

function heal(amount) {
    const maxHealthNow = getCurrentMaxHealth();
    playerHealth = Math.min(maxHealthNow, playerHealth + amount);
    updateHealthBar(playerHealth, maxHealthNow);
}

function applyCactusDamageToPlayer(delta) {
    if (!terrain || typeof terrain.getVoxelAt !== 'function' || !player) return;
    cactusDamageCooldownPlayer = Math.max(0, cactusDamageCooldownPlayer - delta);
    if (cactusDamageCooldownPlayer > 0) return;

    const px = player.position.x;
    const py = player.position.y;
    const pz = player.position.z;
    // Full capsule height: from feet to head so we never miss a block we're touching
    const minY = Math.floor(py);
    const maxY = Math.min(terrain.height - 1, Math.floor(py + playerHeight) + 1);

    // Sample a grid so any block overlapping the player capsule is detected (walking into or standing in cactus)
    const step = 0.5;
    const radius = 0.6;
    for (let ox = -radius; ox <= radius + 0.01; ox += step) {
        for (let oz = -radius; oz <= radius + 0.01; oz += step) {
            const vx = Math.floor(px + ox);
            const vz = Math.floor(pz + oz);
            for (let vy = minY; vy <= maxY; vy++) {
                if (vy < 0) continue;
                if (terrain.getVoxelAt(vx, vy, vz) === BLOCK_IDS.CACTUS) {
                    takeDamage(2);
                    cactusDamageCooldownPlayer = 0.5;
                    return;
                }
            }
        }
    }
}

// Hotbar selection by number keys
window.addEventListener('keydown', (e) => {
    if (gamePaused) return; // Block when paused
    if (!backpackOpen && !craftingOpen && !openChest && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx >= 0 && idx < hotbar.length) {
            setSelectedHotbar(idx);
        }
    }
});

// (Global wheel handler for hotbar removed; consolidated below)


function updateCursorForBackpack() {
    // Show cursor when any UI is open (backpack, crafting, chest, or campfire)
    document.body.style.cursor = (backpackOpen || craftingOpen || openChest || openCampfire || openFurnace || openLoom || devConsoleOpen || referenceOverlayOpen || gamePaused || settingsOverlayOpen || saveLoadOverlayOpen) ? 'default' : 'none';
}

// (old 'b' backpack toggle removed; we now use only 'E')

// Always sync cursor to backpack state on load
updateCursorForBackpack();


// Load all textures at startup
loadAllTextures();
// ...existing code...







const { player, camera, getWorldPosition } = createPlayer(scene);

// Create mob system now that player and takeDamage exist
// Particle system, sky time, and player-view check passed via getters (set after sky/camera exist)
let particleSystemRef = null;
let getSkyTimeRef = null;
let getIsInPlayerViewRef = null;
mobSystem = createMobSystem(
    scene, terrain, player, takeDamage, () => particleSystemRef,
    () => getSkyTimeRef && getSkyTimeRef(),
    (worldPos) => getIsInPlayerViewRef && getIsInPlayerViewRef(worldPos),
    playerHeight
);
mobSystem.spawnInitial();
terrain.mobSystem = mobSystem;

function getProjectileColliders() {
    const terrainChunks = Array.from(terrain.chunks.values());
    const chestMeshes = chestSystem ? chestSystem.chests : [];
    const campfireMeshes = campfireSystem ? campfireSystem.campfires : [];
    const furnaceMeshes = furnaceSystem ? furnaceSystem.furnaces : [];
    const loomMeshes = loomSystem ? loomSystem.looms : [];
    const bedMeshes = bedSystem ? bedSystem.beds : [];
    const treeMeshes = treeSystem ? (treeSystem.getCollisionMeshes ? treeSystem.getCollisionMeshes() : treeSystem.trees || []) : [];
    const pebbleMeshes = stonePebblesSystem && typeof stonePebblesSystem.getPebbleMeshes === 'function' ? stonePebblesSystem.getPebbleMeshes() : [];
    return [...mobSystem.getRaycastBlockers(), ...terrainChunks, ...chestMeshes, ...campfireMeshes, ...furnaceMeshes, ...loomMeshes, ...bedMeshes, ...treeMeshes, ...pebbleMeshes];
}

const projectileSystem = createProjectileSystem(
    scene,
    getProjectileColliders,
    (mobMesh, damage) => {
        const mobDrops = mobSystem.damageMob(mobMesh, damage);
        if (mobDrops && mobDrops.length > 0 && itemDropSystem) {
            const origin = new THREE.Vector3();
            mobMesh.getWorldPosition(origin);
            for (const drop of mobDrops) {
                if (!drop || typeof drop !== 'string') continue;
                itemDropSystem.spawnDrop(drop, 1, origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.5, (Math.random() - 0.5) * 0.6)));
            }
        }
        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
        renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
    },
    (damage) => takeDamage(damage),
    () => {
        const v = new THREE.Vector3();
        player.getWorldPosition(v);
        v.y += playerHeight * 0.5;
        return v;
    },
    1.0
);
mobSystem.setSpawnSkeletonArrow((origin, dir, dmg) => projectileSystem.spawnArrow(origin, dir, dmg, 'skeleton'));

// Item drop system – spawns floating pickups and lets player collect them
const itemDropSystem = createItemDropSystem(
    scene,
    terrain,
    () => player,
    (type, count) => {
        // 1) Check if there's any capacity at all (hotbar + backpack).
        let totalCapacity = 0;

        // Existing hotbar stacks (slots 2+)
        for (let i = 2; i < hotbar.length; i++) {
            const slot = hotbar[i];
            if (slot && getSlotType(slot) === type) {
                totalCapacity += Math.max(0, 100 - getSlotCount(slot));
            }
        }
        // Existing backpack stacks
        for (let i = 0; i < backpackSlots.length; i++) {
            const slot = backpackSlots[i];
            if (slot && getSlotType(slot) === type) {
                totalCapacity += Math.max(0, 100 - getSlotCount(slot));
            }
        }
        // Empty hotbar slots (slots 2+)
        for (let i = 2; i < hotbar.length; i++) {
            if (hotbar[i] == null) totalCapacity += 100;
        }
        // Empty backpack slots
        for (let i = 0; i < backpackSlots.length; i++) {
            if (backpackSlots[i] == null) totalCapacity += 100;
        }

        if (totalCapacity <= 0) {
            // No room anywhere – refuse pickup, leave entity in world.
            return false;
        }

        // 2) Merge into existing stacks first (hotbar then backpack), then new stacks go to backpack first, hotbar only if backpack full.
        let remaining = count;
        let pickedUp = 0;

        // Fill existing hotbar stacks of same type (e.g. dirt in hotbar gets filled first)
        for (let i = 2; i < hotbar.length && remaining > 0; i++) {
            const slot = hotbar[i];
            if (slot && getSlotType(slot) === type) {
                const canAdd = 100 - getSlotCount(slot);
                if (canAdd > 0) {
                    const add = Math.min(canAdd, remaining);
                    hotbar[i] = createStackItem(type, getSlotCount(slot) + add);
                    remaining -= add;
                    pickedUp += add;
                }
            }
        }

        // Merge into existing backpack stacks
        for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
            const slot = backpackSlots[i];
            if (slot && getSlotType(slot) === type) {
                const canAdd = 100 - getSlotCount(slot);
                if (canAdd > 0) {
                    const add = Math.min(canAdd, remaining);
                    backpackSlots[i] = createStackItem(type, getSlotCount(slot) + add);
                    remaining -= add;
                    pickedUp += add;
                }
            }
        }

        // New stacks: backpack first
        for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
            if (backpackSlots[i] == null) {
                const add = Math.min(100, remaining);
                backpackSlots[i] = createStackItem(type, add);
                remaining -= add;
                pickedUp += add;
            }
        }

        // Only if backpack had no room: use empty hotbar slots for new stacks
        for (let i = 2; i < hotbar.length && remaining > 0; i++) {
            if (hotbar[i] == null) {
                const add = Math.min(100, remaining);
                hotbar[i] = createStackItem(type, add);
                remaining -= add;
                pickedUp += add;
            }
        }

        // Show pickup notification only for what actually got picked up
        if (pickedUp > 0) {
            let total = 0;
            for (const slot of [...backpackSlots, ...hotbar.slice(2)]) {
                if (slot && getSlotType(slot) === type) total += getSlotCount(slot);
            }
            const name = isValidBlockType(type) ? getBlockName(type) : type;
            showPickupNotification(name, pickedUp, total);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
        }

        // We always accept the drop if there was any capacity.
        return true;
    },
    (seconds) => {
        // Warn the player shortly before clearing old world drops
        showStatusMessage(t('status.worldDropsWarning', { seconds }));
    },
    () => {
        // Notify when drops have actually been cleared by the timer
        showStatusMessage(t('status.worldDropsCleared'));
    }
);

// Expose a helper so UI can drop items into the world when dragged out
window.spawnWorldDropFromUI = function(type, count) {
    if (!itemDropSystem || !type || count <= 0) return;
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
    const pos = origin.clone().add(dir.multiplyScalar(1.5));
    pos.y = origin.y;
    itemDropSystem.spawnDrop(type, count, pos);
};

// Chest, campfire, and tree systems will be created after models load
let chestSystem = null;
let campfireSystem = null;
let furnaceSystem = null;
let loomSystem = null;
let bedSystem = null;
let treeSystem = null;
let stonePebblesSystem = null;
let oreDecorationsSystem = null;

const _entitySnapBox = new THREE.Box3();
/** After a block is removed at (vx, vy, vz), snap entities only if they were inside that block; snap to local surface (at or below removed block), not world surface. */
function snapEntitiesToSurfaceInColumn(vx, vy, vz) {
    // Only snap player if they were actually intersecting the removed block (avoid teleporting to surface when just standing in same column)
    if (player && Math.floor(player.position.x) === vx && Math.floor(player.position.z) === vz) {
        const footY = player.position.y;
        const headY = player.position.y + playerHeight;
        const blockMinY = vy;
        const blockMaxY = vy + 1;
        const playerWasInBlock = headY > blockMinY && footY < blockMaxY;
        if (playerWasInBlock) {
            // Find highest solid (walkable) block in this column at or below the removed block (so we don't snap to world surface underground)
            let surfaceY = -1;
            for (let y = vy - 1; y >= 0; y--) {
                const type = terrain.getVoxelAt(vx, y, vz);
                if (type !== 0 && type !== 5) { surfaceY = y; break; }
            }
            const topY = surfaceY >= 0 ? surfaceY + 1.001 : vy + 1;
            player.position.y = topY;
        }
    }
    const getSurface = terrain.getWalkableSurfaceYAt || terrain.getSurfaceYAt;
    const surfaceTopY = getSurface(vx + 0.5, vz + 0.5);
    const topY = surfaceTopY + 1;
    if (mobSystem && typeof mobSystem.snapMobsInColumn === 'function') {
        mobSystem.snapMobsInColumn(vx, vz, surfaceTopY);
    }
    if (itemDropSystem && typeof itemDropSystem.snapDropsInColumn === 'function') {
        itemDropSystem.snapDropsInColumn(vx, vz, surfaceTopY);
    }
    // Beds, chests, campfires, and other placeables stay where they are; only
    // dynamic entities (player, mobs, drops) are adjusted when terrain changes.
}

/** After a block is placed at (px, py, pz), push any entities in that column that intersect the new block up so they sit on top. */
function pushEntitiesAboveBlock(px, py, pz) {
    const topY = py + 1;
    if (player && Math.floor(player.position.x) === px && Math.floor(player.position.z) === pz && player.position.y < topY) {
        player.position.y = topY;
    }
    if (mobSystem && mobSystem.mobMeshes) {
        for (const mesh of mobSystem.mobMeshes) {
            if (Math.floor(mesh.position.x) !== px || Math.floor(mesh.position.z) !== pz) continue;
            mesh.updateMatrixWorld(true);
            _entitySnapBox.setFromObject(mesh);
            if (_entitySnapBox.min.y < topY) {
                mesh.position.y += topY - _entitySnapBox.min.y;
            }
        }
    }
    if (itemDropSystem && typeof itemDropSystem.snapDropsInColumn === 'function') {
        const surfaceTopY = terrain.getSurfaceYAt(px + 0.5, pz + 0.5);
        itemDropSystem.snapDropsInColumn(px, pz, surfaceTopY);
    }
    [chestSystem?.chests, campfireSystem?.campfires, furnaceSystem?.furnaces, bedSystem?.beds].filter(Boolean).forEach((arr) => {
        if (!arr) return;
        for (const mesh of arr) {
            if (Math.floor(mesh.position.x) !== px || Math.floor(mesh.position.z) !== pz) continue;
            mesh.updateMatrixWorld(true);
            _entitySnapBox.setFromObject(mesh);
            if (_entitySnapBox.min.y < topY) {
                mesh.position.y += topY - _entitySnapBox.min.y;
            }
        }
    });
}

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    if (gamePaused) return; // Block when paused
    const selectedItem = hotbar[selectedHotbar];
    if (!selectedItem) return;
    const type = getSlotType(selectedItem);
    if (type === 'chest' || type === 'campfire' || type === 'furnace' || type === 'bed' || type === 'loom') {
        if (!chestSystem || !campfireSystem || !bedSystem) {
            return;
        }
        if (type === 'loom' && !loomSystem) return;
        
        // Use raycasting to find where player is looking (like block placement)
        const rc = new THREE.Raycaster();
        const origin = new THREE.Vector3();
        camera.getWorldPosition(origin);
        const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
        rc.set(origin, dir);
        const terrainChunks = Array.from(terrain.chunks.values());
        const colliders = [...mobSystem.getRaycastBlockers(), ...terrainChunks];
        
        const ints = rc.intersectObjects(colliders, true);
        
        if (ints.length === 0) {
            return;
        }
        
        const hit = ints[0];
        
        // Compute normal in world space
        let worldNormal = new THREE.Vector3();
        if (hit.face) {
            worldNormal.copy(hit.face.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
        } else {
            worldNormal.copy(dir).negate();
        }
        
        // Place on the surface the player is looking at
        const placePoint = hit.point.clone().add(worldNormal.multiplyScalar(0.51));
        const px = Math.floor(placePoint.x);
        const py = Math.floor(placePoint.y);
        const pz = Math.floor(placePoint.z);
        
        // Only consume the item if placement actually succeeded
        let placed = null;
        if (type === 'chest') placed = chestSystem.placeChest(px, py, pz);
        else if (type === 'campfire') placed = campfireSystem.placeCampfire(px, py, pz);
        else if (type === 'furnace' && furnaceSystem) placed = furnaceSystem.placeFurnace(px, py, pz);
        else if (type === 'bed') placed = bedSystem.placeBed(px, py, pz);
        else if (type === 'loom' && loomSystem) placed = loomSystem.placeLoom(px, py, pz);

        if (placed) {
            if (type === 'bed' && spawnPosition) {
                spawnPosition.set(placed.position.x, placed.position.y + 0.5, placed.position.z);
                showStatusMessage('Respawn point set to your bed');
            }
            if (!creativeMode && typeof selectedItem === 'object') {
                const newCount = getSlotCount(selectedItem) - 1;
                if (newCount > 0) hotbar[selectedHotbar] = createStackItem(type, newCount);
                else hotbar[selectedHotbar] = null;
            }
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
            updateHeldModelVisibility();
        }
        return;
    }
});
// Single place for pause toggle: close sub-UIs or toggle pause menu. Used by Escape key and by Electron IPC.
function handleGameTogglePause() {
    if (devConsoleOpen && devConsoleApi) {
        devConsoleApi.toggle();
        return;
    }
    if (settingsOverlayOpen) {
        settingsOverlayOpen = false;
        const settingsEl = document.getElementById('settingsOverlay');
        const pauseEl = document.getElementById('pauseOverlay');
        if (settingsEl) settingsEl.style.display = 'none';
        if (pauseEl) pauseEl.style.display = 'block';
        updateCursorForBackpack();
        return;
    }
    if (saveLoadOverlayOpen) {
        saveLoadOverlayOpen = false;
        const saveLoadEl = document.getElementById('saveLoadOverlay');
        const pauseEl = document.getElementById('pauseOverlay');
        if (saveLoadEl) saveLoadEl.style.display = 'none';
        if (pauseEl) pauseEl.style.display = 'block';
        updateCursorForBackpack();
        return;
    }
    if (referenceOverlayOpen) {
        referenceOverlayOpen = false;
        const refEl = document.getElementById('referenceOverlay');
        if (refEl) refEl.style.display = 'none';
        if (document.pointerLockElement !== canvas) {
            canvas.requestPointerLock().catch(() => {});
        }
        updateCursorForBackpack();
        return;
    }
    if (performanceOverlayOpen) {
        performanceOverlayOpen = false;
        const perfEl = document.getElementById('performanceOverlay');
        if (perfEl) perfEl.style.display = 'none';
        if (chunkOutlinesGroup && scene) scene.remove(chunkOutlinesGroup);
        return;
    }
    if (openCampfire) {
        closeCampfireUI();
        updateCursorForBackpack();
        return;
    }
    if (openFurnace) {
        closeFurnaceUI();
        updateCursorForBackpack();
        return;
    }
    if (openLoom) {
        closeLoomUI();
        updateCursorForBackpack();
        return;
    }
    if (openChest) {
        closeChestUI();
        updateCursorForBackpack();
        return;
    }
    if (craftingOpen) {
        craftingOpen = false;
        updateInventoryOverlay();
        updateCursorForBackpack();
        return;
    }
    if (backpackOpen) {
        backpackOpen = false;
        updateInventoryOverlay();
        updateCursorForBackpack();
        return;
    }
    // No UI open: toggle pause (one Escape = pause, next = unpause)
    gamePaused = !gamePaused;
    const pauseOverlay = document.getElementById('pauseOverlay');
    const pointerHint = document.getElementById('pointerHint');
    if (gamePaused) {
        if (document.pointerLockElement === canvas) {
            document.exitPointerLock();
        }
        document.body.classList.add('game-paused');
        if (pauseOverlay) pauseOverlay.style.display = 'block';
        if (pointerHint) pointerHint.style.display = 'none';
        updateCursorForBackpack();
        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
    } else {
        document.body.classList.remove('game-paused');
        if (pauseOverlay) pauseOverlay.style.display = 'none';
        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
        canvas.focus();
        if (document.pointerLockElement !== canvas) {
            canvas.requestPointerLock().catch(() => {});
        }
        if (typeof controls !== 'undefined' && controls && typeof controls.resetMovementState === 'function') {
            controls.resetMovementState();
        }
        updateCursorForBackpack();
    }
}

// Electron: main process intercepts Escape and sends IPC so the key never reaches the page (no pointer-lock exit).
if (typeof require !== 'undefined') {
    try {
        const { ipcRenderer } = require('electron');
        ipcRenderer.on('game-toggle-pause', handleGameTogglePause);
    } catch (_) {}
}

// Web fallback: capture Escape so we get it before the browser uses it to exit pointer lock
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    handleGameTogglePause();
}, true);

window.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
        e.preventDefault();
        referenceOverlayOpen = !referenceOverlayOpen;
        const refEl = document.getElementById('referenceOverlay');
        if (refEl) refEl.style.display = referenceOverlayOpen ? 'flex' : 'none';
        if (referenceOverlayOpen) {
            if (document.pointerLockElement === canvas) document.exitPointerLock();
        } else {
            if (document.pointerLockElement !== canvas) canvas.requestPointerLock().catch(() => {});
        }
        updateCursorForBackpack();
        return;
    }

    if (e.key === 'F3') {
        e.preventDefault();
        performanceOverlayOpen = !performanceOverlayOpen;
        const perfEl = document.getElementById('performanceOverlay');
        if (perfEl) perfEl.style.display = performanceOverlayOpen ? 'block' : 'none';
        if (!performanceOverlayOpen && chunkOutlinesGroup && scene) {
            scene.remove(chunkOutlinesGroup);
        }
        return;
    }

    if (devConsoleOpen) return;

    // Toggle creative/survival mode with "P" key (avoids conflict with movement WASD).
    // Does not open inventory/crafting — use E / C as in survival when you want those UIs.
    if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        creativeMode = !creativeMode;
        setCreativeModeUI(creativeMode);
        updateInventoryOverlay();
        return;
    }

    // Block other keys when paused or when reference overlay is open
    if (gamePaused || referenceOverlayOpen) return;

    // If pointer isn't locked (e.g. after unpause), lock it on first gameplay key so mouse look works without clicking
    const playing = !backpackOpen && !craftingOpen && !openChest && !openCampfire && !openFurnace && !openLoom && !devConsoleOpen;
    if (playing && document.pointerLockElement !== canvas) {
        const gameplayKey = ['w','a','s','d',' ','shift','1','2','3','4','5','6','7','8','9'].includes(e.key.toLowerCase());
        if (gameplayKey) {
            canvas.focus();
            canvas.requestPointerLock().catch(() => {});
        }
    }

    if (e.key === 'f' || e.key === 'F') {
        if (backpackOpen || craftingOpen || openChest || openCampfire || openFurnace || openLoom || devConsoleOpen) return;
        
        // Use raycasting to check what player is looking at
        const raycaster = new THREE.Raycaster();
        const origin = new THREE.Vector3();
        camera.getWorldPosition(origin);
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
        raycaster.set(origin, dir);
        
        const terrainChunks = Array.from(terrain.chunks.values());
        const chestMeshes = chestSystem ? chestSystem.chests : [];
        const campfireMeshes = campfireSystem ? campfireSystem.campfires : [];
        const furnaceMeshes = furnaceSystem ? furnaceSystem.furnaces : [];
        const loomMeshes = loomSystem ? loomSystem.looms : [];
        const bedMeshes = bedSystem ? bedSystem.beds : [];
        const treeMeshes = treeSystem ? treeSystem.trees : [];
        const colliders = [...mobSystem.getRaycastBlockers(), ...terrainChunks, ...chestMeshes, ...campfireMeshes, ...furnaceMeshes, ...loomMeshes, ...bedMeshes, ...treeMeshes];
        const ints = raycaster.intersectObjects(colliders, true);
        
        if (ints.length > 0) {
            let targetChest = null;
            let targetCampfire = null;
            let targetFurnace = null;
            let targetLoom = null;

            for (const hit of ints) {
                let obj = hit.object;
                while (obj && !obj.userData.isChest && !obj.userData.isCampfire && !obj.userData.isFurnace && !obj.userData.isLoom && !obj.userData.isTree && obj.parent) {
                    obj = obj.parent;
                }
                
                if (obj) {
                    if (obj.userData.isChest && chestSystem && !targetChest) {
                        targetChest = obj;
                    } else if (obj.userData.isCampfire && campfireSystem && !targetCampfire) {
                        targetCampfire = obj;
                    } else if (obj.userData.isFurnace && furnaceSystem && !targetFurnace) {
                        targetFurnace = obj;
                    } else if (obj.userData.isLoom && loomSystem && !targetLoom) {
                        targetLoom = obj;
                    }
                }
                if (targetChest || targetCampfire || targetFurnace || targetLoom) break;
            }

            // Check for chest interaction
            if (targetChest && chestSystem) {
                // Find the root chest mesh that chestSystem knows about
                let rootChest = targetChest;
                while (rootChest.parent && !chestSystem.chests.includes(rootChest)) {
                    rootChest = rootChest.parent;
                }

                openChest = rootChest;
                // Exit pointer lock when opening chest
                if (document.pointerLockElement === canvas) {
                    document.exitPointerLock();
                }
                // Get the inventory for this specific chest (will create if doesn't exist)
                let inventory = chestSystem.getInventory(rootChest);
                // Store reference to the chest mesh so we can save changes back
                window.currentChestMesh = rootChest;
                showChestUI(inventory);
                updateCursorForBackpack();
                return;
            }
            
            // Check for campfire interaction
            if (targetCampfire && campfireSystem) {
                let rootCampfire = targetCampfire;
                while (rootCampfire.parent && !campfireSystem.campfires.includes(rootCampfire)) rootCampfire = rootCampfire.parent;
                openCampfire = true;
                window.currentCampfireMesh = rootCampfire;
                showCampfireUI(rootCampfire);
                if (document.pointerLockElement === canvas) document.exitPointerLock();
                updateCursorForBackpack();
                return;
            }
            // Check for furnace interaction
            if (targetFurnace && furnaceSystem) {
                let rootFurnace = targetFurnace;
                while (rootFurnace.parent && !furnaceSystem.furnaces.includes(rootFurnace)) rootFurnace = rootFurnace.parent;
                openFurnace = true;
                window.currentFurnaceMesh = rootFurnace;
                showFurnaceUI(rootFurnace);
                if (document.pointerLockElement === canvas) document.exitPointerLock();
                updateCursorForBackpack();
                return;
            }
            // Check for loom interaction
            if (targetLoom && loomSystem) {
                let rootLoom = targetLoom;
                while (rootLoom.parent && !loomSystem.looms.includes(rootLoom)) rootLoom = rootLoom.parent;
                openLoom = true;
                window.currentLoomMesh = rootLoom;
                showLoomUI(rootLoom);
                if (document.pointerLockElement === canvas) document.exitPointerLock();
                updateCursorForBackpack();
                return;
            }
        }
    }
});
function showChestUI(inventory) {
    if (!Array.isArray(inventory)) {
        // Normalize to empty array if invalid
        inventory = new Array(CHEST_SLOTS).fill(null);
        // If we have a current chest mesh, save this new inventory to it
        if (window.currentChestMesh && chestSystem) {
            chestSystem.setInventory(window.currentChestMesh, inventory);
        }
    }
    // Expose current chest inventory globally so UI (ui.js) can interact with it
    window.currentChestInventory = inventory;
    updateInventoryOverlay();
    if (chestUI) chestUI.remove();
    chestUI = document.createElement('div');
    chestUI.id = 'chest-ui';
    chestUI.className = 'chest-panel-inventory';
    const chestTitle = document.createElement('h3');
    chestTitle.className = 'inventory-panel-title';
    chestTitle.textContent = 'Chest';
    chestUI.appendChild(chestTitle);
    const chestGrid = document.createElement('div');
    chestGrid.className = 'grid';
    for (let i = 0; i < inventory.length; i++) {
        const slot = document.createElement('div');
        slot.className = 'backpack-slot';
        slot.draggable = true;
        slot.dataset.index = i;
        const item = inventory[i];
        let label = '';
        let iconUrl = null;
        if (item) {
            const type = getSlotType(item);
            const count = getSlotCount(item);
            iconUrl = getItemIconUrl(type);
            label = `${getBlockName(type)} x${count}`;
        }
        if (iconUrl) {
            const img = document.createElement('img');
            img.className = 'item-icon';
            img.src = iconUrl;
            img.alt = '';
            img.onerror = () => { img.style.display = 'none'; };
            slot.appendChild(img);
        }
        const labelEl = document.createElement('div');
        labelEl.className = 'item-label';
        labelEl.textContent = label;
        slot.appendChild(labelEl);
        slot.addEventListener('dragstart', (ev) => {
            ev.dataTransfer.setData('text/plain', JSON.stringify({from:'chest',index:i,item:inventory[i]}));
        });
        slot.addEventListener('dragover', (ev) => { ev.preventDefault(); slot.classList.add('drag-over'); });
        slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
        slot.addEventListener('drop', (ev) => {
            ev.preventDefault();
            slot.classList.remove('drag-over');
            ev.preventDefault();
            const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
            const targetItem = inventory[i];

            if (data.from === 'backpack') {
                const draggedItem = data.item;
                const draggedType = getSlotType(draggedItem);
                const targetType = getSlotType(targetItem);
                if (draggedType === targetType && draggedType) {
                    const draggedCount = getSlotCount(draggedItem);
                    const targetCount = getSlotCount(targetItem);
                    const totalCount = draggedCount + targetCount;
                    if (totalCount <= 100) {
                        inventory[i] = createStackItem(draggedType, totalCount);
                        backpackSlots[data.index] = null;
                    } else {
                        inventory[i] = createStackItem(draggedType, 100);
                        backpackSlots[data.index] = createStackItem(draggedType, totalCount - 100);
                    }
                } else {
                    inventory[i] = draggedItem;
                    backpackSlots[data.index] = targetItem;
                }
            } else if (data.from === 'hotbar') {
                // Allow moving items from hotbar into chest
                const draggedItem = data.item;
                const draggedType = getSlotType(draggedItem);
                const targetType = getSlotType(targetItem);
                if (draggedType === targetType && draggedType) {
                    const draggedCount = getSlotCount(draggedItem);
                    const targetCount = getSlotCount(targetItem);
                    const totalCount = draggedCount + targetCount;
                    if (totalCount <= 100) {
                        inventory[i] = createStackItem(draggedType, totalCount);
                        hotbar[data.index] = null;
                    } else {
                        inventory[i] = createStackItem(draggedType, 100);
                        hotbar[data.index] = createStackItem(draggedType, totalCount - 100);
                    }
                } else {
                    inventory[i] = draggedItem;
                    hotbar[data.index] = targetItem;
                }
            } else if (data.from === 'chest') {
                // Swap between chest slots
                const draggedItem = data.item;
                inventory[i] = draggedItem;
                inventory[data.index] = targetItem;
            }

            // Save inventory changes back to the chest system
            if (window.currentChestMesh && chestSystem) {
                chestSystem.setInventory(window.currentChestMesh, inventory);
            }
            showChestUI(inventory);
            // Update both backpack and hotbar UIs because either might have changed
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            updateHeldModelVisibility();
        });
        chestGrid.appendChild(slot);
    }
    chestUI.appendChild(chestGrid);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'inventory-close-btn';
    closeBtn.textContent = 'Close chest';
    closeBtn.onclick = closeChestUI;
    chestUI.appendChild(closeBtn);

    // Attach chest UI inside the backpack modal so both appear as one combined UI
    const backpackEl2 = document.getElementById('backpack');
    if (backpackEl2) {
        backpackEl2.insertBefore(chestUI, backpackEl2.firstChild);
    } else {
        // Fallback: if backpack element is missing, attach to body
        document.body.appendChild(chestUI);
    }
}

function closeChestUI() {
    if (chestUI) chestUI.remove();
    chestUI = null;
    openChest = null;
    // Clear global chest inventory and mesh references
    window.currentChestInventory = null;
    window.currentChestMesh = null;
    updateInventoryOverlay();
    updateCursorForBackpack();
}

// Campfire UI: fuel slot, input slot, output slot, fuel bar, cook progress (live-update refs for timer text)
let furnaceUI = null;
let campfireFuelBarEl = null;
let campfireProgBarEl = null;
let furnaceFuelBarEl = null;
let furnaceProgBarEl = null;

const CAMPFIRE_COOK_TIME = 5;

function showCampfireUI(campfireMesh) {
    if (!campfireSystem || !campfireMesh) return;
    window.currentCampfireMesh = campfireMesh;
    updateInventoryOverlay();
    const backpackEl = document.getElementById('backpack');
    if (campfireUI) campfireUI.remove();
    const inv = campfireSystem.getCampfireInventory(campfireMesh) || [null, null, null, null];
    const fuelRemaining = campfireSystem.getFuelRemaining(campfireMesh) || 0;
    const cookProgress = campfireSystem.getCookProgress(campfireMesh) || 0;

    campfireUI = document.createElement('div');
    campfireUI.id = 'campfire-ui';
    campfireUI.className = 'craft-panel-inventory';
    campfireUI.style.cssText = 'position:relative;left:0;top:0;background:rgba(40,40,40,0.97);border:2px solid #fa7;padding:12px;margin-bottom:12px;z-index:1;display:flex;flex-direction:column;gap:8px;';
    const title = document.createElement('h3');
    title.className = 'inventory-panel-title';
    title.textContent = 'Campfire';
    campfireUI.appendChild(title);
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    const campfireSlotLabels = ['Fuel', 'Input (raw)', 'Output (cooked)', 'Coal'];
    campfireSlotLabels.forEach((label, idx) => {
        const col = document.createElement('div');
        col.style.display = 'flex';
        col.style.flexDirection = 'column';
        col.style.alignItems = 'center';
        const lab = document.createElement('span');
        lab.textContent = label;
        lab.style.cssText = 'color:#ccc;font-size:11px;margin-bottom:4px;';
        col.appendChild(lab);
        const slot = document.createElement('div');
        slot.className = 'backpack-slot';
        const isOutputSlot = idx >= 2;
        slot.draggable = true; // all slots draggable so output can be taken out
        slot.dataset.index = idx;
        const item = inv[idx];
        const labelText = item ? `${getBlockName(getSlotType(item))} x${getSlotCount(item)}` : '';
        const iconUrl = item ? getItemIconUrl(getSlotType(item)) : null;
        if (iconUrl) {
            const img = document.createElement('img');
            img.className = 'item-icon';
            img.src = iconUrl;
            img.alt = '';
            img.onerror = () => { img.style.display = 'none'; };
            slot.appendChild(img);
        }
        const labelEl = document.createElement('div');
        labelEl.className = 'item-label';
        labelEl.textContent = labelText;
        slot.appendChild(labelEl);
        slot.addEventListener('dragstart', (ev) => {
            if (!inv[idx]) return;
            ev.dataTransfer.setData('text/plain', JSON.stringify({ from: 'campfire', index: idx, item: inv[idx] }));
        });
        slot.addEventListener('dragover', (ev) => { ev.preventDefault(); if (!isOutputSlot) slot.classList.add('drag-over'); });
        slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
        slot.addEventListener('drop', (ev) => {
            ev.preventDefault();
            slot.classList.remove('drag-over');
            if (isOutputSlot) return;
            const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
            const targetItem = inv[idx];
            if (data.from === 'campfire' && data.index === idx) return;
            if (data.from === 'campfire') {
                inv[data.index] = targetItem;
                inv[idx] = data.item;
            } else if (data.from === 'backpack' || data.from === 'hotbar') {
                const dragged = data.item;
                const draggedType = getSlotType(dragged);
                const isFuel = getFuelBurnTime(draggedType) > 0;
                const isRawMeat = cookItem(draggedType) != null;
                if (idx === 0 && !isFuel) return;
                if (idx === 1 && !isRawMeat) return;
                if (targetItem && getSlotType(targetItem) === draggedType) {
                    const total = getSlotCount(targetItem) + getSlotCount(dragged);
                    inv[idx] = createStackItem(draggedType, Math.min(100, total));
                    if (data.from === 'backpack') backpackSlots[data.index] = total > 100 ? createStackItem(draggedType, total - 100) : null;
                    else hotbar[data.index] = total > 100 ? createStackItem(draggedType, total - 100) : null;
                } else {
                    inv[idx] = dragged;
                    if (data.from === 'backpack') backpackSlots[data.index] = targetItem;
                    else hotbar[data.index] = targetItem;
                }
            }
            campfireSystem.setCampfireInventory(campfireMesh, inv);
            showCampfireUI(campfireMesh);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
        });
        col.appendChild(slot);
        row.appendChild(col);
    });
    campfireUI.appendChild(row);
    const fuelBar = document.createElement('div');
    fuelBar.style.cssText = 'color:#aaa;font-size:12px;';
    fuelBar.textContent = `Fuel: ${fuelRemaining.toFixed(1)}s`;
    campfireUI.appendChild(fuelBar);
    campfireFuelBarEl = fuelBar;
    const progBar = document.createElement('div');
    progBar.style.cssText = 'color:#aaa;font-size:12px;';
    progBar.textContent = `Cooking: ${(cookProgress * 100 / CAMPFIRE_COOK_TIME).toFixed(0)}%`;
    campfireUI.appendChild(progBar);
    campfireProgBarEl = progBar;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'inventory-close-btn';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = closeCampfireUI;
    campfireUI.appendChild(closeBtn);
    if (backpackEl) backpackEl.insertBefore(campfireUI, backpackEl.firstChild);
    else document.body.appendChild(campfireUI);
}

function closeCampfireUI() {
    if (campfireUI) campfireUI.remove();
    campfireUI = null;
    campfireFuelBarEl = null;
    campfireProgBarEl = null;
    openCampfire = false;
    window.currentCampfireMesh = null;
    updateInventoryOverlay();
    updateCursorForBackpack();
}

const FURNACE_SMELT_TIME = 10;

function showFurnaceUI(furnaceMesh) {
    if (!furnaceSystem || !furnaceMesh) return;
    window.currentFurnaceMesh = furnaceMesh;
    updateInventoryOverlay();
    const backpackEl = document.getElementById('backpack');
    if (furnaceUI) furnaceUI.remove();
    const inv = furnaceSystem.getFurnaceInventory(furnaceMesh) || [null, null, null, null];
    const fuelRemaining = furnaceSystem.getFuelRemaining(furnaceMesh) || 0;
    const smeltProgress = furnaceSystem.getSmeltProgress(furnaceMesh) || 0;
    const isOn = typeof furnaceSystem.getFurnaceOn === 'function' ? furnaceSystem.getFurnaceOn(furnaceMesh) : false;

    furnaceUI = document.createElement('div');
    furnaceUI.id = 'furnace-ui';
    furnaceUI.className = 'craft-panel-inventory';
    furnaceUI.style.cssText = 'position:relative;left:0;top:0;background:rgba(40,40,50,0.97);border:2px solid #888;padding:12px;margin-bottom:12px;z-index:1;display:flex;flex-direction:column;gap:8px;';
    const title = document.createElement('h3');
    title.className = 'inventory-panel-title';
    title.textContent = 'Furnace';
    furnaceUI.appendChild(title);
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    ['Fuel', 'Input (ore)', 'Output (bars)', 'Coal'].forEach((label, idx) => {
        const col = document.createElement('div');
        col.style.display = 'flex';
        col.style.flexDirection = 'column';
        col.style.alignItems = 'center';
        const lab = document.createElement('span');
        lab.textContent = label;
        lab.style.cssText = 'color:#ccc;font-size:11px;margin-bottom:4px;';
        col.appendChild(lab);
        const slot = document.createElement('div');
        slot.className = 'backpack-slot';
        const isOutputSlot = idx >= 2;
        slot.draggable = true; // all slots draggable so output can be taken out
        slot.dataset.index = idx;
        const item = inv[idx];
        const labelText = item ? `${getBlockName(getSlotType(item))} x${getSlotCount(item)}` : '';
        const iconUrl = item ? getItemIconUrl(getSlotType(item)) : null;
        if (iconUrl) {
            const img = document.createElement('img');
            img.className = 'item-icon';
            img.src = iconUrl;
            img.alt = '';
            img.onerror = () => { img.style.display = 'none'; };
            slot.appendChild(img);
        }
        const labelEl = document.createElement('div');
        labelEl.className = 'item-label';
        labelEl.textContent = labelText;
        slot.appendChild(labelEl);
        slot.addEventListener('dragstart', (ev) => {
            if (!inv[idx]) return;
            ev.dataTransfer.setData('text/plain', JSON.stringify({ from: 'furnace', index: idx, item: inv[idx] }));
        });
        slot.addEventListener('dragover', (ev) => { ev.preventDefault(); if (!isOutputSlot) slot.classList.add('drag-over'); });
        slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
        slot.addEventListener('drop', (ev) => {
            ev.preventDefault();
            slot.classList.remove('drag-over');
            if (isOutputSlot) return;
            const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
            const targetItem = inv[idx];
            if (data.from === 'furnace' && data.index === idx) return;
            if (data.from === 'furnace') {
                inv[data.index] = targetItem;
                inv[idx] = data.item;
            } else if (data.from === 'backpack' || data.from === 'hotbar') {
                const dragged = data.item;
                const draggedType = getSlotType(dragged);
                const isFuel = getFuelBurnTime(draggedType) > 0;
                const isOre = smeltItem(draggedType) != null;
                if (idx === 0 && !isFuel) return;
                if (idx === 1 && !isOre) return;
                if (targetItem && getSlotType(targetItem) === draggedType) {
                    const total = getSlotCount(targetItem) + getSlotCount(dragged);
                    inv[idx] = createStackItem(draggedType, Math.min(100, total));
                    if (data.from === 'backpack') backpackSlots[data.index] = total > 100 ? createStackItem(draggedType, total - 100) : null;
                    else hotbar[data.index] = total > 100 ? createStackItem(draggedType, total - 100) : null;
                } else {
                    inv[idx] = dragged;
                    if (data.from === 'backpack') backpackSlots[data.index] = targetItem;
                    else hotbar[data.index] = targetItem;
                }
            }
            furnaceSystem.setFurnaceInventory(furnaceMesh, inv);
            showFurnaceUI(furnaceMesh);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
        });
        // Shift-click a furnace slot: move its contents back to backpack/hotbar
        slot.addEventListener('click', (ev) => {
            if (!ev.shiftKey) return;
            const item = inv[idx];
            if (!item) return;
            // Try to merge into existing backpack stacks of same type
            const type = getSlotType(item);
            let remaining = getSlotCount(item);
            for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
                const s = backpackSlots[i];
                if (s && getSlotType(s) === type) {
                    const canAdd = Math.min(100 - getSlotCount(s), remaining);
                    if (canAdd > 0) {
                        backpackSlots[i] = createStackItem(type, getSlotCount(s) + canAdd);
                        remaining -= canAdd;
                    }
                }
            }
            // Then into empty backpack slots
            for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
                if (!backpackSlots[i]) {
                    const add = Math.min(100, remaining);
                    backpackSlots[i] = createStackItem(type, add);
                    remaining -= add;
                }
            }
            // Finally into hotbar block slots (skip tool slots 0-1)
            for (let i = 2; i < hotbar.length && remaining > 0; i++) {
                const s = hotbar[i];
                if (s && getSlotType(s) === type) {
                    const canAdd = Math.min(100 - getSlotCount(s), remaining);
                    if (canAdd > 0) {
                        hotbar[i] = createStackItem(type, getSlotCount(s) + canAdd);
                        remaining -= canAdd;
                    }
                }
            }
            for (let i = 2; i < hotbar.length && remaining > 0; i++) {
                if (!hotbar[i]) {
                    const add = Math.min(100, remaining);
                    hotbar[i] = createStackItem(type, add);
                    remaining -= add;
                }
            }
            if (remaining <= 0) {
                inv[idx] = null;
            } else {
                inv[idx] = createStackItem(type, remaining);
            }
            furnaceSystem.setFurnaceInventory(furnaceMesh, inv);
            showFurnaceUI(furnaceMesh);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
        });
        col.appendChild(slot);
        row.appendChild(col);
    });
    furnaceUI.appendChild(row);
    const fuelBar = document.createElement('div');
    fuelBar.style.cssText = 'color:#aaa;font-size:12px;';
    fuelBar.textContent = `Fuel: ${fuelRemaining.toFixed(1)}s`;
    furnaceUI.appendChild(fuelBar);
    furnaceFuelBarEl = fuelBar;
    const progBar = document.createElement('div');
    progBar.style.cssText = 'color:#aaa;font-size:12px;';
    progBar.textContent = `Smelting: ${(smeltProgress * 100 / FURNACE_SMELT_TIME).toFixed(0)}%`;
    furnaceUI.appendChild(progBar);
    furnaceProgBarEl = progBar;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'inventory-close-btn';
    toggleBtn.textContent = isOn ? 'Turn off' : 'Turn on';
    toggleBtn.onclick = () => {
        if (!furnaceSystem) return;
        if (typeof furnaceSystem.setFurnaceOn === 'function') {
            furnaceSystem.setFurnaceOn(furnaceMesh, !isOn);
        } else {
            furnaceMesh.userData.furnaceOn = !isOn;
        }
        showFurnaceUI(furnaceMesh);
    };
    furnaceUI.appendChild(toggleBtn);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'inventory-close-btn';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = closeFurnaceUI;
    furnaceUI.appendChild(closeBtn);
    if (backpackEl) backpackEl.insertBefore(furnaceUI, backpackEl.firstChild);
    else document.body.appendChild(furnaceUI);
}

function closeFurnaceUI() {
    if (furnaceUI) furnaceUI.remove();
    furnaceUI = null;
    furnaceFuelBarEl = null;
    furnaceProgBarEl = null;
    openFurnace = false;
    window.currentFurnaceMesh = null;
    updateInventoryOverlay();
    updateCursorForBackpack();
}

const LOOM_PROCESS_TIME = 4;

let loomProgBarEl = null;

function showLoomUI(loomMesh) {
    if (!loomSystem || !loomMesh) return;
    window.currentLoomMesh = loomMesh;
    updateInventoryOverlay();
    const backpackEl = document.getElementById('backpack');
    if (loomUI) loomUI.remove();
    const inv = loomSystem.getLoomInventory(loomMesh) || [null, null];
    const progress = loomSystem.getLoomProgress(loomMesh) || 0;

    loomUI = document.createElement('div');
    loomUI.id = 'loom-ui';
    loomUI.className = 'craft-panel-inventory';
    loomUI.style.cssText = 'position:relative;left:0;top:0;background:rgba(50,45,40,0.97);border:2px solid #a08060;padding:12px;margin-bottom:12px;z-index:1;display:flex;flex-direction:column;gap:8px;';
    const title = document.createElement('h3');
    title.className = 'inventory-panel-title';
    title.textContent = 'Loom';
    loomUI.appendChild(title);
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    ['Wool (input)', 'String (output)'].forEach((label, idx) => {
        const col = document.createElement('div');
        col.style.display = 'flex';
        col.style.flexDirection = 'column';
        col.style.alignItems = 'center';
        const lab = document.createElement('span');
        lab.textContent = label;
        lab.style.cssText = 'color:#ccc;font-size:11px;margin-bottom:4px;';
        col.appendChild(lab);
        const slot = document.createElement('div');
        slot.className = 'backpack-slot';
        const isOutputSlot = idx === 1;
        slot.draggable = !isOutputSlot;
        slot.dataset.index = idx;
        const item = inv[idx];
        const labelText = item ? `${getBlockName(getSlotType(item))} x${getSlotCount(item)}` : '';
        const iconUrl = item ? getItemIconUrl(getSlotType(item)) : null;
        if (iconUrl) {
            const img = document.createElement('img');
            img.className = 'item-icon';
            img.src = iconUrl;
            img.alt = '';
            img.onerror = () => { img.style.display = 'none'; };
            slot.appendChild(img);
        }
        const labelEl = document.createElement('div');
        labelEl.className = 'item-label';
        labelEl.textContent = labelText;
        slot.appendChild(labelEl);
        slot.addEventListener('dragstart', (ev) => {
            if (!inv[idx]) return;
            ev.dataTransfer.setData('text/plain', JSON.stringify({ from: 'loom', index: idx, item: inv[idx] }));
        });
        slot.addEventListener('dragover', (ev) => { ev.preventDefault(); if (!isOutputSlot) slot.classList.add('drag-over'); });
        slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
        slot.addEventListener('drop', (ev) => {
            ev.preventDefault();
            slot.classList.remove('drag-over');
            if (isOutputSlot) return;
            const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
            const targetItem = inv[idx];
            if (data.from === 'loom' && data.index === idx) return;
            if (data.from === 'loom') {
                inv[data.index] = targetItem;
                inv[idx] = data.item;
            } else if (data.from === 'backpack' || data.from === 'hotbar') {
                const dragged = data.item;
                const draggedType = getSlotType(dragged);
                if (idx === 0 && draggedType !== 'wool') return;
                if (targetItem && getSlotType(targetItem) === draggedType) {
                    const total = getSlotCount(targetItem) + getSlotCount(dragged);
                    inv[idx] = createStackItem(draggedType, Math.min(100, total));
                    if (data.from === 'backpack') backpackSlots[data.index] = total > 100 ? createStackItem(draggedType, total - 100) : null;
                    else hotbar[data.index] = total > 100 ? createStackItem(draggedType, total - 100) : null;
                } else {
                    inv[idx] = dragged;
                    if (data.from === 'backpack') backpackSlots[data.index] = targetItem;
                    else hotbar[data.index] = targetItem;
                }
            }
            loomSystem.setLoomInventory(loomMesh, inv);
            showLoomUI(loomMesh);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
        });
        col.appendChild(slot);
        row.appendChild(col);
    });
    loomUI.appendChild(row);
    const progBar = document.createElement('div');
    progBar.style.cssText = 'color:#aaa;font-size:12px;';
    progBar.textContent = `Spinning: ${(progress * 100 / LOOM_PROCESS_TIME).toFixed(0)}%`;
    loomUI.appendChild(progBar);
    loomProgBarEl = progBar;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'inventory-close-btn';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = closeLoomUI;
    loomUI.appendChild(closeBtn);
    if (backpackEl) backpackEl.insertBefore(loomUI, backpackEl.firstChild);
    else document.body.appendChild(loomUI);
}

function closeLoomUI() {
    if (loomUI) loomUI.remove();
    loomUI = null;
    loomProgBarEl = null;
    openLoom = false;
    window.currentLoomMesh = null;
    updateInventoryOverlay();
    updateCursorForBackpack();
}

// Expose chest UI helper so inventory UI can re-render chest when items move
window.showChestUI = showChestUI;
import { showPickupNotification, showStatusMessage, renderHotbar, renderBackpack, renderEquipment, updateCompass, updateClock, updateCoords, updateLookAtCard } from './ui/ui.js';
// walls system removed; mobs handle entities now
import { createMobSystem } from './systems/mobs.js';

// Shift+click: move stack from backpack to hotbar (first empty or merge)
function tryShiftClickToHotbar(backpackIndex) {
    const item = backpackSlots[backpackIndex];
    if (!item) return false;
    const type = getSlotType(item);
    const count = getSlotCount(item);
    for (let i = 0; i < hotbar.length; i++) {
        const slot = hotbar[i];
        if (!slot) {
            hotbar[i] = createStackItem(type, count);
            backpackSlots[backpackIndex] = null;
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
            updateHeldModelVisibility();
            return true;
        }
        if (getSlotType(slot) === type) {
            const total = getSlotCount(slot) + count;
            hotbar[i] = createStackItem(type, Math.min(100, total));
            backpackSlots[backpackIndex] = total > 100 ? createStackItem(type, total - 100) : null;
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
            updateHeldModelVisibility();
            return true;
        }
    }
    return false;
}

// Shift+click: move stack from hotbar to backpack (first empty or merge)
function tryShiftClickToBackpack(hotbarIndex) {
    const item = hotbar[hotbarIndex];
    if (!item) return false;
    const type = getSlotType(item);
    const count = getSlotCount(item);
    for (let i = 0; i < backpackSlots.length; i++) {
        const slot = backpackSlots[i];
        if (!slot) {
            backpackSlots[i] = createStackItem(type, count);
            hotbar[hotbarIndex] = null;
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
            updateHeldModelVisibility();
            return true;
        }
        if (getSlotType(slot) === type) {
            const total = getSlotCount(slot) + count;
            backpackSlots[i] = createStackItem(type, Math.min(100, total));
            hotbar[hotbarIndex] = total > 100 ? createStackItem(type, total - 100) : null;
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
            updateHeldModelVisibility();
            return true;
        }
    }
    return false;
}

// Shift+click: move from backpack/hotbar into campfire (fuel or input slot only)
function tryShiftClickToCampfire(from, index) {
    if (!openCampfire || !window.currentCampfireMesh || !campfireSystem) return false;
    const item = from === 'backpack' ? backpackSlots[index] : hotbar[index];
    if (!item) return false;
    const type = getSlotType(item);
    const count = getSlotCount(item);
    const inv = campfireSystem.getCampfireInventory(window.currentCampfireMesh) || [null, null, null, null];
    const isFuel = getFuelBurnTime(type) > 0;
    const isRawMeat = cookItem(type) != null;
    if (isFuel) {
        const target = inv[0];
        if (!target) {
            inv[0] = createStackItem(type, count);
            if (from === 'backpack') backpackSlots[index] = null; else hotbar[index] = null;
        } else if (getSlotType(target) === type) {
            const total = getSlotCount(target) + count;
            inv[0] = createStackItem(type, Math.min(100, total));
            if (from === 'backpack') backpackSlots[index] = total > 100 ? createStackItem(type, total - 100) : null; else hotbar[index] = total > 100 ? createStackItem(type, total - 100) : null;
        } else return false;
        campfireSystem.setCampfireInventory(window.currentCampfireMesh, inv);
        showCampfireUI(window.currentCampfireMesh);
        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
        renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
        updateHeldModelVisibility();
        return true;
    }
    if (isRawMeat) {
        const target = inv[1];
        if (!target) {
            inv[1] = createStackItem(type, count);
            if (from === 'backpack') backpackSlots[index] = null; else hotbar[index] = null;
        } else if (getSlotType(target) === type) {
            const total = getSlotCount(target) + count;
            inv[1] = createStackItem(type, Math.min(100, total));
            if (from === 'backpack') backpackSlots[index] = total > 100 ? createStackItem(type, total - 100) : null; else hotbar[index] = total > 100 ? createStackItem(type, total - 100) : null;
        } else return false;
        campfireSystem.setCampfireInventory(window.currentCampfireMesh, inv);
        showCampfireUI(window.currentCampfireMesh);
        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
        renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
        updateHeldModelVisibility();
        return true;
    }
    return false;
}

// Shift+click: move from backpack/hotbar into furnace (fuel or input slot only)
function tryShiftClickToFurnace(from, index) {
    if (!openFurnace || !window.currentFurnaceMesh || !furnaceSystem) return false;
    const item = from === 'backpack' ? backpackSlots[index] : hotbar[index];
    if (!item) return false;
    const type = getSlotType(item);
    const count = getSlotCount(item);
    const inv = furnaceSystem.getFurnaceInventory(window.currentFurnaceMesh) || [null, null, null, null];
    const isFuel = getFuelBurnTime(type) > 0;
    const isOre = smeltItem(type) != null;
    if (isFuel) {
        const target = inv[0];
        if (!target) {
            inv[0] = createStackItem(type, count);
            if (from === 'backpack') backpackSlots[index] = null; else hotbar[index] = null;
        } else if (getSlotType(target) === type) {
            const total = getSlotCount(target) + count;
            inv[0] = createStackItem(type, Math.min(100, total));
            if (from === 'backpack') backpackSlots[index] = total > 100 ? createStackItem(type, total - 100) : null; else hotbar[index] = total > 100 ? createStackItem(type, total - 100) : null;
        } else return false;
        furnaceSystem.setFurnaceInventory(window.currentFurnaceMesh, inv);
        showFurnaceUI(window.currentFurnaceMesh);
        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
        renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
        updateHeldModelVisibility();
        return true;
    }
    if (isOre) {
        const target = inv[1];
        if (!target) {
            inv[1] = createStackItem(type, count);
            if (from === 'backpack') backpackSlots[index] = null; else hotbar[index] = null;
        } else if (getSlotType(target) === type) {
            const total = getSlotCount(target) + count;
            inv[1] = createStackItem(type, Math.min(100, total));
            if (from === 'backpack') backpackSlots[index] = total > 100 ? createStackItem(type, total - 100) : null; else hotbar[index] = total > 100 ? createStackItem(type, total - 100) : null;
        } else return false;
        furnaceSystem.setFurnaceInventory(window.currentFurnaceMesh, inv);
        showFurnaceUI(window.currentFurnaceMesh);
        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
        renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
        updateHeldModelVisibility();
        return true;
    }
    return false;
}

// Shift+click: move from backpack/hotbar into loom (wool input only)
function tryShiftClickToLoom(from, index) {
    if (!openLoom || !window.currentLoomMesh || !loomSystem) return false;
    const item = from === 'backpack' ? backpackSlots[index] : hotbar[index];
    if (!item) return false;
    const type = getSlotType(item);
    if (type !== 'wool') return false;
    const count = getSlotCount(item);
    const inv = loomSystem.getLoomInventory(window.currentLoomMesh) || [null, null];
    const target = inv[0];
    if (!target) {
        inv[0] = createStackItem('wool', count);
        if (from === 'backpack') backpackSlots[index] = null; else hotbar[index] = null;
    } else if (getSlotType(target) === 'wool') {
        const total = getSlotCount(target) + count;
        inv[0] = createStackItem('wool', Math.min(100, total));
        if (from === 'backpack') backpackSlots[index] = total > 100 ? createStackItem('wool', total - 100) : null; else hotbar[index] = total > 100 ? createStackItem('wool', total - 100) : null;
    } else return false;
    loomSystem.setLoomInventory(window.currentLoomMesh, inv);
    showLoomUI(window.currentLoomMesh);
    renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
    renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
    updateHeldModelVisibility();
    return true;
}

// Shift+click: move from backpack/hotbar into chest
function tryShiftClickToChest(from, index) {
    const chestInv = window.currentChestInventory;
    if (!openChest || !Array.isArray(chestInv)) return false;
    const item = from === 'backpack' ? backpackSlots[index] : hotbar[index];
    if (!item) return false;
    const type = getSlotType(item);
    const count = getSlotCount(item);
    for (let i = 0; i < chestInv.length; i++) {
        const slot = chestInv[i];
        if (!slot) {
            chestInv[i] = createStackItem(type, count);
            if (from === 'backpack') backpackSlots[index] = null; else hotbar[index] = null;
            if (window.currentChestMesh && chestSystem) chestSystem.setInventory(window.currentChestMesh, chestInv);
            showChestUI(chestInv);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
            updateHeldModelVisibility();
            return true;
        }
        if (getSlotType(slot) === type) {
            const total = getSlotCount(slot) + count;
            chestInv[i] = createStackItem(type, Math.min(100, total));
            if (from === 'backpack') backpackSlots[index] = total > 100 ? createStackItem(type, total - 100) : null; else hotbar[index] = total > 100 ? createStackItem(type, total - 100) : null;
            if (window.currentChestMesh && chestSystem) chestSystem.setInventory(window.currentChestMesh, chestInv);
            showChestUI(chestInv);
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar);
            updateHeldModelVisibility();
            return true;
        }
    }
    return false;
}

window.tryShiftClickToHotbar = tryShiftClickToHotbar;
window.tryShiftClickToBackpack = tryShiftClickToBackpack;
window.tryShiftClickToCampfire = tryShiftClickToCampfire;
window.tryShiftClickToFurnace = tryShiftClickToFurnace;
window.tryShiftClickToLoom = tryShiftClickToLoom;
window.tryShiftClickToChest = tryShiftClickToChest;
window.showLoomUI = showLoomUI;

// Player horizontal radius for overlap checks (must match collision logic)
const PLAYER_RADIUS = 0.35;
// Leaves (5) are non-solid for overlap so the player can walk under trees.
const LEAVES_BLOCK_ID = 5;
function isPlayerOverlapping(x, z, y) {
    const minPx = Math.floor(x - PLAYER_RADIUS);
    const maxPx = Math.floor(x + PLAYER_RADIUS);
    const minPz = Math.floor(z - PLAYER_RADIUS);
    const maxPz = Math.floor(z + PLAYER_RADIUS);
    const minY = Math.floor(y + 0.05);
    const maxY = Math.floor(y + playerHeight - 0.05);
    for (let px = minPx; px <= maxPx; px++) {
        for (let pz = minPz; pz <= maxPz; pz++) {
            for (let yy = minY; yy <= maxY; yy++) {
                const v = terrain.getVoxelAt(px, yy, pz);
                if (v && v !== LEAVES_BLOCK_ID) return true;
            }
        }
    }
    return false;
}

// If the player ends up embedded in terrain (inside walls or corners, not just
// standing on the ground), snap them up to the top surface in their current
// footprint. This is a safety net for edge/corner cases where collision
// resolution lets the capsule slip slightly into blocks.
function snapPlayerOutOfTerrainIfEmbedded() {
    if (!terrain || !terrain.getVoxelAt) return;
    const x = player.position.x;
    const y = player.position.y;
    const z = player.position.z;

    const minPx = Math.floor(x - PLAYER_RADIUS);
    const maxPx = Math.floor(x + PLAYER_RADIUS);
    const minPz = Math.floor(z - PLAYER_RADIUS);
    const maxPz = Math.floor(z + PLAYER_RADIUS);
    const minY = Math.floor(y + 0.05);
    const maxY = Math.floor(y + playerHeight - 0.05);

    let embedded = false;
    for (let px = minPx; px <= maxPx && !embedded; px++) {
        for (let pz = minPz; pz <= maxPz && !embedded; pz++) {
            for (let yy = minY; yy <= maxY; yy++) {
                const v = terrain.getVoxelAt(px, yy, pz);
                if (v && v !== LEAVES_BLOCK_ID) {
                    embedded = true;
                    break;
                }
            }
        }
    }
    if (!embedded) return;

    // Find the highest solid surface in the player's horizontal footprint.
    const height = terrain.height || 64;
    let bestTopY = null;
    for (let px = minPx; px <= maxPx; px++) {
        for (let pz = minPz; pz <= maxPz; pz++) {
            for (let yy = height - 1; yy >= 0; yy--) {
                const v = terrain.getVoxelAt(px, yy, pz);
                if (v && v !== LEAVES_BLOCK_ID) {
                    const topY = yy + 1;
                    if (bestTopY === null || topY > bestTopY) {
                        bestTopY = topY;
                    }
                    break;
                }
            }
        }
    }
    if (bestTopY == null) return;

    const safeY = bestTopY + 0.001;
    player.position.y = safeY;
    if (controls && typeof controls.notifyTeleported === 'function') {
        controls.notifyTeleported(safeY);
    }
}

// True only when the player's feet are embedded in ground (not when standing on top, and not when under a ceiling — pushing up would hit ceiling / teleport to surface).
function isPlayerStuckInGround(x, z, y) {
    const blockY = Math.floor(y);
    const intoBlock = y - blockY;
    if (intoBlock <= 0.02) return false; // standing on top of block below
    const minPx = Math.floor(x - PLAYER_RADIUS);
    const maxPx = Math.floor(x + PLAYER_RADIUS);
    const minPz = Math.floor(z - PLAYER_RADIUS);
    const maxPz = Math.floor(z + PLAYER_RADIUS);
    // If there's a solid block above our feet (ceiling), don't unstuck — we'd push into it / get sent to surface
    for (let px = minPx; px <= maxPx; px++) {
        for (let pz = minPz; pz <= maxPz; pz++) {
            if (terrain.getVoxelAt(px, blockY + 1, pz) && terrain.getVoxelAt(px, blockY + 1, pz) !== LEAVES_BLOCK_ID) return false;
        }
    }
    for (let px = minPx; px <= maxPx; px++) {
        for (let pz = minPz; pz <= maxPz; pz++) {
            const v = terrain.getVoxelAt(px, blockY, pz);
            if (v && v !== LEAVES_BLOCK_ID) return true;
        }
    }
    return false;
}

// Define spawn position (center of chunk 0,0, at terrain surface)
let spawnX = 0, spawnZ = 0;
// Temporary position until atlas is ready (avoids creating chunk 0,0 before textures load)
player.position.set(spawnX, 50, spawnZ);

// Last known "safe" position on solid ground (used to recover from
// streaming/void glitches similar to Minecraft's safe-chunk fallback).
let lastSafeChunkPosition = null;

function updateLastSafeChunkPosition() {
    if (!terrain || !terrain.getWalkableSurfaceYAt || !player) return;
    const x = player.position.x;
    const z = player.position.z;
    const groundY = terrain.getWalkableSurfaceYAt(x, z);
    // getWalkableSurfaceYAt returns 0 when there's no voxel data; treat that
    // as non-safe if we're far above it so we don't mark mid-air as safe.
    const desiredY = groundY + 1.001;
    const dy = Math.abs(player.position.y - desiredY);
    if (dy > 1.5) return;
    if (!lastSafeChunkPosition) {
        lastSafeChunkPosition = new THREE.Vector3(x, desiredY, z);
    } else {
        lastSafeChunkPosition.set(x, desiredY, z);
    }
}

function findSafeSpawnYAt(x, z) {
    // Find the top solid block at (x,z)
    let surfaceY = terrain.getSurfaceYAt(x, z);
    if (surfaceY < 0) {
        for (let y = (terrain.height || 16) - 1; y >= 0; y--) {
            if (terrain.getVoxelAt(Math.floor(x), y, Math.floor(z)) !== 0) {
                surfaceY = y;
                break;
            }
        }
        if (surfaceY < 0) surfaceY = 0;
    }
    // Start a bit above the surface so feet are clear of the block
    let startY = surfaceY + 1.5;
    let attempts = 0;
    while (isPlayerOverlapping(x, z, startY) && attempts < 20) {
        startY += 0.5;
        attempts++;
    }
    return startY;
}

function placePlayerAtSpawn(x, z) {
    const safeY = findSafeSpawnYAt(x, z);
    player.position.set(x, safeY, z);
    if (!defaultSpawnPosition) {
        defaultSpawnPosition = new THREE.Vector3(x, safeY, z);
    }
    if (!spawnPosition) {
        spawnPosition = new THREE.Vector3(x, safeY, z);
    } else {
        spawnPosition.set(x, safeY, z);
    }
}

// Pre-load every chunk within render distance so nothing loads after the game is shown (smooth start).
async function ensureSpawnChunksGenerated() {
    const rd = typeof terrain.getRenderDistance === 'function' ? terrain.getRenderDistance() : (terrain.renderDistance ?? 2);
    const total = (rd * 2 + 1) * (rd * 2 + 1);
    let done = 0;

    // Ensure we can show progress while generating chunks.
    const yieldToBrowser = () => new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 0);
    });

    // Use time-based throttling so we don't spam DOM updates.
    let lastUiUpdateMs = 0;
    const UI_UPDATE_EVERY_MS = 120;

    for (let cx = -rd; cx <= rd; cx++) {
        for (let cz = -rd; cz <= rd; cz++) {
            terrain.generateChunk(cx, cz);
            done++;

            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (done === total || done % 4 === 0 || now - lastUiUpdateMs >= UI_UPDATE_EVERY_MS) {
                lastUiUpdateMs = now;
                setLoadingStatus(`Generating chunks: ${done}/${total}`, 0);
                if (loadingBarFillEl) {
                    const pct = (done / Math.max(1, total)) * 100;
                    loadingBarFillEl.style.width = `${pct}%`;
                }
                await yieldToBrowser();
            }
        }
    }
}

function runSpawnInit() {
    // Run only after terrain atlas has loaded and spawn chunks exist
    placePlayerAtSpawn(spawnX, spawnZ);
}

/**
 * Start a brand new world (no page reload).
 * Clears voxel modifications, mobs, item drops, trees state, and regenerates spawn chunks.
 */
async function startNewWorld() {
    // Close any sub-UIs that might keep pointer unlocked / block input.
    backpackOpen = false;
    craftingOpen = false;
    openChest = null;
    openCampfire = false;
    openFurnace = false;
    openLoom = false;
    settingsOverlayOpen = false;
    referenceOverlayOpen = false;
    saveLoadOverlayOpen = false;
    performanceOverlayOpen = false;
    updateInventoryOverlay();

    // Remove any mounted UI elements
    if (chestUI) { chestUI.remove(); chestUI = null; }
    if (campfireUI) { campfireUI.remove(); campfireUI = null; }
    if (furnaceUI) { furnaceUI.remove(); furnaceUI = null; }
    if (loomUI) { loomUI.remove(); loomUI = null; }

    // Clear dynamic systems first
    if (itemDropSystem && typeof itemDropSystem.clearAll === 'function') {
        itemDropSystem.clearAll();
    }
    if (mobSystem && typeof mobSystem.clearAll === 'function') {
        mobSystem.clearAll();
    }
    if (treeSystem && typeof treeSystem.restoreFromSave === 'function') {
        // Passing an empty object clears stump/sapling state.
        treeSystem.restoreFromSave({});
    }

    // Unload all currently loaded chunks so system.onChunkUnload removes their meshes.
    if (terrain && terrain.chunks && terrain.chunks.size > 0) {
        for (const key of Array.from(terrain.chunks.keys())) {
            const [cx, cz] = key.split(',').map(Number);
            terrain.unloadChunk(cx, cz);
        }
    }

    // Clear voxel edits so terrain regenerates from scratch.
    if (terrain && typeof terrain.getVoxelData === 'function') {
        const voxelData = terrain.getVoxelData();
        if (voxelData && typeof voxelData.clear === 'function') voxelData.clear();
    }

    // Ensure we do normal tree generation in the terrain wrapper.
    terrain._skipTreeGeneration = false;

    // Reset player position and safety tracking.
    lastSafeChunkPosition = null;
    spawnPosition = null;
    defaultSpawnPosition = null;

    // Choose a new spawn X/Z so each "New World" feels different even with same seed.
    // Use a reasonably large radius in world units.
    const SPAWN_RADIUS = 512;
    spawnX = (Math.random() * 2 - 1) * SPAWN_RADIUS;
    spawnZ = (Math.random() * 2 - 1) * SPAWN_RADIUS;
    player.position.set(spawnX, 50, spawnZ);

    playerHealth = getCurrentMaxHealth();
    updateHealthBar(playerHealth, getCurrentMaxHealth());
    if (controls && typeof controls.resetMovementState === 'function') {
        controls.resetMovementState();
    }

    // Show loading overlay and regenerate terrain around the new spawn, same flow as initial startup.
    showLoadingOverlay();
    setLoadingStatus('Generating terrain around spawn', 0);
    terrainAtlasReady = false;

    await ensureSpawnChunksGenerated();
    setLoadingStatus('Finding safe spawn point', 0);
    runSpawnInit();
    setLoadingStatus('Warming up world', 1);
    terrainAtlasReady = true;

    // Ensure the HUD reflects the current item selection.
    renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
    updateCursorForBackpack();

    // Keep loading screen up briefly so chunks/physics settle, then hide and relock pointer.
    setTimeout(() => {
        hideLoadingOverlay();
        if (document.pointerLockElement !== canvas) {
            canvas.requestPointerLock().catch(() => {});
        }
    }, LOADING_SETTLE_MS);
}

// --- Lighting ---
const lighting = createLighting(scene);

// --- Backpack UI State ---
// backpackOpen already declared above
// Toggle backpack UI with 'E' key
window.addEventListener('keydown', (e) => {
    if (gamePaused) return; // Block when paused (except Escape handled separately)
    if (devConsoleOpen) return;
    // E: toggle backpack (inventory only)
    if ((e.key === 'e' || e.key === 'E') && !openChest) {
        backpackOpen = !backpackOpen;
        updateInventoryOverlay();
        if (backpackOpen && document.pointerLockElement === canvas) {
            document.exitPointerLock();
        }
        updateCursorForBackpack();
        e.preventDefault();
        return;
    }
    // C: toggle crafting (crafting panel + backpack)
    if ((e.key === 'c' || e.key === 'C') && !openChest) {
        craftingOpen = !craftingOpen;
        updateInventoryOverlay();
        if (craftingOpen && document.pointerLockElement === canvas) {
            document.exitPointerLock();
        }
        updateCursorForBackpack();
        e.preventDefault();
        return;
    }
    // Hotbar number keys (1-9)
    if (!backpackOpen && !craftingOpen && e.key >= '1' && e.key <= '9') {
        setSelectedHotbar(parseInt(e.key, 10) - 1);
        e.preventDefault();
        return;
    }
});

// Hotbar scroll (mouse wheel)
window.addEventListener('wheel', (e) => {
    if (gamePaused) return; // Block when paused
    if (backpackOpen || craftingOpen || devConsoleOpen) return;
    if (e.deltaY < 0) {
        setSelectedHotbar((selectedHotbar - 1 + hotbar.length) % hotbar.length);
    } else if (e.deltaY > 0) {
        setSelectedHotbar((selectedHotbar + 1) % hotbar.length);
    }
    // Sync selectedHotbar to ui.js
    window.selectedHotbar = selectedHotbar;
    e.preventDefault();
}, { passive: false });

// --- Controls ---
// Block movement when any main UI is open (backpack, chest, or campfire) or game is paused
const controls = setupControls(
    player,
    camera,
    canvas,
    terrain,
    () => backpackOpen || craftingOpen || openChest || openCampfire || openFurnace || openLoom || devConsoleOpen || referenceOverlayOpen,
    () => gamePaused,
    takeDamage,
    mobSystem,
    () => treeSystem
);

// --- Sky ---
const sky = createSky(scene, camera, undefined, lighting);

const weatherEffects = createWeatherEffects(scene, (target) => camera.getWorldPosition(target), updateDistanceFog);

devConsoleApi = createDevConsole({
    scene,
    player,
    sky,
    terrain,
    mobSystem,
    weatherEffects,
    placePlayerAtSpawn,
    onOpenChange(v) {
        devConsoleOpen = !!v;
        updateCursorForBackpack();
    },
});

getSkyTimeRef = () => sky.getTime();
const _camDir = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _toHead = new THREE.Vector3();
getIsInPlayerViewRef = (worldPos) => {
    camera.getWorldPosition(_camPos);
    const dist = _camPos.distanceTo(worldPos);
    if (dist >= 40) return false;
    _camDir.copy(worldPos).sub(_camPos).normalize();
    camera.getWorldDirection(_camForward);
    return _camDir.dot(_camForward) > 0.2;
};

// --- Save / Load ---
function buildSaveState() {
    const voxelData = terrain.getVoxelData();
    const terrainObj = {};
    for (const [key, vox] of voxelData.entries()) {
        if (vox && Array.isArray(vox)) {
            terrainObj[key] = vox;
        }
    }
    return {
        player: {
            x: player.position.x,
            y: player.position.y,
            z: player.position.z,
            yaw: player.rotation.y,
            pitch: camera.rotation.x,
            health: playerHealth,
            stamina: typeof player.userData.stamina === 'number' ? player.userData.stamina : 1,
        },
        spawnPosition: spawnPosition ? { x: spawnPosition.x, y: spawnPosition.y, z: spawnPosition.z } : null,
        hotbar: hotbar.map((item) => (item == null ? null : { type: getSlotType(item), count: getSlotCount(item) })),
        backpack: backpackSlots.map((item) => (item == null ? null : { type: getSlotType(item), count: getSlotCount(item) })),
        equipment: (() => {
            const toSave = (item) => (item == null ? null : { type: getSlotType(item), count: getSlotCount(item) });
            return {
                head: toSave(getEquippedHead()),
                body: toSave(getEquippedBody()),
                legs: toSave(getEquippedLegs()),
                feet: toSave(getEquippedFeet()),
                ring1: toSave(getEquippedRing1()),
                ring2: toSave(getEquippedRing2()),
                necklace: toSave(getEquippedNecklace()),
            };
        })(),
        sky: { time: sky.getTime(), dayCount: sky.getDayCount() },
        terrain: terrainObj,
        chests: chestSystem && typeof chestSystem.getStateForSave === 'function' ? chestSystem.getStateForSave() : {},
        campfires: campfireSystem && typeof campfireSystem.getStateForSave === 'function' ? campfireSystem.getStateForSave() : {},
        furnaces: furnaceSystem && typeof furnaceSystem.getStateForSave === 'function' ? furnaceSystem.getStateForSave() : {},
        looms: loomSystem && typeof loomSystem.getStateForSave === 'function' ? loomSystem.getStateForSave() : {},
        pebbles: stonePebblesSystem && typeof stonePebblesSystem.getStateForSave === 'function' ? stonePebblesSystem.getStateForSave() : {},
        mobs: mobSystem && typeof mobSystem.getStateForSave === 'function' ? mobSystem.getStateForSave() : [],
        ...getWorldStateForSave(treeSystem),
    };
}

async function applyLoadedState(state) {
    if (!state) return;

    // Clear world item drops when loading a different save
    if (itemDropSystem && typeof itemDropSystem.clearAll === 'function') {
        itemDropSystem.clearAll();
    }

    // Close any open UIs
    backpackOpen = false;
    craftingOpen = false;
    openChest = null;
    openCampfire = false;
    openFurnace = false;
    openLoom = false;
    updateInventoryOverlay();
    if (chestUI) chestUI.remove();
    chestUI = null;
    if (campfireUI) campfireUI.remove();
    campfireUI = null;
    if (furnaceUI) furnaceUI.remove();
    furnaceUI = null;
    if (loomUI) loomUI.remove();
    loomUI = null;

    // Restore terrain (blocks mined/placed) so the world matches the save
    if (state.terrain != null && typeof state.terrain === 'object') {
        const voxelData = terrain.getVoxelData();
        for (const key of Array.from(terrain.chunks.keys())) {
            const [cx, cz] = key.split(',').map(Number);
            terrain.unloadChunk(cx, cz);
        }
        voxelData.clear();
        for (const [key, vox] of Object.entries(state.terrain)) {
            voxelData.set(key, vox);
        }
        terrain._skipTreeGeneration = true;
        for (const key of Object.keys(state.terrain)) {
            const [cx, cz] = key.split(',').map(Number);
            terrain.generateChunk(cx, cz);
        }
        terrain._skipTreeGeneration = false;
    }

    // Restore chests, campfires, furnaces, trees (per-save state)
    if (state.chests != null && chestSystem && typeof chestSystem.restoreFromSave === 'function') {
        chestSystem.restoreFromSave(state.chests);
    }
    if (state.campfires != null && campfireSystem && typeof campfireSystem.restoreFromSave === 'function') {
        campfireSystem.restoreFromSave(state.campfires);
    }
    if (state.furnaces != null && furnaceSystem && typeof furnaceSystem.restoreFromSave === 'function') {
        furnaceSystem.restoreFromSave(state.furnaces);
    }
    if (state.looms != null && loomSystem && typeof loomSystem.restoreFromSave === 'function') {
        loomSystem.restoreFromSave(state.looms);
    }
    if (state.pebbles != null && stonePebblesSystem && typeof stonePebblesSystem.restoreFromSave === 'function') {
        stonePebblesSystem.restoreFromSave(state.pebbles);
    }
    restoreWorldState(state, treeSystem);

    // Restore mobs (clear any spawned by chunk load, then restore saved positions and health)
    if (state.mobs != null && mobSystem) {
        if (typeof mobSystem.clearAll === 'function') mobSystem.clearAll();
        if (typeof mobSystem.restoreFromSave === 'function') {
            await mobSystem.restoreFromSave(state.mobs);
        }
    }

    // Player position and look
    player.position.set(state.player.x, state.player.y, state.player.z);
    if (controls.setYawPitch) controls.setYawPitch(state.player.yaw, state.player.pitch);

    // Health and stamina
    const maxHealthNow = getCurrentMaxHealth();
    playerHealth = Math.max(0, Math.min(maxHealthNow, state.player.health));
    if (!player.userData) player.userData = {};
    player.userData.stamina = Math.max(0, Math.min(1, state.player.stamina ?? 1));
    updateHealthBar(playerHealth, maxHealthNow);
    updateStaminaBar(player.userData.stamina);

    // Inventory (migrate old planks item type 4 -> 'planks' for display/fuel)
    const normType = (t) => (t === 4 ? 'planks' : t);
    for (let i = 0; i < hotbar.length; i++) {
        const slot = state.hotbar && state.hotbar[i];
        hotbar[i] = slot ? createStackItem(normType(slot.type), Math.min(100, slot.count ?? 1)) : null;
    }
    for (let i = 0; i < backpackSlots.length; i++) {
        const slot = state.backpack && state.backpack[i];
        backpackSlots[i] = slot ? createStackItem(normType(slot.type), Math.min(100, slot.count || 1)) : null;
    }
    // Equipment: only restore each piece into its correct slot (no blocks/tools/wrong armour in slots)
    if (state.equipment) {
        const allowed = {
            head: ['helmet'],
            body: ['body_armour'],
            legs: ['leggings'],
            feet: ['boots'],
            ring1: ['ring', 'iron_ring', 'gold_ring'],
            ring2: ['ring', 'iron_ring', 'gold_ring'],
            necklace: ['necklace', 'iron_necklace', 'gold_necklace'],
        };
        const rest = (item, slotKey) => {
            const allowedTypes = allowed[slotKey] || [];
            if (!item || !allowedTypes.includes(item.type)) return null;
            return createStackItem(item.type, Math.min(100, item.count || 1));
        };
        setEquippedHead(rest(state.equipment.head, 'head'));
        setEquippedBody(rest(state.equipment.body, 'body'));
        setEquippedLegs(rest(state.equipment.legs, 'legs'));
        setEquippedFeet(rest(state.equipment.feet, 'feet'));
        setEquippedRing1(rest(state.equipment.ring1, 'ring1'));
        setEquippedRing2(rest(state.equipment.ring2, 'ring2'));
        setEquippedNecklace(rest(state.equipment.necklace, 'necklace'));
    }

    // Sky
    if (state.sky && typeof sky.setTime === 'function') sky.setTime(state.sky.time);
    if (state.sky && typeof sky.setDayCount === 'function') sky.setDayCount(state.sky.dayCount);

    selectedHotbar = 0;
    if (state.spawnPosition && state.spawnPosition.x != null) {
        spawnPosition = new THREE.Vector3(state.spawnPosition.x, state.spawnPosition.y, state.spawnPosition.z);
    } else {
        spawnPosition = player.position.clone();
    }
    gamePaused = false;
    const pauseOverlay = document.getElementById('pauseOverlay');
    if (pauseOverlay) pauseOverlay.style.display = 'none';
    document.body.classList.remove('game-paused');
    renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
    document.dispatchEvent(new CustomEvent('inventoryChanged'));
    updateCursorForBackpack();
}

function refreshSaveLoadUI() {
    const container = document.getElementById('saveLoadSlots');
    if (!container) return;
    listSaves().then((list) => {
        container.innerHTML = '';
        for (let i = 0; i < list.length; i++) {
            const info = list[i];
            const row = document.createElement('div');
            row.className = 'save-load-slot-row';
            const dayStr = info.dayCount != null ? `Day ${info.dayCount + 1}` : '—';
            const dateStr = info.savedAt ? new Date(info.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Empty';
            row.innerHTML = `<span class="save-load-slot-info">Slot ${i + 1}: ${dayStr} · ${dateStr}</span>`;
            const saveBtn = document.createElement('button');
            saveBtn.className = 'save-load-slot-btn';
            saveBtn.textContent = 'Save';
            saveBtn.addEventListener('click', () => {
                saveGame(i, buildSaveState()).then(() => {
                    saveBtn.textContent = 'Saved!';
                    setTimeout(() => { saveBtn.textContent = 'Save'; }, 1200);
                    refreshSaveLoadUI();
                }).catch(() => { saveBtn.textContent = 'Error'; setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500); });
            });
            const loadBtn = document.createElement('button');
            loadBtn.className = 'save-load-slot-btn load-btn';
            loadBtn.textContent = 'Load';
            loadBtn.disabled = !info.savedAt;
            loadBtn.addEventListener('click', () => {
                if (!info.savedAt) return;
                loadGame(i).then((state) => {
                    if (state) applyLoadedState(state);
                });
            });
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'save-load-slot-btn delete-btn';
            deleteBtn.textContent = 'Delete';
            deleteBtn.disabled = !info.savedAt;
            deleteBtn.addEventListener('click', () => {
                if (!info.savedAt) return;
                deleteSave(i).then(() => refreshSaveLoadUI()).catch(() => {});
            });
            row.appendChild(saveBtn);
            row.appendChild(loadBtn);
            row.appendChild(deleteBtn);
            container.appendChild(row);
        }
    }).catch(() => {});
}

// --- Distance fog: soft fade at chunk boundary so the world edge isn't a hard line ---
function updateDistanceFog() {
    if (weatherEffects && typeof weatherEffects.getMode === 'function' && weatherEffects.getMode() !== 'clear') return;
    const rd = typeof terrain.getRenderDistance === 'function' ? terrain.getRenderDistance() : (terrain.renderDistance ?? 2);
    const cs = terrain.chunkSize || 16;
    const worldRadius = rd * cs;
    const near = worldRadius * 0.55;
    const far = worldRadius * 1.08;
    scene.fog = new THREE.Fog(0x9fc4e0, near, far);
}
updateDistanceFog();

// (walls removed)

// --- Mob System ---
// ...existing code...

// (example walls removed)

// (duplicate BLOCK_TYPES definition removed)

// --- Particle System ---
const particleSystem = createParticleSystem(scene, terrain);
particleSystemRef = particleSystem;
terrain.particleSystem = particleSystem;


// Toggle visibility of weapon/tool models based on selected hotbar slot
function updateHeldModelVisibility() {
    const current = hotbar[selectedHotbar];
    const currentType = getSlotType(current);
    
    // Update visibility based on selected item (tools render on top, so no hide-when-clipping)
    if (gunModel) gunModel.visible = (currentType === 'gun' || currentType === 'spear') && !!gunModel.parent;
    if (bowModel) bowModel.visible = (currentType === 'bow') && !!bowModel.parent;
    if (pickaxeModel) pickaxeModel.visible = (currentType === 'pickaxe' || currentType === 'stone_pickaxe') && !!pickaxeModel.parent;
    if (spadeModel) spadeModel.visible = (currentType === 'spade') && !!spadeModel.parent;
    if (axeModel) axeModel.visible = (currentType === 'axe' || currentType === 'stone_axe') && !!axeModel.parent;
    if (campfireModel) campfireModel.visible = (currentType === 'campfire');
    if (chestModel) chestModel.visible = (currentType === 'chest');
    if (furnaceModel) furnaceModel.visible = (currentType === 'furnace');
    if (loomModel) loomModel.visible = (currentType === 'loom');
    if (bedModel) bedModel.visible = (currentType === 'bed');
    if (stickModel) stickModel.visible = (currentType === 'stick');
    if (foodModel) foodModel.visible = (currentType === 'raw_beef' || currentType === 'cooked_beef' || currentType === 'raw_mutton' || currentType === 'cooked_mutton');
    if (boneModel) boneModel.visible = (currentType === 'bone');
}

// --- Right-click placement (using mousedown instead of contextmenu) ---
canvas.addEventListener('mousedown', (e) => {
    if (gamePaused) return; // Block when paused
    if (e.button !== 2) return; // Only handle right-click (button 2)
    
    // place selected hotbar block if available
    const selectedItem = hotbar[selectedHotbar];
    if (!selectedItem) return;
    if (selectedItem && ['gun', 'spear', 'pickaxe', 'axe', 'stone_axe', 'stone_pickaxe', 'spade', 'bow'].includes(getSlotType(selectedItem))) return;

    const blockNum = getSlotType(selectedItem);
    let blockCount = getSlotCount(selectedItem);
    if (blockCount <= 0) return;

    // Plant sapling: right-click on TOP of a dirt or grass block to place sapling on that block
    if (blockNum === 'sapling' && treeSystem && typeof treeSystem.placeSapling === 'function') {
        const rc = new THREE.Raycaster();
        const origin = new THREE.Vector3();
        camera.getWorldPosition(origin);
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
        rc.set(origin, dir);
        const terrainChunks = Array.from(terrain.chunks.values());
        const colliders = [...mobSystem.getRaycastBlockers(), ...terrainChunks];
        const ints = rc.intersectObjects(colliders, true);
        if (ints.length > 0) {
            const hit = ints[0];
            const hitPoint = hit.point.clone();
            let worldNormal = new THREE.Vector3();
            if (hit.face) {
                worldNormal.copy(hit.face.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
            } else {
                worldNormal.copy(dir).negate();
            }

            // Only allow planting on the TOP face of a block
            if (worldNormal.y <= 0.5) return;

            // Find the block we actually hit (not the air above it)
            const basePoint = hitPoint.clone().add(worldNormal.clone().multiplyScalar(-0.5));
            const px = Math.floor(basePoint.x);
            const py = Math.floor(basePoint.y);
            const pz = Math.floor(basePoint.z);

            const groundId = terrain.getVoxelAt(px, py, pz);
            const aboveId = terrain.getVoxelAt(px, py + 1, pz);
            // Only allow planting on dirt (1) or grass (3) with air above
            if ((groundId === 1 || groundId === 3) && aboveId === 0) {
                if (treeSystem.placeSapling(px, py, pz)) {
                    if (!creativeMode) {
                        const newCount = blockCount - 1;
                        hotbar[selectedHotbar] = newCount > 0 ? createStackItem('sapling', newCount) : null;
                    }
                    renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                    renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
                    updateHeldModelVisibility();
                }
            }
        }
        return;
    }

    // Handle items that may be placeable blocks or consumables/resources
    let placeBlockId = null;
    if (typeof blockNum === 'number') {
        placeBlockId = blockNum;
    } else {
        placeBlockId = itemTypeToBlockId(blockNum);
        // If this is not a placeable block, treat as consumable (e.g. food) or ignore
        if (placeBlockId == null) {
            // Only allow eating cooked food (restores health)
            const cookedFoodTypes = ['cooked_beef', 'cooked_mutton'];
            if (cookedFoodTypes.includes(blockNum)) {
                // Heal player when eating cooked food
                heal(10); // Restore 10 health per cooked food item

                if (!creativeMode) {
                    if (typeof selectedItem === 'object') {
                        const newCount = getSlotCount(selectedItem) - 1;
                        if (newCount > 0) {
                            hotbar[selectedHotbar] = createStackItem(blockNum, newCount);
                        } else {
                            hotbar[selectedHotbar] = null;
                        }
                    } else {
                        hotbar[selectedHotbar] = null;
                    }
                }

                renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
                updateHeldModelVisibility();
            }
            // Non-placeable, non-consumable items: do nothing
            return;
        }
    }

    // Only valid block types are placeable as voxels
    if (!isValidBlockType(placeBlockId)) return;

    const rc = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
    rc.set(origin, dir);
    const terrainChunks = Array.from(terrain.chunks.values());
    const colliders = [...mobSystem.getRaycastBlockers(), ...terrainChunks];
    
    const ints = rc.intersectObjects(colliders, true);
    
    if (ints.length === 0) {
        return;
    }
    const hit = ints[0];

    // compute normal in world space (if face available)
    let worldNormal = new THREE.Vector3();
    if (hit.face) {
        worldNormal.copy(hit.face.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    } else {
        worldNormal.copy(dir).negate();
    }

    const placePoint = hit.point.clone().add(worldNormal.multiplyScalar(0.51));
    const px = Math.floor(placePoint.x);
    const py = Math.floor(placePoint.y);
    const pz = Math.floor(placePoint.z);

    const success = terrain.setVoxel(px, py, pz, placeBlockId);
    
    if (success) {
        pushEntitiesAboveBlock(px, py, pz);

        // In survival, decrement from selected hotbar stack. In creative, do not consume items.
        if (!creativeMode && typeof selectedItem === 'object') {
            const newCount = getSlotCount(selectedItem) - 1;
            if (newCount > 0) hotbar[selectedHotbar] = createStackItem(blockNum, newCount);
            else {
                hotbar[selectedHotbar] = null;
                if (hotbar[selectedHotbar] == null) selectedHotbar = 0;
            }
        }

        renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
        renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
        updateHeldModelVisibility();
    }
});

// Prevent context menu from appearing on canvas
canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
});

// --- Shooting Setup ---
setupShooting(
    camera,
    () => {
        const terrainChunks = Array.from(terrain.chunks.values());
        const chestMeshes = chestSystem ? chestSystem.chests : [];
        const campfireMeshes = campfireSystem ? campfireSystem.campfires : [];
        const bedMeshes = bedSystem ? bedSystem.beds : [];
        const treeMeshes = treeSystem ? treeSystem.getCollisionMeshes() : [];
        const pebbleMeshes = stonePebblesSystem ? stonePebblesSystem.getPebbleMeshes() : [];
        const furnaceMeshes = furnaceSystem ? furnaceSystem.furnaces : [];
        const loomMeshesForPlace = loomSystem ? loomSystem.looms : [];
        return [...mobSystem.getRaycastBlockers(), ...terrainChunks, ...chestMeshes, ...campfireMeshes, ...furnaceMeshes, ...loomMeshesForPlace, ...bedMeshes, ...treeMeshes, ...pebbleMeshes];
    },
    (hit) => {
        // don't allow shooting/mining when backpack UI is open or game is paused
        if (backpackOpen || craftingOpen || devConsoleOpen || gamePaused || referenceOverlayOpen) return;
        // No hit (e.g. shooting into sky): only gun/bow can still fire a projectile
        if (!hit) {
            const current = hotbar[selectedHotbar];
            if (current === 'gun' || current === 'spear' || current === 'bow') {
                const origin = new THREE.Vector3();
                camera.getWorldPosition(origin);
                const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
                origin.addScaledVector(dir, 0.3);
                if (current === 'gun' || current === 'spear') {
                    projectileSystem.spawnBullet(origin, dir, 5, 'player');
                } else {
                    let usedArrowType = null;
                    const tryConsume = (arr, type, startIndex = 0) => {
                        for (let i = startIndex; i < arr.length; i++) {
                            const slot = arr[i];
                            if (!slot || getSlotType(slot) !== type) continue;
                            const have = getSlotCount(slot);
                            arr[i] = have > 1 ? createStackItem(type, have - 1) : null;
                            usedArrowType = type;
                            return true;
                        }
                        return false;
                    };
                    const haveFeathered = tryConsume(backpackSlots, 'feathered_arrow', 0) || tryConsume(hotbar, 'feathered_arrow', 2);
                    if (!haveFeathered && !tryConsume(backpackSlots, 'arrow', 0) && !tryConsume(hotbar, 'arrow', 2)) return;
                    const spread = usedArrowType === 'feathered_arrow' ? 0.003 : 0.018;
                    let baseDir = dir.clone();
                    if (spread > 0) {
                        const yawJitter = (Math.random() - 0.5) * spread;
                        const pitchJitter = (Math.random() - 0.5) * spread;
                        baseDir.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawJitter)).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchJitter)).normalize();
                    }
                    projectileSystem.spawnArrow(origin, baseDir, 4, 'player');
                }
                renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
            }
            return;
        }
        const obj = hit.object;
        const current = hotbar[selectedHotbar];

        // Stone pebble: break by hand or with pickaxe for stones
        let pebbleRoot = obj;
        while (pebbleRoot && !pebbleRoot.userData.isStonePebble && pebbleRoot.parent) pebbleRoot = pebbleRoot.parent;
        if (pebbleRoot && pebbleRoot.userData.isStonePebble && stonePebblesSystem) {
            const currentType = getSlotType(current);
            const isHand = !current || (typeof current === 'object' && !['gun', 'spear', 'axe', 'pickaxe', 'stone_axe', 'stone_pickaxe', 'spade', 'bow', 'spares'].includes(currentType));
            const canBreakPebble = isHand || currentType === 'pickaxe' || currentType === 'stone_pickaxe';
            if (canBreakPebble) {
                const count = stonePebblesSystem.breakPebble(pebbleRoot);
                if (count > 0 && itemDropSystem) {
                    const origin = pebbleRoot.position.clone();
                    const randOffset = () => new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4);
                    for (let i = 0; i < count; i++) {
                        itemDropSystem.spawnDrop('stone', 1, origin.clone().add(randOffset()));
                    }
                }
                return;
            }
        }

        // Spade on stump: dig up stump, drop logs + dirt
        let stumpRoot = obj;
        while (stumpRoot && !stumpRoot.userData.isStump && stumpRoot.parent) stumpRoot = stumpRoot.parent;
        if (stumpRoot && stumpRoot.userData.isStump && (current === 'spade') && treeSystem && typeof treeSystem.digUpStump === 'function') {
            const result = treeSystem.digUpStump(stumpRoot);
            if (result && itemDropSystem) {
                const origin = stumpRoot.position.clone();
                const randOffset = () => new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.4, (Math.random() - 0.5) * 0.6);
                for (let i = 0; i < result.logs; i++) {
                    itemDropSystem.spawnDrop('wood', 1, origin.clone().add(randOffset()));
                }
                for (let i = 0; i < result.dirt; i++) {
                    itemDropSystem.spawnDrop(1, 1, origin.clone().add(randOffset())); // dirt = block id 1
                }
                renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
            }
            return;
        }

        // If current slot is gun/spear/bow, spawn a visible projectile (bullet or arrow) instead of instant hit
        if (current === 'gun' || current === 'spear' || current === 'bow') {
            const isBow = current === 'bow';
            const isGun = current === 'gun' || current === 'spear';
            let usedArrowType = null;
            if (isBow) {
                const tryConsume = (arr, type, startIndex = 0) => {
                    for (let i = startIndex; i < arr.length; i++) {
                        const slot = arr[i];
                        if (!slot || getSlotType(slot) !== type) continue;
                        const have = getSlotCount(slot);
                        const newCount = have - 1;
                        arr[i] = newCount > 0 ? createStackItem(type, newCount) : null;
                        usedArrowType = type;
                        return true;
                    }
                    return false;
                };
                // Prefer feathered arrows; fall back to crude arrows
                const haveFeathered =
                    tryConsume(backpackSlots, 'feathered_arrow', 0) ||
                    tryConsume(hotbar, 'feathered_arrow', 2);
                if (!haveFeathered) {
                    const haveCrude =
                        tryConsume(backpackSlots, 'arrow', 0) ||
                        tryConsume(hotbar, 'arrow', 2);
                    if (!haveCrude) return;
                }
            }
            const origin = new THREE.Vector3();
            camera.getWorldPosition(origin);
            let dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
            origin.addScaledVector(dir, 0.3);
            const damage = isGun ? 5 : 4;
            if (isGun) {
                projectileSystem.spawnBullet(origin, dir, damage, 'player');
            } else {
                // Apply spread: crude arrows have more random drift; feathered arrows fly straighter.
                const baseDir = dir.clone();
                const spread =
                    usedArrowType === 'feathered_arrow'
                        ? 0.003  // near-pinpoint accuracy
                        : 0.018; // noticeable wobble for crude stick arrows
                if (spread > 0) {
                    const yawJitter = (Math.random() - 0.5) * spread;
                    const pitchJitter = (Math.random() - 0.5) * spread;
                    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawJitter);
                    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchJitter);
                    baseDir.applyQuaternion(yawQuat).applyQuaternion(pitchQuat).normalize();
                }
                projectileSystem.spawnArrow(origin, baseDir, damage, 'player');
            }
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
            return;
        }

        // Melee attack with spares: short-range stab that damages mobs
        if (current === 'spares') {
            let mobMesh = obj;
            while (mobMesh && !mobMesh.userData.mobType && mobMesh.parent) {
                mobMesh = mobMesh.parent;
            }
            if (mobMesh && mobMesh.userData.mobType) {
                // Require close range for melee
                if (hit.distance > 3) return;
                const mobDrops = mobSystem.damageMob(mobMesh, 3);
                if (mobDrops && mobDrops.length > 0 && itemDropSystem) {
                    const origin = new THREE.Vector3();
                    mobMesh.getWorldPosition(origin);
                    for (const drop of mobDrops) {
                        if (!drop || typeof drop !== 'string') continue;
                        itemDropSystem.spawnDrop(
                            drop,
                            1,
                            origin.clone().add(new THREE.Vector3(
                                (Math.random() - 0.5) * 0.6,
                                0.5,
                                (Math.random() - 0.5) * 0.6
                            ))
                        );
                    }
                }
                renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
                return;
            }
        }

        // Trees are voxel (log + leaves); breaking them is handled by terrain block break + drops above.
        const isAxe = current === 'axe' || current === 'stone_axe';
        const isPickaxe = current === 'pickaxe' || current === 'stone_pickaxe';

        // If current slot is pickaxe (or stone pickaxe) or axe, allow breaking chests/campfires/furnaces/looms/beds
        if (isPickaxe || isAxe) {
            let target = obj;
            while (target && !target.userData.isChest && !target.userData.isCampfire && !target.userData.isFurnace && !target.userData.isLoom && !target.userData.isBed) {
                target = target.parent;
            }

            if (target && (target.userData.isChest || target.userData.isCampfire || target.userData.isFurnace || target.userData.isLoom || target.userData.isBed)) {
                let root = target;
                if (target.userData.isChest && chestSystem) {
                    while (root.parent && !chestSystem.chests.includes(root)) root = root.parent;
                } else if (target.userData.isCampfire && campfireSystem) {
                    while (root.parent && !campfireSystem.campfires.includes(root)) root = root.parent;
                } else if (target.userData.isFurnace && furnaceSystem) {
                    while (root.parent && !furnaceSystem.furnaces.includes(root)) root = root.parent;
                } else if (target.userData.isLoom && loomSystem) {
                    while (root.parent && !loomSystem.looms.includes(root)) root = root.parent;
                } else if (target.userData.isBed && bedSystem) {
                    while (root.parent && !bedSystem.beds.includes(root)) root = root.parent;
                }

                // Tool effectiveness: axe is best for campfire/bed/loom, pickaxe is best for chest/furnace.
                // Implement \"slow vs fast\" by requiring more hits with the wrong tool.
                let threshold = 1;
                if (root.userData.isCampfire || root.userData.isBed || root.userData.isLoom) {
                    if (isAxe) {
                        threshold = 1; // axe: fast
                    } else if (isPickaxe) {
                        threshold = 3; // pickaxe: slower (3 hits)
                    }
                } else if (root.userData.isFurnace || root.userData.isChest) {
                    if (isPickaxe) {
                        threshold = 1; // pickaxe: fast for furnace/chest
                    } else if (isAxe) {
                        threshold = 0; // axe can't effectively break furnace/chest
                    }
                }

                if (threshold <= 0) {
                    return;
                }
                root.userData.breakHits = (root.userData.breakHits || 0) + 1;
                if (root.userData.breakHits < threshold) {
                    return;
                }
                root.userData.breakHits = 0;

                if (root.userData.isChest && chestSystem && typeof chestSystem.removeChest === 'function') {
                    chestSystem.removeChest(root);
                } else if (root.userData.isChest && chestSystem) {
                    const idx = chestSystem.chests.indexOf(root);
                    if (idx !== -1) chestSystem.chests.splice(idx, 1);
                    scene.remove(root);
                }
                if (root.userData.isCampfire && campfireSystem && typeof campfireSystem.removeCampfire === 'function') {
                    campfireSystem.removeCampfire(root);
                } else if (root.userData.isCampfire && campfireSystem) {
                    const idx = campfireSystem.campfires.indexOf(root);
                    if (idx !== -1) campfireSystem.campfires.splice(idx, 1);
                    scene.remove(root);
                }
                if (root.userData.isFurnace && furnaceSystem && typeof furnaceSystem.removeFurnace === 'function') {
                    furnaceSystem.removeFurnace(root);
                } else if (root.userData.isFurnace && furnaceSystem) {
                    const idx = furnaceSystem.furnaces.indexOf(root);
                    if (idx !== -1) furnaceSystem.furnaces.splice(idx, 1);
                    scene.remove(root);
                }
                if (root.userData.isLoom && loomSystem && typeof loomSystem.removeLoom === 'function') {
                    loomSystem.removeLoom(root);
                    if (openLoom && window.currentLoomMesh === root) closeLoomUI();
                    if (itemDropSystem) itemDropSystem.spawnDrop('loom', 1, root.position.clone());
                } else if (root.userData.isLoom && loomSystem) {
                    const idx = loomSystem.looms.indexOf(root);
                    if (idx !== -1) loomSystem.looms.splice(idx, 1);
                    scene.remove(root);
                    if (openLoom && window.currentLoomMesh === root) closeLoomUI();
                    if (itemDropSystem) itemDropSystem.spawnDrop('loom', 1, root.position.clone());
                }
                if (root.userData.isBed && bedSystem && typeof bedSystem.removeBed === 'function') {
                    bedSystem.removeBed(root);
                } else if (root.userData.isBed && bedSystem) {
                    const idx = bedSystem.beds.indexOf(root);
                    if (idx !== -1) bedSystem.beds.splice(idx, 1);
                    scene.remove(root);
                }

                // If no beds remain, reset respawn point back to default
                if (root.userData.isBed && bedSystem && bedSystem.beds && bedSystem.beds.length === 0 && defaultSpawnPosition) {
                    spawnPosition = defaultSpawnPosition.clone();
                    showStatusMessage('Respawn point reset to world spawn');
                }

                const itemType = root.userData.isChest ? 'chest' : root.userData.isCampfire ? 'campfire' : root.userData.isFurnace ? 'furnace' : 'bed';
                let remaining = 1;

                // Try merge into existing backpack stacks
                for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
                    const slot = backpackSlots[i];
                    if (slot && getSlotType(slot) === itemType) {
                        const canAdd = 100 - getSlotCount(slot);
                        if (canAdd > 0) {
                            const add = Math.min(canAdd, remaining);
                            backpackSlots[i] = createStackItem(itemType, getSlotCount(slot) + add);
                            remaining -= add;
                        }
                    }
                }
                // Then empty backpack slots
                for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
                    if (backpackSlots[i] == null) {
                        backpackSlots[i] = createStackItem(itemType, remaining);
                        remaining = 0;
                        break;
                    }
                }
                // If backpack full, put in hotbar (slots 2+ are item slots)
                for (let i = 2; i < hotbar.length && remaining > 0; i++) {
                    const slot = hotbar[i];
                    if (slot && getSlotType(slot) === itemType) {
                        const canAdd = 100 - getSlotCount(slot);
                        if (canAdd > 0) {
                            const add = Math.min(canAdd, remaining);
                            hotbar[i] = createStackItem(itemType, getSlotCount(slot) + add);
                            remaining -= add;
                        }
                    }
                }
                for (let i = 2; i < hotbar.length && remaining > 0; i++) {
                    if (hotbar[i] == null) {
                        hotbar[i] = createStackItem(itemType, remaining);
                        remaining = 0;
                        break;
                    }
                }

                // Show pickup notification
                if (remaining < 1) {
                    let total = 0;
                    for (const slot of [...backpackSlots, ...hotbar.slice(2)]) {
                        if (slot && getSlotType(slot) === itemType) total += getSlotCount(slot);
                    }
                    showPickupNotification(getBlockName(itemType), 1, total);
                }

                renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);

                return;
            }

            // Get the hit point and find the block that was hit
            let hitPoint = hit.point.clone();
            
            // Check the block at the hit point (rounded to nearest voxel)
            let checkPositions = [
                Math.floor(hitPoint.x),
                Math.floor(hitPoint.y),
                Math.floor(hitPoint.z)
            ];
            
            // Also check adjacent voxels to handle edge cases
            let voxelsToCheck = [];
            for (let dx = 0; dx <= 1; dx++) {
                for (let dy = 0; dy <= 1; dy++) {
                    for (let dz = 0; dz <= 1; dz++) {
                        voxelsToCheck.push([
                            checkPositions[0] + (dx - 1),
                            checkPositions[1] + (dy - 1),
                            checkPositions[2] + (dz - 1)
                        ]);
                    }
                }
            }
            
            // Find the closest block to the hit point
            let closestVoxel = null;
            let closestDist = Infinity;
            
            for (const [vx, vy, vz] of voxelsToCheck) {
                const voxelType = terrain.getVoxelAt(vx, vy, vz);
                if (voxelType) {
                    // Calculate distance from hit point to voxel center
                    const voxelCenter = new THREE.Vector3(vx + 0.5, vy + 0.5, vz + 0.5);
                    const dist = hitPoint.distanceTo(voxelCenter);
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestVoxel = [vx, vy, vz];
                    }
                }
            }
            
            if (closestVoxel) {
                const [vx, vy, vz] = closestVoxel;
                const originalType = terrain.getVoxelAt(vx, vy, vz);
                if (!originalType) return;

                const toolKind = classifyToolForBlockBreaking(current, getSlotType);
                const requiredHits = getHitsToBreakBlock(originalType, toolKind);
                if (requiredHits <= 0) {
                    // Tool cannot break this block (e.g. spade on stone).
                    return;
                }

                const key = makeBlockKey(vx, vy, vz);
                let progress = terrainHitProgress.get(key);
                const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                if (!progress || progress.toolKind !== toolKind || (now - (progress.lastTime || 0)) > TERRAIN_PROGRESS_MEMORY_MS) {
                    progress = { hits: 0, toolKind, lastTime: now };
                }
                progress.hits += 1;
                progress.lastTime = now;
                updateBlockBreakOverlay(vx, vy, vz, progress.hits, requiredHits);
                if (progress.hits < requiredHits) {
                    terrainHitProgress.set(key, progress);
                    return;
                }
                terrainHitProgress.delete(key);
                clearBlockBreakOverlayForKey(key);

                const removed = terrain.removeVoxel(vx, vy, vz);
                if (removed) {
                    const isTreeBlock = removed === LOG_BLOCK_ID || removed === LEAVES_BLOCK_ID_TREE;
                    if (!isTreeBlock) snapEntitiesToSurfaceInColumn(vx, vy, vz);
                    // Ore decoration meshes are visual-only; if terrain changes, re-evaluate exposed ores.
                    if (oreDecorationsSystem && typeof oreDecorationsSystem.onVoxelRemoved === 'function') {
                        oreDecorationsSystem.onVoxelRemoved(vx, vy, vz, removed);
                    }
                    if (itemDropSystem) {
                        const center = new THREE.Vector3(vx + 0.5, vy + 0.5, vz + 0.5);
                        const randOffset = () => new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4);
                        if (removed === 2) {
                            const count = 2 + Math.floor(Math.random() * 3);
                            for (let i = 0; i < count; i++) {
                                itemDropSystem.spawnDrop('stone', 1, center.clone().add(randOffset()));
                            }
                        } else if (removed === 7) {
                            const count = 1 + Math.floor(Math.random() * 2);
                            for (let i = 0; i < count; i++) {
                                itemDropSystem.spawnDrop('coal', 1, center.clone().add(randOffset()));
                            }
                        } else if (removed === 8) {
                            itemDropSystem.spawnDrop('iron_ore', 1, center.clone().add(randOffset()));
                        } else if (removed === BLOCK_IDS.GOLD_ORE) {
                            itemDropSystem.spawnDrop('gold_ore', 1, center.clone().add(randOffset()));
                        } else if (removed === BLOCK_IDS.WATER) {
                            // Water is non-solid; don't spawn item drops.
                        } else if (removed === 4) {
                            itemDropSystem.spawnDrop('wood', 1, center.clone().add(randOffset()));
                        } else if (removed === 5) {
                            // Leaves: drop leaf blocks, saplings, and a chance for sticks
                            itemDropSystem.spawnDrop('leaves', 1, center.clone().add(randOffset()));
                            if (Math.random() < 0.4) {
                                const stickCount = 1 + Math.floor(Math.random() * 2);
                                for (let i = 0; i < stickCount; i++) {
                                    itemDropSystem.spawnDrop('stick', 1, center.clone().add(randOffset()));
                                }
                            }
                            if (Math.random() < 0.35) {
                                itemDropSystem.spawnDrop('sapling', 1, center.clone().add(randOffset()));
                            }
                        } else {
                            itemDropSystem.spawnDrop(removed, 1, center);
                        }
                    }
                    if (stonePebblesSystem && typeof stonePebblesSystem.breakPebbleAt === 'function') {
                        const pebbleStones = stonePebblesSystem.breakPebbleAt(vx, vy, vz);
                        if (pebbleStones > 0 && itemDropSystem) {
                            const center = new THREE.Vector3(vx + 0.5, vy + 1, vz + 0.5);
                            const randOffset = () => new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4);
                            for (let i = 0; i < pebbleStones; i++) {
                                itemDropSystem.spawnDrop('stone', 1, center.clone().add(randOffset()));
                            }
                        }
                    }

                    applyCactusFallAfterBreak(terrain, vx, vy, vz, removed);
                    applyTreeColumnCollapse(terrain, vx, vy, vz, removed);
                    if (removed === LOG_BLOCK_ID || removed === LEAVES_BLOCK_ID_TREE) {
                        snapEntitiesToSurfaceInColumn(vx, vy, vz);
                    }

                    // Use block color for break particles
                    let color = [0.7, 0.7, 0.7];
                    if (BLOCK_TYPES[removed] && BLOCK_TYPES[removed].color) color = BLOCK_TYPES[removed].color;
                    particleSystem.spawn(hit.point.clone(), new THREE.Vector3().subVectors(hit.point, camera.getWorldPosition(new THREE.Vector3())).normalize(), null, color);
                }
            }
            
            return;
        }

        // otherwise: no action (empty slot or block selected)
    },
    () => gamePaused // Pass pause check function
);

// --- Responsive UI ---

import { updateUIPositions, updateTemperatureAndSeason } from './ui/ui.js';
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateUIPositions();
});
updateUIPositions();


// Hold references to weapon/tool models and holdable item models (must be declared before resolveCameraCollision)
let gunModel = null;
let pickaxeModel = null;
let axeModel = null;
let spadeModel = null;
let bowModel = null;
let campfireModel = null;
let chestModel = null;
let furnaceModel = null;
let loomModel = null;
let bedModel = null;
let stickModel = null;
let foodModel = null;
let boneModel = null;

// Block outline/highlight system
let blockOutline = null;
let highlightedBlock = null;

// Block break progress overlay (Minecraft-style cracking)
let blockBreakOverlay = null;
let blockBreakKey = null;

function updateBlockBreakOverlay(vx, vy, vz, hits, requiredHits) {
    const key = makeBlockKey(vx, vy, vz);
    blockBreakKey = key;
    const progress = THREE.MathUtils.clamp(hits / requiredHits, 0, 1);
    if (!blockBreakOverlay) {
        const geo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 0.0,
            depthWrite: false,
        });
        blockBreakOverlay = new THREE.Mesh(geo, mat);
        blockBreakOverlay.renderOrder = 999;
        scene.add(blockBreakOverlay);
    }
    blockBreakOverlay.position.set(vx + 0.5, vy + 0.5, vz + 0.5);
    blockBreakOverlay.visible = progress > 0;
    if (blockBreakOverlay.material) {
        blockBreakOverlay.material.opacity = 0.1 + 0.6 * progress;
    }
}

function clearBlockBreakOverlayForKey(key) {
    if (blockBreakKey && key && key !== blockBreakKey) return;
    if (blockBreakOverlay) {
        blockBreakOverlay.visible = false;
    }
    blockBreakKey = null;
}

// --- Load Models ---
loadModels(player, camera).then(({ character, gun, spade, bow, pickaxe, axe, campfire, chest, furnace, loom, bed, tree, stone_pebbles, stump, food, stick, bone, iron_ore }) => {
    gunModel = gun || null;
    spadeModel = spade || null;
    bowModel = bow || null;
    pickaxeModel = pickaxe || null;
    axeModel = axe || null;

    camera.traverse((child) => {
        if (child.userData && child.userData.heldType) {
            if (child.userData.heldType === 'chest') chestModel = child;
            else if (child.userData.heldType === 'campfire') campfireModel = child;
            else if (child.userData.heldType === 'furnace') furnaceModel = child;
            else if (child.userData.heldType === 'loom') loomModel = child;
            else if (child.userData.heldType === 'bed') bedModel = child;
            else if (child.userData.heldType === 'stick') stickModel = child;
            else if (child.userData.heldType === 'food') foodModel = child;
            else if (child.userData.heldType === 'bone') boneModel = child;
        }
    });

    if (!chestSystem) {
        chestSystem = createChestSystem(scene, terrain, player, backpackSlots, createStackItem, chest);
        terrain.chestSystem = chestSystem;
    }
    if (!campfireSystem) {
        campfireSystem = createCampfireSystem(scene, terrain, player, backpackSlots, createStackItem, cookItem, getFuelBurnTime, getSlotType, getSlotCount, campfire);
        terrain.campfireSystem = campfireSystem;
        window.campfireSystem = campfireSystem;
        window.showCampfireUI = showCampfireUI;
    }
    if (!furnaceSystem) {
        furnaceSystem = createFurnaceSystem(scene, terrain, createStackItem, getFuelBurnTime, getSlotType, getSlotCount, smeltItem, furnace ?? null);
        terrain.furnaceSystem = furnaceSystem;
        window.furnaceSystem = furnaceSystem;
        window.showFurnaceUI = showFurnaceUI;
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            furnaceSystem.onChunkLoad(cx, cz);
        }
    }
    if (!loomSystem) {
        loomSystem = createLoomSystem(scene, terrain, createStackItem, getSlotType, getSlotCount, loom ?? null);
        terrain.loomSystem = loomSystem;
        window.loomSystem = loomSystem;
        window.showLoomUI = showLoomUI;
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            loomSystem.onChunkLoad(cx, cz);
        }
    }
    if (!bedSystem) {
        bedSystem = createBedSystem(scene, terrain, bed);
        terrain.bedSystem = bedSystem;
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            bedSystem.onChunkLoad(cx, cz);
        }
    }
    if (!treeSystem && tree) {
        treeSystem = createTreeSystem(scene, terrain, tree, stump ?? null);
        terrain.treeSystem = treeSystem;
        // Place trees in all chunks that were already generated before the tree system existed
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            treeSystem.onChunkLoad(cx, cz);
        }
    }
    if (!stonePebblesSystem) {
        stonePebblesSystem = createStonePebblesSystem(scene, terrain, stone_pebbles ?? null);
        terrain.stonePebblesSystem = stonePebblesSystem;
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            stonePebblesSystem.onChunkLoad(cx, cz);
        }
    }
    if (!oreDecorationsSystem) {
        oreDecorationsSystem = createOreDecorationsSystem(scene, terrain, iron_ore ?? null);
        terrain.oreDecorationsSystem = oreDecorationsSystem;
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            oreDecorationsSystem.onChunkLoad(cx, cz);
        }
    }
    if (itemDropSystem && typeof itemDropSystem.setDropModels === 'function') {
        itemDropSystem.setDropModels({ food: food ?? null, stick: stick ?? null, bone: bone ?? null });
    }

    updateHeldModelVisibility();
});

// --- Helper: get terrain height at X,Z ---
function getGroundHeight(worldX, worldZ) {
    const x = Math.floor(worldX);
    const z = Math.floor(worldZ);

    for (let y = terrain.height - 1; y >= 0; y--) {
        if (terrain.getVoxelAt(x, y, z) !== 0) return y;
    }

    return 0;
}

/** Non-air, non-water voxel above head = roof / tree / cave ceiling; blocks precipitation wetness. */
function isShelteredFromPrecipitation(worldX, headWorldY, worldZ) {
    const hx = Math.floor(worldX);
    const hz = Math.floor(worldZ);
    const y0 = Math.floor(headWorldY) + 1;
    const h = terrain.height ?? 64;
    const yMax = Math.min(h - 1, y0 + 40);
    for (let y = y0; y <= yMax; y++) {
        const id = terrain.getVoxelAt(hx, y, hz);
        if (id !== 0 && !isWater(id)) return true;
    }
    return false;
}

function weatherModeToHudLabel(wxMode) {
    const labels = {
        clear: 'Clear',
        lightrain: 'Light rain',
        rain: 'Rain',
        heavyrain: 'Heavy rain',
        storm: 'Storm',
        snow: 'Snow',
    };
    return labels[wxMode] || 'Clear';
}

function weatherHasPrecipitation(wxMode) {
    return wxMode === 'lightrain' || wxMode === 'rain' || wxMode === 'heavyrain' || wxMode === 'storm' || wxMode === 'snow';
}

// --- Animation Loop ---
let lastTime = performance.now();
// Camera collision defaults (polished approach: raycast from head toward intended position, stop at hit)
const defaultCameraLocal = camera.position.clone();
const camRaycaster = new THREE.Raycaster();
const cameraCollisionRadius = 0.3;
const cameraBlockOffset = 0.08; // Keep camera this far in front of a block (hitPoint - offset)
const maxRaycastDistance = 0.6;  // How far ahead/behind to check for blocks

// --- Near-block clipping (stops camera and tools from rendering inside blocks) ---
// Use a camera AABB (Box3) so edges of the screen don't clip; also raycast for the plane.
const nearBlockClipPlane = new THREE.Plane();
const nearBlockClipNormal = new THREE.Vector3();
const NEAR_CLIP_RAYCAST_DIST = 0.55;
const NEAR_CLIP_PLANE_NUDGE = 0.01;
const CAMERA_BOX_HALF = 0.18; // Camera bounding box half-extent (covers view/head volume for edge clipping)

const cameraBox = new THREE.Box3();
const voxelBox = new THREE.Box3();
const _voxelFaceCenter = new THREE.Vector3();
const _voxelFaceNormal = new THREE.Vector3();

// Face distance from camera (positive = camera in front of face). Returns Infinity if no valid face.
function getVoxelClosestFaceDistance(vx, vy, vz, camPos) {
    const faces = [
        { c: [vx, vy + 0.5, vz + 0.5], n: [-1, 0, 0] },
        { c: [vx + 1, vy + 0.5, vz + 0.5], n: [1, 0, 0] },
        { c: [vx + 0.5, vy, vz + 0.5], n: [0, -1, 0] },
        { c: [vx + 0.5, vy + 1, vz + 0.5], n: [0, 1, 0] },
        { c: [vx + 0.5, vy + 0.5, vz], n: [0, 0, -1] },
        { c: [vx + 0.5, vy + 0.5, vz + 1], n: [0, 0, 1] }
    ];
    let bestD = Infinity;
    for (let i = 0; i < faces.length; i++) {
        const c = faces[i].c;
        const n = faces[i].n;
        const d = (camPos.x - c[0]) * n[0] + (camPos.y - c[1]) * n[1] + (camPos.z - c[2]) * n[2];
        if (d > 0 && d < bestD) {
            bestD = d;
            _voxelFaceCenter.set(c[0], c[1], c[2]);
            _voxelFaceNormal.set(n[0], n[1], n[2]);
        }
    }
    return bestD;
}

// Set outPlane to the face of voxel (vx,vy,vz) closest to camPos that camera is in front of.
function getClipPlaneFromVoxel(vx, vy, vz, camPos, outPlane) {
    if (getVoxelClosestFaceDistance(vx, vy, vz, camPos) === Infinity) return false;
    const planePoint = _voxelFaceCenter.clone().add(_voxelFaceNormal.clone().multiplyScalar(-NEAR_CLIP_PLANE_NUDGE));
    outPlane.setFromNormalAndCoplanarPoint(_voxelFaceNormal.clone(), planePoint);
    return true;
}

function updateNearBlockClipping() {
    // Use HEAD position for the AABB, not current camera position. resolveCameraCollision can pull
    // the camera back; if we used that position here, the box might not intersect the block and we'd
    // clear the clipping plane, so the view would still clip. Using head fixes that.
    const feetWorld = getWorldPosition();
    const headWorld = feetWorld.clone();
    headWorld.y += playerHeight;
    const terrainChunks = Array.from(terrain.chunks.values());

    // Camera AABB: box around head (catches edges of screen, not just center ray)
    cameraBox.min.set(headWorld.x - CAMERA_BOX_HALF, headWorld.y - CAMERA_BOX_HALF, headWorld.z - CAMERA_BOX_HALF);
    cameraBox.max.set(headWorld.x + CAMERA_BOX_HALF, headWorld.y + CAMERA_BOX_HALF, headWorld.z + CAMERA_BOX_HALF);

    let usePlaneFromAABB = false;
    let bestVoxel = null;
    let bestDist = Infinity;
    const vx0 = Math.floor(headWorld.x) - 1;
    const vy0 = Math.floor(headWorld.y) - 1;
    const vz0 = Math.floor(headWorld.z) - 1;
    for (let vx = vx0; vx <= vx0 + 3; vx++) {
        for (let vy = vy0; vy <= vy0 + 3; vy++) {
            for (let vz = vz0; vz <= vz0 + 3; vz++) {
                if (terrain.getVoxelAt(vx, vy, vz) === 0) continue;
                voxelBox.set(new THREE.Vector3(vx, vy, vz), new THREE.Vector3(vx + 1, vy + 1, vz + 1));
                if (!cameraBox.intersectsBox(voxelBox)) continue;
                const d = getVoxelClosestFaceDistance(vx, vy, vz, headWorld);
                if (d < bestDist) {
                    bestDist = d;
                    bestVoxel = [vx, vy, vz];
                }
            }
        }
    }
    if (bestVoxel) {
        usePlaneFromAABB = getClipPlaneFromVoxel(bestVoxel[0], bestVoxel[1], bestVoxel[2], headWorld, nearBlockClipPlane);
    }

    // If no AABB overlap, fall back to raycast from head (center of screen) for the plane
    if (!usePlaneFromAABB) {
        const viewDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
        camRaycaster.set(headWorld, viewDir);
        camRaycaster.far = NEAR_CLIP_RAYCAST_DIST;
        camRaycaster.near = 0.001;
        const chestMeshes = chestSystem ? chestSystem.chests : [];
        const campfireMeshes = campfireSystem ? campfireSystem.campfires : [];
        const furnaceMeshes = furnaceSystem ? furnaceSystem.furnaces : [];
        const loomMeshes = loomSystem ? loomSystem.looms : [];
        const bedMeshes = bedSystem ? bedSystem.beds : [];
        const treeMeshes = treeSystem ? treeSystem.trees : [];
        const clipColliders = [...terrainChunks, ...chestMeshes, ...campfireMeshes, ...furnaceMeshes, ...loomMeshes, ...bedMeshes, ...treeMeshes];
        const hits = camRaycaster.intersectObjects(clipColliders, true);
        if (hits.length > 0 && hits[0].distance < NEAR_CLIP_RAYCAST_DIST && hits[0].face) {
            const hit = hits[0];
            hit.object.updateMatrixWorld(true);
            nearBlockClipNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
            const planePoint = hit.point.clone().add(nearBlockClipNormal.clone().multiplyScalar(-NEAR_CLIP_PLANE_NUDGE));
            nearBlockClipPlane.setFromNormalAndCoplanarPoint(nearBlockClipNormal, planePoint);
            usePlaneFromAABB = true;
        }
    }

    const clippingPlanes = usePlaneFromAABB ? [nearBlockClipPlane] : [];

    for (const chunk of terrainChunks) {
        if (chunk.material) chunk.material.clippingPlanes = clippingPlanes;
    }

    const toolRoots = [gunModel, pickaxeModel, axeModel].filter(Boolean);
    for (const root of toolRoots) {
        root.traverse((obj) => {
            if (!obj.isMesh || !obj.material) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (m && typeof m.clippingPlanes !== 'undefined') m.clippingPlanes = clippingPlanes;
            }
        });
    }
}

function resolveCameraCollision() {
    const feetWorld = getWorldPosition();
    const headWorld = feetWorld.clone();
    headWorld.y += playerHeight;

    camera.position.copy(defaultCameraLocal);
    const viewDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();

    const terrainChunks = Array.from(terrain.chunks.values());
    const chestMeshes = chestSystem ? chestSystem.chests : [];
    const campfireMeshes = campfireSystem ? campfireSystem.campfires : [];
    const bedMeshes = bedSystem ? bedSystem.beds : [];
    const treeMeshes = treeSystem ? treeSystem.trees : [];
    const rayColliders = [...mobSystem.getRaycastBlockers(), ...terrainChunks, ...chestMeshes, ...campfireMeshes, ...bedMeshes, ...treeMeshes];

    // --- Raycast from player head toward intended camera position; stop before entering blocks ---
    // In first person the intended position is the head. We cast from head in view direction (and
    // behind) to find any block in the way; camera is placed at hitPoint - smallOffset.
    let camWorld = headWorld.clone();

    // Forward: ray from head in view direction; if we hit, place camera at hitPoint - offset (don't enter block)
    camRaycaster.set(headWorld, viewDir.clone());
    camRaycaster.far = maxRaycastDistance;
    camRaycaster.near = 0;
    const hitsForward = camRaycaster.intersectObjects(rayColliders, true);
    if (hitsForward.length > 0 && hitsForward[0].distance < maxRaycastDistance) {
        const d = Math.max(0, hitsForward[0].distance - cameraBlockOffset);
        camWorld.copy(headWorld).add(viewDir.clone().multiplyScalar(d));
    }

    // If head is inside a block, raycast outward from head and place camera just outside the block
    const safetyRadius = cameraCollisionRadius + 0.05;
    if (checkCollision(terrain, headWorld.x, headWorld.y, headWorld.z, safetyRadius, chestSystem, campfireSystem, furnaceSystem, loomSystem, bedSystem, mobSystem, treeSystem)) {
        const vx = Math.floor(headWorld.x);
        const vy = Math.floor(headWorld.y);
        const vz = Math.floor(headWorld.z);
        const voxelCenter = new THREE.Vector3(vx + 0.5, vy + 0.5, vz + 0.5);
        const outDir = new THREE.Vector3().subVectors(headWorld, voxelCenter);
        if (outDir.length() < 0.01) outDir.set(0, 1, 0);
        outDir.normalize();
        camRaycaster.set(headWorld, outDir);
        camRaycaster.far = 1;
        camRaycaster.near = 0;
        const hitsOut = camRaycaster.intersectObjects(rayColliders, true);
        if (hitsOut.length > 0) {
            const hit = hitsOut[0];
            camWorld.copy(hit.point).add(outDir.multiplyScalar(cameraBlockOffset));
        }
    }

    // Barrier: treat the camera as a sphere — if it would intersect any block/entity,
    // pull it back toward the head until the sphere is clear. Stops clipping through
    // corners and walls when only the center ray missed.
    const barrierRadius = cameraCollisionRadius + 0.02;
    const barrierStep = 0.06;
    const maxBarrierSteps = 45;
    for (let i = 0; i < maxBarrierSteps; i++) {
        if (!checkCollision(terrain, camWorld.x, camWorld.y, camWorld.z, barrierRadius, chestSystem, campfireSystem, furnaceSystem, loomSystem, bedSystem, mobSystem, treeSystem)) break;
        _toHead.subVectors(headWorld, camWorld);
        const dist = _toHead.length();
        if (dist < 0.01) break;
        _toHead.normalize();
        camWorld.addScaledVector(_toHead, Math.min(barrierStep, dist));
    }

    camera.position.copy(player.worldToLocal(camWorld));
}

function animate() {
    requestAnimationFrame(animate);
    if (webglContextLost || webglUnavailable) return;

    const now = performance.now();
    const delta = (now - lastTime) / 1000;
    lastTime = now;

    // Expire stale block-breaking progress and hide crack overlay after a short delay
    if (terrainHitProgress.size > 0) {
        for (const [key, prog] of terrainHitProgress.entries()) {
            const last = prog.lastTime || 0;
            if (now - last > TERRAIN_PROGRESS_MEMORY_MS) {
                terrainHitProgress.delete(key);
                clearBlockBreakOverlayForKey(key);
            }
        }
    }

    // Pause game loop if paused (still render but don't update)
    if (gamePaused) {
        renderer.render(scene, camera);
        return;
    }

    // Don't load chunks or run game logic until terrain textures are ready (avoids untextured first chunks)
    if (!terrainAtlasReady) {
        renderer.render(scene, camera);
        return;
    }

    controls.updateMovement(delta);

    // --- Push player up only when stuck in the ground (feet), not when touching trunk/ceiling ---
    if (isPlayerStuckInGround(player.position.x, player.position.z, player.position.y)) {
        let unstuckY = player.position.y;
        let attempts = 0;
        while (isPlayerStuckInGround(player.position.x, player.position.z, unstuckY) && attempts < 10) {
            unstuckY += 0.5;
            attempts++;
        }
        player.position.y = unstuckY;
    }

    // Extra safety: if we somehow ended up embedded in walls/corners (not just
    // feet in the ground), snap up to the nearest surface in our footprint.
    snapPlayerOutOfTerrainIfEmbedded();

    // Track last safe-on-ground position after movement/unstuck so we can
    // recover from falling into the void or partially generated terrain.
    updateLastSafeChunkPosition();

    // --- Void protection ---
    if (player.position.y < -10) {
        if (lastSafeChunkPosition) {
            player.position.copy(lastSafeChunkPosition);
            if (controls && typeof controls.notifyTeleported === 'function') {
                controls.notifyTeleported(lastSafeChunkPosition.y);
            }
        } else {
            const x = Math.floor(player.position.x);
            const z = Math.floor(player.position.z);
            for (let y = terrain.height - 1; y >= 0; y--) {
                if (terrain.getVoxelAt(x, y, z) !== 0) {
                    const safeY = y + 1 + 0.001;
                    player.position.set(x + 0.5, safeY, z + 0.5);
                    if (controls && typeof controls.notifyTeleported === 'function') {
                        controls.notifyTeleported(safeY);
                    }
                    break;
                }
            }
        }
    }

    // --- Cactus contact damage for player ---
    applyCactusDamageToPlayer(delta);

    // --- Update terrain chunks around player ---
    terrain.updateChunks(player.position.x, player.position.z);

    // --- Update water simulation (queue-based; bounded per-frame) ---
    if (waterSystem && typeof waterSystem.update === 'function') {
        waterSystem.update(delta);
    }

    // Frustum culling: only render chunk meshes that are in the camera view (no draw calls for chunks behind/outside view)
    if (terrain.chunks && terrain.chunks.size > 0) {
        if (!_chunkFrustum) _chunkFrustum = new THREE.Frustum();
        if (!_chunkProjScreenMatrix) _chunkProjScreenMatrix = new THREE.Matrix4();
        _chunkProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _chunkFrustum.setFromProjectionMatrix(_chunkProjScreenMatrix);
        for (const root of terrain.chunks.values()) {
            if (root.isGroup) {
                root.visible = true;
                for (const c of root.children) {
                    c.visible = _chunkFrustum.intersectsObject(c);
                }
            } else {
                root.visible = _chunkFrustum.intersectsObject(root);
            }
        }
    }

    // Ensure tree meshes exist for all currently loaded chunks, even if those chunks
    // were generated before the tree system or model finished loading.
    if (treeSystem && terrain.chunks && typeof treeSystem.onChunkLoad === 'function' && typeof treeSystem.hasTreesInChunk === 'function') {
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            if (!treeSystem.hasTreesInChunk(cx, cz)) {
                treeSystem.onChunkLoad(cx, cz);
            }
        }
    }
    // Ensure stone pebbles exist for all currently loaded chunks, even if those chunks
    // were generated before the stone pebble system or model finished loading.
    if (stonePebblesSystem && terrain.chunks && typeof stonePebblesSystem.onChunkLoad === 'function' && typeof stonePebblesSystem.hasPebblesInChunk === 'function') {
        for (const key of terrain.chunks.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            if (!stonePebblesSystem.hasPebblesInChunk(cx, cz)) {
                stonePebblesSystem.onChunkLoad(cx, cz);
            }
        }
    }

    // --- FPS smoothing ---
    const instantFps = delta > 0 ? 1 / delta : 60;
    fpsSmoothed = fpsSmoothed * 0.85 + instantFps * 0.15;

    // --- Performance overlay (F3): update stats and chunk outlines ---
    if (performanceOverlayOpen) {
        const perfFps = document.getElementById('perfFps');
        const perfChunks = document.getElementById('perfChunks');
        const perfRenderDist = document.getElementById('perfRenderDist');
        const perfEntities = document.getElementById('perfEntities');
        const perfMobs = document.getElementById('perfMobs');
        if (perfFps) perfFps.textContent = `FPS: ${Math.round(fpsSmoothed)}`;
        if (perfChunks) perfChunks.textContent = `Chunks loaded: ${terrain.chunks ? terrain.chunks.size : 0}`;
        if (perfRenderDist) perfRenderDist.textContent = `Render distance: ${terrain.renderDistance != null ? terrain.renderDistance : '—'}`;
        const dropCount = itemDropSystem ? itemDropSystem.getCount() : 0;
        const entityCount = (chestSystem && chestSystem.chests ? chestSystem.chests.length : 0) + (campfireSystem && campfireSystem.campfires ? campfireSystem.campfires.length : 0) + dropCount;
        if (perfEntities) perfEntities.textContent = `Entities: ${entityCount}`;
        if (perfMobs) perfMobs.textContent = `Mobs: ${mobSystem && mobSystem.mobs ? mobSystem.mobs.length : 0}`;

        if (terrain.chunks && scene) {
            if (!chunkOutlinesGroup) {
                chunkOutlinesGroup = new THREE.Group();
                chunkOutlinesGroup.name = 'ChunkOutlines';
            }
            while (chunkOutlinesGroup.children.length) {
                const c = chunkOutlinesGroup.children[0];
                chunkOutlinesGroup.remove(c);
                if (c.geometry) c.geometry.dispose();
                if (c.material) c.material.dispose();
            }
            const cs = terrain.chunkSize || 16;
            const h = terrain.height || 32;
            const mat = new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.7 });
            for (const key of terrain.chunks.keys()) {
                const [cx, cz] = key.split(',').map(Number);
                const geom = new THREE.BoxGeometry(cs, h, cs);
                const edges = new THREE.EdgesGeometry(geom);
                const line = new THREE.LineSegments(edges, mat.clone());
                line.position.set(cx * cs + cs / 2, h / 2, cz * cs + cs / 2);
                chunkOutlinesGroup.add(line);
            }
            mat.dispose();
            if (chunkOutlinesGroup.parent !== scene) scene.add(chunkOutlinesGroup);
        }
    }

    // walls removed
    sky.update(delta);
    if (weatherEffects && typeof weatherEffects.update === 'function') {
        weatherEffects.update(delta);
    }
    particleSystem.update();
    mobSystem.update(delta, player.position);
    if (itemDropSystem) itemDropSystem.update(delta);
    if (projectileSystem) projectileSystem.update(delta);
    if (treeSystem && typeof treeSystem.update === 'function') treeSystem.update(delta);
    if (campfireSystem && typeof campfireSystem.update === 'function') campfireSystem.update(delta);
    if (furnaceSystem && typeof furnaceSystem.update === 'function') furnaceSystem.update(delta);

    // resolve camera collisions each frame so camera/tools don't clip through geometry
    resolveCameraCollision();
    updateNearBlockClipping();


    // --- Compass, Clock, Coords, Health (UI overlays) ---
    const homePosition = (bedSystem && bedSystem.beds && bedSystem.beds.length > 0 && spawnPosition)
        ? spawnPosition.clone()
        : null;
    updateCompass(camera, player.position, homePosition);
    updateClock(sky);
    // --- World / player temperature + season HUD (weather from weatherEffects; wetness + shelter + hypothermia) ---
    if (typeof sky.getTime === 'function' && typeof sky.getDayCount === 'function') {
        const days = sky.getDayCount();
        const dayOfYear = (days % 120); // simple 4-season cycle over 120 days
        const yearT = dayOfYear / 120;  // 0..1 across the "year"

        let seasonName = 'Spring';
        if (yearT >= 0.25 && yearT < 0.5) seasonName = 'Summer';
        else if (yearT >= 0.5 && yearT < 0.75) seasonName = 'Autumn';
        else if (yearT >= 0.75) seasonName = 'Winter';

        const px = Math.floor(player.position.x);
        const pz = Math.floor(player.position.z);
        const groundY = getGroundHeight(px, pz);
        const biomeInfo = getBiomeInfoAt(px, pz, computeBaseHeight(px, pz));

        const elevationBand = Math.floor(groundY / 16);
        const timeBand = Math.floor(sky.getTime() / 0.5);
        const biomeKey = biomeInfo ? biomeInfo.biome : 'unknown';

        const wxMode = (weatherEffects && typeof weatherEffects.getMode === 'function')
            ? weatherEffects.getMode()
            : (typeof window !== 'undefined' && window._weatherState) || 'clear';

        if (!window._tempCache) {
            window._tempCache = {
                biomeKey: null,
                elevationBand: null,
                timeBand: null,
                weatherMode: null,
                worldTemp: 20,
                playerTemp: 20,
                wetness: 0,
                hypothermiaAccumulator: 0,
            };
        }

        const cache = window._tempCache;
        if (typeof cache.wetness !== 'number') cache.wetness = 0;
        if (typeof cache.hypothermiaAccumulator !== 'number') cache.hypothermiaAccumulator = 0;

        const needsRecalc =
            cache.biomeKey !== biomeKey ||
            cache.elevationBand !== elevationBand ||
            cache.timeBand !== timeBand ||
            cache.weatherMode !== wxMode;

        if (needsRecalc) {
            const seasonalPhase = Math.cos(yearT * Math.PI * 2);
            let targetWorldTemp = 10 - seasonalPhase * 10;

            if (biomeInfo) {
                if (biomeInfo.biome === 'desert') targetWorldTemp += 5;
                if (biomeInfo.biome === 'swamp') targetWorldTemp += 2;
                if (biomeInfo.biome === 'ocean') targetWorldTemp -= 2;
                if (biomeInfo.biome === 'forest') targetWorldTemp -= 0.5;
                if (biomeInfo.biome === 'mountains') targetWorldTemp -= 4;
            }

            const elevationAboveSea = groundY - SEA_LEVEL;
            if (elevationAboveSea > 0) {
                targetWorldTemp -= elevationAboveSea * 0.1;
            }

            // Day/night swing: warmest around mid-afternoon, coldest before dawn.
            const hour = sky.getTime();
            const diurnalPhase = Math.cos(((hour - 15) / 24) * Math.PI * 2);
            targetWorldTemp += diurnalPhase * 4.5;

            if (wxMode === 'lightrain') targetWorldTemp -= 1;
            else if (wxMode === 'rain') targetWorldTemp -= 2;
            else if (wxMode === 'heavyrain') targetWorldTemp -= 3;
            else if (wxMode === 'storm') targetWorldTemp -= 4;
            else if (wxMode === 'snow') targetWorldTemp -= 8;

            targetWorldTemp = Math.max(-30, Math.min(45, targetWorldTemp));

            const comfortTarget = 20;
            const targetPlayerTemp = targetWorldTemp + (comfortTarget - targetWorldTemp) * 0.2;

            cache.biomeKey = biomeKey;
            cache.elevationBand = elevationBand;
            cache.timeBand = timeBand;
            cache.weatherMode = wxMode;
            cache.targetWorldTemp = targetWorldTemp;
            cache.targetPlayerTemp = targetPlayerTemp;
            cache.lastUpdateTime = performance.now();
        }

        const now = performance.now();
        const dtSeconds = cache.lastUpdateTime ? (now - cache.lastUpdateTime) / 1000 : 0;
        const lerpFactor = Math.max(0, Math.min(1, dtSeconds / 1.5));

        cache.worldTemp = cache.worldTemp + (cache.targetWorldTemp - cache.worldTemp) * lerpFactor;
        cache.playerTemp = cache.playerTemp + (cache.targetPlayerTemp - cache.playerTemp) * lerpFactor;
        cache.lastUpdateTime = now;

        const headY = player.position.y + playerHeight;
        const precip = weatherHasPrecipitation(wxMode);
        const sheltered = isShelteredFromPrecipitation(player.position.x, headY, player.position.z);
        const exposedToPrecip = precip && !sheltered;

        if (weatherEffects && typeof weatherEffects.setAutoContext === 'function') {
            weatherEffects.setAutoContext({
                seasonName,
                biome: biomeKey,
                worldTempC: cache.worldTemp,
                hour: sky.getTime(),
                sheltered,
            });
        }

        const dryRate = 0.14;
        if (wxMode === 'clear') {
            cache.wetness = Math.max(0, cache.wetness - dryRate * delta);
        } else if (!exposedToPrecip) {
            cache.wetness = Math.max(0, cache.wetness - dryRate * 0.9 * delta);
        } else {
            let soak = 0;
            if (wxMode === 'storm' || wxMode === 'heavyrain') soak = 0.22;
            else if (wxMode === 'rain') soak = 0.14;
            else if (wxMode === 'lightrain') soak = 0.07;
            else if (wxMode === 'snow') soak = 0.055;
            cache.wetness = Math.min(1, cache.wetness + soak * delta);
        }

        const wetChillC = cache.wetness * 14;
        const worldTempC = cache.worldTemp;
        const shelterBufferC = sheltered ? 1.8 : 0;
        const displayedPlayerTemp = cache.playerTemp - wetChillC + shelterBufferC;

        const hypoThreshold = 9;
        if (!creativeMode && displayedPlayerTemp < hypoThreshold) {
            const severity = (hypoThreshold - displayedPlayerTemp) / hypoThreshold;
            const wetMult = 1 + cache.wetness * 1.35;
            cache.hypothermiaAccumulator += delta * severity * wetMult * 0.22;
            if (cache.hypothermiaAccumulator >= 1) {
                takeDamage(1);
                cache.hypothermiaAccumulator = 0;
            }
        } else {
            cache.hypothermiaAccumulator = Math.max(0, cache.hypothermiaAccumulator - delta * 0.6);
        }

        updateTemperatureAndSeason({
            worldTempC,
            playerTempC: displayedPlayerTemp,
            seasonName,
            weatherLabel: weatherModeToHudLabel(wxMode),
            wetness: cache.wetness,
            underCover: precip && sheltered,
        });

        if (typeof console !== 'undefined') {
            const nowMs = performance.now();
            if (!window._tempDebugLastLog || nowMs - window._tempDebugLastLog > 5000) {
                console.log('[WeatherDebug]', {
                    biome: biomeKey,
                    season: seasonName,
                    weather: wxMode,
                    wetness: cache.wetness.toFixed(2),
                    sheltered: precip ? sheltered : null,
                    worldTempC: worldTempC.toFixed(1),
                    playerTempC: displayedPlayerTemp.toFixed(1),
                    position: { x: px, z: pz, groundY },
                });
                window._tempDebugLastLog = nowMs;
            }
        }
    }
    updateCoords(player);
    const maxHealthNow = getCurrentMaxHealth();
    updateHealthBar(playerHealth, maxHealthNow);
    // Stamina is tracked in controls; expose a normalized value via player.userData if present
    if (typeof player.userData.stamina === 'number') {
        updateStaminaBar(player.userData.stamina);
    }

    // update held model visibility each frame
    updateHeldModelVisibility();

    // Live campfire/furnace UI timers (update while UI is open)
    if (openCampfire && campfireUI && document.contains(campfireUI) && campfireFuelBarEl && campfireProgBarEl && window.currentCampfireMesh && campfireSystem) {
        const fuel = campfireSystem.getFuelRemaining(window.currentCampfireMesh) || 0;
        const prog = campfireSystem.getCookProgress(window.currentCampfireMesh) || 0;
        campfireFuelBarEl.textContent = `Fuel: ${fuel.toFixed(1)}s`;
        campfireProgBarEl.textContent = `Cooking: ${(prog * 100 / CAMPFIRE_COOK_TIME).toFixed(0)}%`;
    }
    if (openFurnace && furnaceUI && document.contains(furnaceUI) && furnaceFuelBarEl && furnaceProgBarEl && window.currentFurnaceMesh && furnaceSystem) {
        const fuel = furnaceSystem.getFuelRemaining(window.currentFurnaceMesh) || 0;
        const prog = furnaceSystem.getSmeltProgress(window.currentFurnaceMesh) || 0;
        furnaceFuelBarEl.textContent = `Fuel: ${fuel.toFixed(1)}s`;
        furnaceProgBarEl.textContent = `Smelting: ${(prog * 100 / FURNACE_SMELT_TIME).toFixed(0)}%`;
    }
    if (openLoom && loomUI && document.contains(loomUI) && loomProgBarEl && window.currentLoomMesh && loomSystem) {
        const prog = loomSystem.getLoomProgress(window.currentLoomMesh) || 0;
        loomProgBarEl.textContent = `Spinning: ${(prog * 100 / LOOM_PROCESS_TIME).toFixed(0)}%`;
    }

    // Update block outline/highlight
    updateBlockOutline();

    renderer.render(scene, camera);
}

// Block outline system - shows which block you're looking at
function updateBlockOutline() {
    if (gamePaused || backpackOpen || craftingOpen || openChest || openCampfire || openFurnace || openLoom || devConsoleOpen || referenceOverlayOpen) {
        if (blockOutline) {
            blockOutline.visible = false;
        }
        updateLookAtCard(null);
        return;
    }

    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
    raycaster.set(origin, dir);
    
    const terrainChunks = Array.from(terrain.chunks.values());
    const chestMeshes = chestSystem ? chestSystem.chests : [];
    const campfireMeshes = campfireSystem ? campfireSystem.campfires : [];
    const furnaceMeshes = furnaceSystem ? furnaceSystem.furnaces : [];
    const loomMeshes = loomSystem ? loomSystem.looms : [];
    const bedMeshes = bedSystem ? bedSystem.beds : [];
    const treeMeshes = treeSystem ? treeSystem.trees : [];
    const pebbleMeshes = stonePebblesSystem ? stonePebblesSystem.getPebbleMeshes() : [];
    const colliders = [...mobSystem.getRaycastBlockers(), ...terrainChunks, ...chestMeshes, ...campfireMeshes, ...furnaceMeshes, ...loomMeshes, ...bedMeshes, ...treeMeshes, ...pebbleMeshes];
    const ints = raycaster.intersectObjects(colliders, true);
    
    if (ints.length > 0) {
        const hit = ints[0];
        const hitPoint = hit.point.clone();
        let target = hit.object;

        let pebbleRoot = target;
        while (pebbleRoot && !pebbleRoot.userData.isStonePebble && pebbleRoot.parent) pebbleRoot = pebbleRoot.parent;
        if (pebbleRoot && pebbleRoot.userData.isStonePebble) {
            const bx = Math.floor(pebbleRoot.userData.pebbleX);
            const by = Math.floor(pebbleRoot.userData.pebbleY);
            const bz = Math.floor(pebbleRoot.userData.pebbleZ);
            updateLookAtCard({ name: 'Stone pebble' });
            if (!highlightedBlock || highlightedBlock.x !== bx || highlightedBlock.y !== by || highlightedBlock.z !== bz) {
                highlightedBlock = { x: bx, y: by, z: bz };
                if (!blockOutline) {
                    const geometry = new THREE.BoxGeometry(1.01, 1.01, 1.01);
                    const edges = new THREE.EdgesGeometry(geometry);
                    const material = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2, transparent: true, opacity: 0.8 });
                    blockOutline = new THREE.LineSegments(edges, material);
                    blockOutline.renderOrder = 1000;
                    scene.add(blockOutline);
                }
                blockOutline.position.set(bx + 0.5, by + 0.5, bz + 0.5);
            }
            blockOutline.visible = true;
            return;
        }

        let mobMesh = target;
        while (mobMesh && !mobMesh.userData.mobType && mobMesh.parent) {
            mobMesh = mobMesh.parent;
        }
        if (mobMesh && mobMesh.userData.mobType && mobSystem.getMobByMesh) {
            const mob = mobSystem.getMobByMesh(mobMesh);
            if (mob) {
                const displayName = mob.type.charAt(0).toUpperCase() + mob.type.slice(1);
                updateLookAtCard({ name: displayName, health: mob.health, maxHealth: mob.maxHealth });
                if (blockOutline) blockOutline.visible = false;
                highlightedBlock = null;
                return;
            }
        }
        
        // Find the top-level chest/campfire/furnace/loom/bed mesh if we hit a child
        while (target && !target.userData.isChest && !target.userData.isCampfire && !target.userData.isFurnace && !target.userData.isLoom && !target.userData.isBed && target.parent) {
            target = target.parent;
        }
        
        // If we hit a chest, campfire, furnace, loom, or bed model, show outline at its position
        if (target && (target.userData.isChest || target.userData.isCampfire || target.userData.isFurnace || target.userData.isLoom || target.userData.isBed)) {
            const blockX = Math.floor(target.position.x);
            const blockY = Math.floor(target.position.y);
            const blockZ = Math.floor(target.position.z);
            
            if (!highlightedBlock || 
                highlightedBlock.x !== blockX || 
                highlightedBlock.y !== blockY || 
                highlightedBlock.z !== blockZ) {
                
                highlightedBlock = { x: blockX, y: blockY, z: blockZ };
                
                if (!blockOutline) {
                    const geometry = new THREE.BoxGeometry(1.01, 1.01, 1.01);
                    const edges = new THREE.EdgesGeometry(geometry);
                    const material = new THREE.LineBasicMaterial({ 
                        color: 0xffffff, 
                        linewidth: 2,
                        transparent: true,
                        opacity: 0.8
                    });
                    blockOutline = new THREE.LineSegments(edges, material);
                    blockOutline.renderOrder = 1000;
                    scene.add(blockOutline);
                }
                
                blockOutline.position.set(blockX + 0.5, blockY + 0.5, blockZ + 0.5);
                blockOutline.visible = true;
            }
            let label = 'Block';
            if (target.userData.isChest) label = 'Chest';
            else if (target.userData.isCampfire) label = 'Campfire';
            else if (target.userData.isFurnace) label = 'Furnace';
            else if (target.userData.isLoom) label = 'Loom';
            else if (target.userData.isBed) label = 'Bed';
            updateLookAtCard({ name: label });
            return;
        }
        
        // For terrain blocks, compute the voxel using the face normal
        // This matches the logic used for placing/mining blocks, so it's stable
        let worldNormal = new THREE.Vector3();
        if (hit.face) {
            worldNormal.copy(hit.face.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
        } else {
            worldNormal.copy(dir).negate();
        }

        // Move slightly back along the normal so we get the solid block we hit, not the air in front
        const blockPoint = hitPoint.clone().add(worldNormal.clone().multiplyScalar(-0.5));
        const blockX = Math.floor(blockPoint.x);
        const blockY = Math.floor(blockPoint.y);
        const blockZ = Math.floor(blockPoint.z);

        const voxelType = terrain.getVoxelAt(blockX, blockY, blockZ);
        
        // Only show outline if it's a solid block (not air)
        if (voxelType !== 0) {
            updateLookAtCard({ name: getBlockName(voxelType) });
            // Check if we're looking at a different block
            if (!highlightedBlock || 
                highlightedBlock.x !== blockX || 
                highlightedBlock.y !== blockY || 
                highlightedBlock.z !== blockZ) {
                
                highlightedBlock = { x: blockX, y: blockY, z: blockZ };
                
                // Create or update outline
                if (!blockOutline) {
                    const geometry = new THREE.BoxGeometry(1.01, 1.01, 1.01);
                    const edges = new THREE.EdgesGeometry(geometry);
                    const material = new THREE.LineBasicMaterial({ 
                        color: 0xffffff, 
                        linewidth: 2,
                        transparent: true,
                        opacity: 0.8
                    });
                    blockOutline = new THREE.LineSegments(edges, material);
                    blockOutline.renderOrder = 1000; // Render on top
                    scene.add(blockOutline);
                }
                
                // Position outline at block center
                blockOutline.position.set(blockX + 0.5, blockY + 0.5, blockZ + 0.5);
                blockOutline.visible = true;
            }
        } else {
            // Air block - hide outline
            updateLookAtCard(null);
            if (blockOutline) {
                blockOutline.visible = false;
            }
            highlightedBlock = null;
        }
    } else {
        updateLookAtCard(null);
        if (blockOutline) {
            blockOutline.visible = false;
        }
        highlightedBlock = null;
    }
}

if (!webglUnavailable) animate();

export { scene, camera, renderer, terrain, mobSystem };
