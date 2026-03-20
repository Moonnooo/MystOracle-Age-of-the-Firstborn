// src/assets/textures.js
import * as THREE from 'three';
import { ASSET_BASE } from './assetBase.js';

export const TEXTURE_PATHS = {
    grassSide: ASSET_BASE + 'textures/grass_side.png',
    dirt: ASSET_BASE + 'textures/dirt.png',
    gun: ASSET_BASE + 'textures/AK-47.png',
    campfire: ASSET_BASE + 'textures/campfire.png',
    chest: ASSET_BASE + 'textures/chest.png',
    pickaxe: ASSET_BASE + 'textures/pickaxe.png',
};

export const textures = {};

export function loadAllTextures() {
    for (const key in TEXTURE_PATHS) {
        textures[key] = new THREE.TextureLoader().load(TEXTURE_PATHS[key]);
    }
}

export function getTexture(name) {
    return textures[name] || null;
}

// Call loadAllTextures() once at startup
