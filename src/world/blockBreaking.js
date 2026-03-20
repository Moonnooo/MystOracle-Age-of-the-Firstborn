import * as THREE from 'three';
import { BLOCK_IDS } from './blocksRegistry.js';

export const LOG_BLOCK_ID = BLOCK_IDS.LOG;
export const LEAVES_BLOCK_ID_TREE = BLOCK_IDS.LEAVES;

export function makeBlockKey(x, y, z) {
    return `${x}|${y}|${z}`;
}

export function classifyToolForBlockBreaking(current, getSlotTypeFn) {
    if (!current) return 'hand';
    const t = typeof current === 'string' ? current : getSlotTypeFn(current);
    if (t === 'pickaxe' || t === 'stone_pickaxe') return t;
    if (t === 'axe' || t === 'stone_axe') return t;
    if (t === 'spade') return 'spade';
    return 'other';
}

export function getHitsToBreakBlock(voxelType, toolKind) {
    const isStoneLike =
        voxelType === BLOCK_IDS.STONE ||
        voxelType === BLOCK_IDS.COAL_ORE ||
        voxelType === BLOCK_IDS.IRON_ORE ||
        voxelType === BLOCK_IDS.GOLD_ORE;
    const isSoilLike =
        voxelType === BLOCK_IDS.DIRT ||
        voxelType === BLOCK_IDS.GRASS ||
        voxelType === BLOCK_IDS.SAND ||
        voxelType === BLOCK_IDS.SNOW;
    const isWoodLike =
        voxelType === BLOCK_IDS.LOG ||
        voxelType === BLOCK_IDS.LEAVES ||
        voxelType === BLOCK_IDS.PLANKS;
    const isCactus = voxelType === BLOCK_IDS.CACTUS;

    if (isStoneLike) {
        if (toolKind === 'pickaxe') return 2;
        if (toolKind === 'stone_pickaxe') return 3;
        if (toolKind === 'hand' || toolKind === 'other') return 14;
        if (toolKind === 'axe' || toolKind === 'stone_axe' || toolKind === 'spade') return 10;
    }
    if (isSoilLike) {
        if (toolKind === 'spade') return 1;
        if (toolKind === 'axe' || toolKind === 'stone_axe') return 7;
        if (toolKind === 'pickaxe' || toolKind === 'stone_pickaxe') return 8;
        if (toolKind === 'hand' || toolKind === 'other') return 12;
    }
    if (isWoodLike) {
        if (toolKind === 'axe') return 1;
        if (toolKind === 'stone_axe') return 2;
        if (toolKind === 'pickaxe' || toolKind === 'stone_pickaxe') return 8;
        if (toolKind === 'spade') return 7;
        if (toolKind === 'hand' || toolKind === 'other') {
            return voxelType === BLOCK_IDS.LEAVES ? 6 : 12;
        }
    }
    if (isCactus) {
        if (toolKind === 'axe' || toolKind === 'stone_axe') return 2;
        if (toolKind === 'spade') return 3;
        if (toolKind === 'pickaxe' || toolKind === 'stone_pickaxe') return 6;
        if (toolKind === 'hand' || toolKind === 'other') return 8;
    }

    if (toolKind === 'hand' || toolKind === 'other') return 8;
    return 3;
}

export function applyCactusFallAfterBreak(terrain, vx, vy, vz, removedType) {
    if (removedType !== BLOCK_IDS.CACTUS) return;
    const maxY = terrain.height || 64;
    let y = vy + 1;
    const cactusYs = [];
    while (y < maxY) {
        const t = terrain.getVoxelAt(vx, y, vz);
        if (t === BLOCK_IDS.CACTUS) {
            cactusYs.push(y);
            y++;
        } else {
            break;
        }
    }
    if (!cactusYs.length) return;
    for (const fromY of cactusYs) {
        const toY = fromY - 1;
        terrain.setVoxel(vx, fromY, vz, BLOCK_IDS.AIR);
        terrain.setVoxel(vx, toY, vz, BLOCK_IDS.CACTUS);
    }
}

export function applyTreeColumnCollapse({
    terrain,
    vx,
    vy,
    vz,
    removedType,
    itemDropSystem,
    particleSystem,
    blockTypes,
}) {
    if (removedType !== LOG_BLOCK_ID) return;
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
        terrain.setVoxel(x, y, z, BLOCK_IDS.AIR);
        queue.push({ x, y, z, type: t });
    }

    enqueue(vx, vy, vz);
    const seeds = [
        [vx + 1, vy, vz],
        [vx - 1, vy, vz],
        [vx, vy, vz + 1],
        [vx, vy, vz - 1],
        [vx, vy + 1, vz],
        [vx, vy - 1, vz],
    ];
    for (const [sx, sy, sz] of seeds) enqueue(sx, sy, sz);

    while (queue.length > 0) {
        const { x, y, z, type } = queue.shift();
        const origin = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
        const color = blockTypes[type] && blockTypes[type].color ? blockTypes[type].color : [0.5, 0.5, 0.5];
        particleSystem.spawn(origin, downDir, null, color);

        const randOffset = () => new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4);
        if (type === LOG_BLOCK_ID) {
            itemDropSystem.spawnDrop('wood', 1, origin.clone().add(randOffset()));
        } else {
            itemDropSystem.spawnDrop('leaves', 1, origin.clone().add(randOffset()));
            if (Math.random() < 0.5) {
                const sticks = 1 + Math.floor(Math.random() * 2);
                for (let i = 0; i < sticks; i++) {
                    itemDropSystem.spawnDrop('stick', 1, origin.clone().add(randOffset()));
                }
            }
            if (Math.random() < 0.25) {
                itemDropSystem.spawnDrop('sapling', 1, origin.clone().add(randOffset()));
            }
        }

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
