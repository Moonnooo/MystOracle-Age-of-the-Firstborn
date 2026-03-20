// src/blocks.js
import { getTexture } from '../assets/textures.js';

export const BLOCK_TYPES = {
    1: { name: 'dirt', color: [0.55, 0.27, 0.07], texture: 'dirt' },
    2: { name: 'stone', color: [0.5, 0.5, 0.5], texture: null },
    3: { name: 'grass', color: [0.2, 0.8, 0.2], texture: 'grassSide' },
    gun: { name: 'Gun', color: [0.7, 0.7, 0.7], texture: 'gun' },
    pickaxe: { name: 'Pickaxe', color: [0.7, 0.7, 0.7], texture: 'pickaxe' },
    campfire: { name: 'Campfire', color: [0.7, 0.4, 0.2], texture: 'campfire' },
    chest: { name: 'Chest', color: [0.8, 0.6, 0.3], texture: 'chest' },
    // ...add more as needed
};

export function getBlockTexture(type) {
    const block = BLOCK_TYPES[type];
    if (block && block.texture) return getTexture(block.texture);
    return null;
}

export function getBlockColor(type) {
    const block = BLOCK_TYPES[type];
    return block ? block.color : [1,1,1];
}

export function getBlockName(type) {
    return BLOCK_TYPES[type]?.name || 'unknown';
}

export function isValidBlockType(type) {
    return type in BLOCK_TYPES;
}
