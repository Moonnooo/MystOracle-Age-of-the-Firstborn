// Item icon URL helper. Used by renderer.js to show item icons in UI.
// For now we keep it minimal: map a few known item ids to filenames, and
// fall back to a generic placeholder icon for unknown items.

import { ASSET_BASE } from '../assets/assetBase.js';

// Simple mapping from logical item type → icon filename.
// Extend this as you add more items.
const ITEM_ICON_FILES = {
    wood: 'icons/wood.png',
    stick: 'icons/stick.png',
    sapling: 'icons/sapling.png',
    stone: 'icons/stone.png',
    coal: 'icons/coal.png',
    iron_ore: 'icons/iron_ore.png',
    // armour / jewellery examples
    helmet: 'icons/helmet.png',
    chestplate: 'icons/chestplate.png',
    leggings: 'icons/leggings.png',
    boots: 'icons/boots.png',
    ring: 'icons/ring.png',
    necklace: 'icons/necklace.png',
};

/**
 * Return the URL for an item's icon image.
 * @param {string} itemType - logical type id used in inventory (e.g. "wood", "stone").
 * @returns {string} URL suitable for <img src="...">.
 */
export function getItemIconUrl(itemType) {
    const fileName = ITEM_ICON_FILES[itemType] || 'icons/placeholder.png';
    // Ensure single trailing slash on ASSET_BASE
    const base = (ASSET_BASE || './').replace(/\/?$/, '/');
    return base + fileName;
}

