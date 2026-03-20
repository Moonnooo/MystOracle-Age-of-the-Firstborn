/**
 * Flow-based river network.
 *
 * - Sources are picked from deterministic high-elevation points.
 * - Each source traces one downhill N/S/E/W path.
 * - Paths can merge into existing rivers.
 * - Width increases with downstream distance.
 * - No per-tile noise threshold classification.
 */

import { computeBaseHeight } from './baseHeight.js';

const DEFAULT_SEA_LEVEL = 18;
const REGION_SIZE = 256;
const REGION_MARGIN = 96;
const SOURCE_SPACING = 96;
const SOURCE_MIN_ELEVATION = DEFAULT_SEA_LEVEL + 12;
const MAX_FLOW_STEPS = 1400;
const TURN_PENALTY = 0.35;

const CARDINALS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

const networkCache = new Map(); // regionKey -> { river:Set<string>, center:Set<string> }

function tileKey(x, z) {
    return `${x},${z}`;
}

function regionKey(rx, rz) {
    return `${rx},${rz}`;
}

function hash01(x, z, salt = 0) {
    const s = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
    return s - Math.floor(s);
}

function markTile(state, x, z, center = false) {
    const k = tileKey(x, z);
    state.river.add(k);
    if (center) state.center.add(k);
}

function markWidth(state, x, z, dirX, dirZ, widthTiles) {
    markTile(state, x, z, true);
    if (widthTiles <= 1) return;
    const perpX = -dirZ;
    const perpZ = dirX;
    if (perpX === 0 && perpZ === 0) return;
    const radius = Math.max(1, Math.floor(widthTiles / 2));
    for (let i = -radius; i <= radius; i++) {
        if (i === 0) continue;
        markTile(state, x + perpX * i, z + perpZ * i, false);
    }
}

function chooseNextStep(x, z, prevDirX, prevDirZ) {
    const h = computeBaseHeight(x, z);
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < CARDINALS.length; i++) {
        const dx = CARDINALS[i][0];
        const dz = CARDINALS[i][1];
        const nx = x + dx;
        const nz = z + dz;
        const nh = computeBaseHeight(nx, nz);
        if (nh > h) continue; // flow downhill or flat only

        let score = nh;
        if (prevDirX !== 0 || prevDirZ !== 0) {
            const sameDir = prevDirX === dx && prevDirZ === dz;
            if (!sameDir) score += TURN_PENALTY;
        }

        if (score < bestScore) {
            bestScore = score;
            best = { x: nx, z: nz, dx, dz };
        }
    }

    return best;
}

function traceRiverFromSource(state, sourceX, sourceZ, minX, maxX, minZ, maxZ) {
    let x = sourceX;
    let z = sourceZ;
    let prevDirX = 0;
    let prevDirZ = 0;
    const seen = new Set();

    for (let step = 0; step < MAX_FLOW_STEPS; step++) {
        if (x < minX || x > maxX || z < minZ || z > maxZ) break;
        const k = tileKey(x, z);
        if (seen.has(k)) break;
        seen.add(k);

        const h = computeBaseHeight(x, z);
        if (h <= DEFAULT_SEA_LEVEL) {
            markWidth(state, x, z, prevDirX, prevDirZ, Math.min(4, 1 + Math.floor(step / 90)));
            break;
        }

        if (step > 0 && state.river.has(k)) break; // merge into existing river

        const widthTiles = Math.min(4, 1 + Math.floor(step / 90));
        markWidth(state, x, z, prevDirX, prevDirZ, widthTiles);

        const next = chooseNextStep(x, z, prevDirX, prevDirZ);
        if (!next) break;

        x = next.x;
        z = next.z;
        prevDirX = next.dx;
        prevDirZ = next.dz;
    }
}

function generateRegionNetwork(rx, rz) {
    const key = regionKey(rx, rz);
    if (networkCache.has(key)) return;

    const state = { river: new Set(), center: new Set() };
    const minX = rx * REGION_SIZE;
    const minZ = rz * REGION_SIZE;
    const maxX = minX + REGION_SIZE - 1;
    const maxZ = minZ + REGION_SIZE - 1;

    const exMinX = minX - REGION_MARGIN;
    const exMinZ = minZ - REGION_MARGIN;
    const exMaxX = maxX + REGION_MARGIN;
    const exMaxZ = maxZ + REGION_MARGIN;

    const cellMinX = Math.floor(exMinX / SOURCE_SPACING);
    const cellMaxX = Math.floor(exMaxX / SOURCE_SPACING);
    const cellMinZ = Math.floor(exMinZ / SOURCE_SPACING);
    const cellMaxZ = Math.floor(exMaxZ / SOURCE_SPACING);

    for (let cx = cellMinX; cx <= cellMaxX; cx++) {
        for (let cz = cellMinZ; cz <= cellMaxZ; cz++) {
            const baseX = cx * SOURCE_SPACING + Math.floor(SOURCE_SPACING * 0.5);
            const baseZ = cz * SOURCE_SPACING + Math.floor(SOURCE_SPACING * 0.5);
            const jitterX = Math.floor((hash01(cx, cz, 1) - 0.5) * SOURCE_SPACING * 0.6);
            const jitterZ = Math.floor((hash01(cx, cz, 2) - 0.5) * SOURCE_SPACING * 0.6);
            const sx = baseX + jitterX;
            const sz = baseZ + jitterZ;

            if (sx < exMinX || sx > exMaxX || sz < exMinZ || sz > exMaxZ) continue;
            const sh = computeBaseHeight(sx, sz);
            if (sh < SOURCE_MIN_ELEVATION) continue;

            traceRiverFromSource(state, sx, sz, exMinX, exMaxX, exMinZ, exMaxZ);
        }
    }

    networkCache.set(key, state);
}

function ensureNetworkAround(wx, wz) {
    const rx = Math.floor(wx / REGION_SIZE);
    const rz = Math.floor(wz / REGION_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            generateRegionNetwork(rx + dx, rz + dz);
        }
    }
}

function queryRiver(wx, wz) {
    ensureNetworkAround(wx, wz);
    const rx = Math.floor(wx / REGION_SIZE);
    const rz = Math.floor(wz / REGION_SIZE);
    const k = tileKey(wx, wz);

    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            const net = networkCache.get(regionKey(rx + dx, rz + dz));
            if (!net) continue;
            if (net.river.has(k)) {
                return { river: true, center: net.center.has(k) };
            }
        }
    }
    return { river: false, center: false };
}

export function getRiverPathDistance(wx, wz) {
    return queryRiver(wx, wz).center ? 0 : 1;
}

export function isRiverCorridor(wx, wz) {
    return queryRiver(wx, wz).center;
}

export function isRiverCorridorDilated(wx, wz) {
    return queryRiver(wx, wz).river;
}

export function isRiverCorridorConnected(wx, wz) {
    return queryRiver(wx, wz).river;
}

export function canHaveRiverAtContinentalHeight(continentalY, seaLevel) {
    return continentalY > seaLevel - 1;
}

export function isRiverValleyFloor(wx, wz) {
    const h = computeBaseHeight(wx, wz);
    const minN = Math.min(
        computeBaseHeight(wx + 1, wz),
        computeBaseHeight(wx - 1, wz),
        computeBaseHeight(wx, wz + 1),
        computeBaseHeight(wx, wz - 1),
    );
    return h <= minN + 1;
}

export function getRiverColumnDepth(surfaceY, seaLevel) {
    const belowSea = Math.max(0, seaLevel - surfaceY);
    return Math.max(2, Math.min(6, 2 + Math.floor(belowSea / 3)));
}
