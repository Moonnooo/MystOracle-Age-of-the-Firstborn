// Inventory logic for hotbar, backpack, stacking, slot helpers
// Extracted from renderer.js

// Hotbar: stores items as {type, count} for blocks, or 'gun'/'pickaxe'/'axe' for tools
export const hotbar = ['spear', 'pickaxe', 'axe', 'bow', 'spade', null, null, null, null];
export let selectedHotbar = 0;

// Backpack: 20 slots with same structure
export const backpackSlots = new Array(20).fill(null);

// Equipment: armour (head, body, legs, feet) + accessories (ring x2, necklace)
let equippedHead = null;
let equippedBody = null;
let equippedLegs = null;
let equippedFeet = null;
let equippedRing1 = null;
let equippedRing2 = null;
let equippedNecklace = null;

export function getEquippedHead() { return equippedHead; }
export function setEquippedHead(item) { equippedHead = item; }
export function getEquippedBody() { return equippedBody; }
export function setEquippedBody(item) { equippedBody = item; }
export function getEquippedLegs() { return equippedLegs; }
export function setEquippedLegs(item) { equippedLegs = item; }
export function getEquippedFeet() { return equippedFeet; }
export function setEquippedFeet(item) { equippedFeet = item; }
export function getEquippedRing1() { return equippedRing1; }
export function setEquippedRing1(item) { equippedRing1 = item; }
export function getEquippedRing2() { return equippedRing2; }
export function setEquippedRing2(item) { equippedRing2 = item; }
export function getEquippedNecklace() { return equippedNecklace; }
export function setEquippedNecklace(item) { equippedNecklace = item; }

export function isBodyArmour(slot) {
    if (!slot) return false;
    return getSlotType(slot) === 'body_armour';
}
export function isHelmet(slot) {
    if (!slot) return false;
    return getSlotType(slot) === 'helmet';
}
export function isLeggings(slot) {
    if (!slot) return false;
    return getSlotType(slot) === 'leggings';
}
export function isBoots(slot) {
    if (!slot) return false;
    return getSlotType(slot) === 'boots';
}
export function isRing(slot) {
    if (!slot) return false;
    return getSlotType(slot) === 'ring';
}
export function isNecklace(slot) {
    if (!slot) return false;
    return getSlotType(slot) === 'necklace';
}

const TOOL_TYPES = ['gun', 'spear', 'pickaxe', 'axe', 'stone_axe', 'stone_pickaxe', 'spade', 'bow'];

// Helper: create a block stack item (must be before IIFE below that uses it)
function createStackItem(type, count = 1) {
    if (TOOL_TYPES.includes(type)) return type;
    return { type, count: Math.min(Math.max(count, 0), 100) };
}

// Add 2 chests, 1 campfire, and 1 bed to backpack at start
import.meta && (() => {
    // Only run in module environments
    const items = [createStackItem('chest', 1), createStackItem('chest', 1), createStackItem('campfire', 1), createStackItem('bed', 1)];
    let idx = 0;
    for (let i = 0; i < backpackSlots.length && idx < items.length; i++) {
        if (!backpackSlots[i]) {
            backpackSlots[i] = items[idx++];
        }
    }
})();

// Helper: get count from a slot
export function getSlotCount(slot) {
    if (!slot) return 0;
    if (typeof slot === 'object' && slot.count) return slot.count;
    return 1; // tools
}

// Helper: get type from a slot
export function getSlotType(slot) {
    if (!slot) return null;
    if (typeof slot === 'object') return slot.type;
    return slot; // 'gun', 'pickaxe', or 'axe'
}

export { createStackItem };

// Craft 1 log (wood) -> 4 planks. Returns true if crafted.
export function craftLogToPlanks() {
    const planksType = 'planks';
    let found = -1;
    let inBackpack = true;
    for (let i = 0; i < backpackSlots.length; i++) {
        const slot = backpackSlots[i];
        if (slot && getSlotType(slot) === 'wood' && getSlotCount(slot) >= 1) {
            found = i;
            break;
        }
    }
    if (found === -1) {
        for (let i = 2; i < hotbar.length; i++) {
            const slot = hotbar[i];
            if (slot && getSlotType(slot) === 'wood' && getSlotCount(slot) >= 1) {
                found = i;
                inBackpack = false;
                break;
            }
        }
    }
    if (found === -1) return false;
    const arr = inBackpack ? backpackSlots : hotbar;
    const slot = arr[found];
    const newCount = getSlotCount(slot) - 1;
    arr[found] = newCount > 0 ? createStackItem('wood', newCount) : null;
    let remaining = 4;
    for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
        const s = backpackSlots[i];
        if (s && getSlotType(s) === planksType) {
            const add = Math.min(100 - getSlotCount(s), remaining);
            if (add > 0) {
                backpackSlots[i] = createStackItem(planksType, getSlotCount(s) + add);
                remaining -= add;
            }
        }
    }
    for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
        if (backpackSlots[i] == null) {
            const add = Math.min(100, remaining);
            backpackSlots[i] = createStackItem(planksType, add);
            remaining -= add;
        }
    }
    for (let i = 2; i < hotbar.length && remaining > 0; i++) {
        const s = hotbar[i];
        if (s && getSlotType(s) === planksType) {
            const add = Math.min(100 - getSlotCount(s), remaining);
            if (add > 0) {
                hotbar[i] = createStackItem(planksType, getSlotCount(s) + add);
                remaining -= add;
            }
        }
    }
    for (let i = 2; i < hotbar.length && remaining > 0; i++) {
        if (hotbar[i] == null) {
            const add = Math.min(100, remaining);
            hotbar[i] = createStackItem(planksType, add);
            remaining -= add;
        }
    }
    return true;
}

// Helper: consume materials from backpack then hotbar. Returns true if consumed.
function consumeMaterials(materials) {
    const remaining = { ...materials };
    const take = (arr, type, need) => {
        const needType = (typeof type === 'string' && /^\d+$/.test(type)) ? parseInt(type, 10) : type;
        for (let i = 0; i < arr.length && need > 0; i++) {
            const slot = arr[i];
            if (!slot || getSlotType(slot) !== needType) continue;
            const have = getSlotCount(slot);
            const takeCount = Math.min(have, need);
            need -= takeCount;
            arr[i] = takeCount >= have ? null : createStackItem(needType, have - takeCount);
        }
        return need;
    };
    for (const [type, count] of Object.entries(remaining)) {
        let need = count;
        need = take(backpackSlots, type, need);
        if (need > 0) need = take(hotbar, type, need);
        if (need > 0) return false;
    }
    return true;
}

// Add one tool to inventory (backpack first, then hotbar). Returns true if added.
function addTool(toolType) {
    for (let i = 0; i < backpackSlots.length; i++) {
        if (backpackSlots[i] == null) {
            backpackSlots[i] = toolType;
            return true;
        }
    }
    for (let i = 2; i < hotbar.length; i++) {
        if (hotbar[i] == null) {
            hotbar[i] = toolType;
            return true;
        }
    }
    return false;
}

// Stone axe: 2 stick + 3 stone -> 1 stone_axe
export function craftStoneAxe() {
    if (!consumeMaterials({ stick: 2, stone: 3 })) return false;
    return addTool('stone_axe');
}

// Stone pickaxe: 2 stick + 3 stone -> 1 stone_pickaxe
export function craftStonePickaxe() {
    if (!consumeMaterials({ stick: 2, stone: 3 })) return false;
    return addTool('stone_pickaxe');
}

// Spade: 2 stick + 2 stone -> 1 spade
export function craftSpade() {
    // Some saves may store stone as numeric block id (2) instead of 'stone'.
    const isStick = (slot) => getSlotType(slot) === 'stick';
    const isStone = (slot) => {
        const st = getSlotType(slot);
        return st === 'stone' || st === 2;
    };

    const countAcross = (pred) => {
        let total = 0;
        for (const arr of [backpackSlots, hotbar]) {
            for (let i = 0; i < arr.length; i++) {
                const slot = arr[i];
                if (!slot || !pred(slot)) continue;
                total += getSlotCount(slot);
            }
        }
        return total;
    };

    const consumeAcross = (pred, needCount) => {
        let remaining = needCount;
        for (const arr of [backpackSlots, hotbar]) {
            if (remaining <= 0) break;
            for (let i = 0; i < arr.length && remaining > 0; i++) {
                const slot = arr[i];
                if (!slot || !pred(slot)) continue;
                const slotType = getSlotType(slot);
                const have = getSlotCount(slot);
                const take = Math.min(have, remaining);
                remaining -= take;
                if (take >= have) arr[i] = null;
                else arr[i] = createStackItem(slotType, have - take);
            }
        }
        return remaining <= 0;
    };

    if (countAcross(isStick) < 2) return false;
    if (countAcross(isStone) < 2) return false;

    if (!consumeAcross(isStick, 2)) return false;
    if (!consumeAcross(isStone, 2)) return false;
    return addTool('spade');
}

// 1 stone block (voxel 2) -> 4 stone items. Consumes from backpack/hotbar block slots.
export function craftStoneBlockToStones() {
    const blockType = 2; // stone block
    let found = -1;
    let inBackpack = true;
    for (let i = 0; i < backpackSlots.length; i++) {
        const slot = backpackSlots[i];
        if (slot && getSlotType(slot) === blockType && getSlotCount(slot) >= 1) {
            found = i;
            break;
        }
    }
    if (found === -1) {
        for (let i = 2; i < hotbar.length; i++) {
            const slot = hotbar[i];
            if (slot && getSlotType(slot) === blockType && getSlotCount(slot) >= 1) {
                found = i;
                inBackpack = false;
                break;
            }
        }
    }
    if (found === -1) return false;
    const arr = inBackpack ? backpackSlots : hotbar;
    const slot = arr[found];
    const newCount = getSlotCount(slot) - 1;
    arr[found] = newCount > 0 ? createStackItem(blockType, newCount) : null;
    let remaining = 4;
    for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
        const s = backpackSlots[i];
        if (s && getSlotType(s) === 'stone') {
            const add = Math.min(100 - getSlotCount(s), remaining);
            if (add > 0) {
                backpackSlots[i] = createStackItem('stone', getSlotCount(s) + add);
                remaining -= add;
            }
        }
    }
    for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
        if (backpackSlots[i] == null) {
            const add = Math.min(100, remaining);
            backpackSlots[i] = createStackItem('stone', add);
            remaining -= add;
        }
    }
    for (let i = 2; i < hotbar.length && remaining > 0; i++) {
        const s = hotbar[i];
        if (s && getSlotType(s) === 'stone') {
            const add = Math.min(100 - getSlotCount(s), remaining);
            if (add > 0) {
                hotbar[i] = createStackItem('stone', getSlotCount(s) + add);
                remaining -= add;
            }
        }
    }
    for (let i = 2; i < hotbar.length && remaining > 0; i++) {
        if (hotbar[i] == null) {
            const add = Math.min(100, remaining);
            hotbar[i] = createStackItem('stone', add);
            remaining -= add;
        }
    }
    return true;
}

// 8 stone -> 1 furnace (placeable)
export function craftFurnace() {
    if (!consumeMaterials({ stone: 8 })) return false;
    return addOneItem('furnace');
}

// 2 sticks -> 1 spares
export function craftSticksToSpares() {
    if (!consumeMaterials({ stick: 2 })) return false;
    return addOneItem('spares');
}

// 3 sticks + 3 string -> 1 bow (tool)
export function craftBow() {
    if (!consumeMaterials({ stick: 3, string: 3 })) return false;
    return addTool('bow');
}

// 1 stick -> 4 arrows (crude)
export function craftArrows() {
    if (!consumeMaterials({ stick: 1 })) return false;
    return addItems('arrow', 4);
}

// 1 stick + 1 feather -> 4 feathered arrows (better accuracy)
export function craftFeatheredArrows() {
    if (!consumeMaterials({ stick: 1, feather: 1 })) return false;
    return addItems('feathered_arrow', 4);
}

// 4 wood + 2 stick -> 1 loom (placeable)
export function craftLoom() {
    if (!consumeMaterials({ wood: 4, stick: 2 })) return false;
    return addOneItem('loom');
}

// 4 planks + 2 string + 2 stone -> 1 body armour (chest piece)
export function craftBodyArmour() {
    if (!consumeMaterials({ planks: 4, string: 2, stone: 2 })) return false;
    return addOneItem('body_armour');
}

// 3 planks + 2 string + 1 stone -> 1 helmet
export function craftHelmet() {
    if (!consumeMaterials({ planks: 3, string: 2, stone: 1 })) return false;
    return addOneItem('helmet');
}

// 4 planks + 2 string + 2 stone -> 1 leggings
export function craftLeggings() {
    if (!consumeMaterials({ planks: 4, string: 2, stone: 2 })) return false;
    return addOneItem('leggings');
}

// 2 planks + 2 string + 2 stone -> 1 boots
export function craftBoots() {
    if (!consumeMaterials({ planks: 2, string: 2, stone: 2 })) return false;
    return addOneItem('boots');
}

// 1 string + 1 stone -> 1 ring (accessory, for future boosts)
export function craftRing() {
    if (!consumeMaterials({ string: 1, stone: 1 })) return false;
    return addOneItem('ring');
}

// 2 string + 2 stone -> 1 necklace (accessory, for future boosts)
export function craftNecklace() {
    if (!consumeMaterials({ string: 2, stone: 2 })) return false;
    return addOneItem('necklace');
}

function addOneItem(type) {
    return addItems(type, 1);
}

// Add up to `count` of a stackable item (backpack first, then hotbar). Returns true if any were added.
function addItems(type, count) {
    if (TOOL_TYPES.includes(type)) return false;
    let remaining = count;
    for (let i = 0; i < backpackSlots.length && remaining > 0; i++) {
        const slot = backpackSlots[i];
        if (slot && getSlotType(slot) === type) {
            const add = Math.min(100 - getSlotCount(slot), remaining);
            if (add > 0) {
                backpackSlots[i] = createStackItem(type, getSlotCount(slot) + add);
                remaining -= add;
            }
        } else if (!slot && remaining > 0) {
            const add = Math.min(100, remaining);
            backpackSlots[i] = createStackItem(type, add);
            remaining -= add;
        }
    }
    for (let i = 2; i < hotbar.length && remaining > 0; i++) {
        const slot = hotbar[i];
        if (slot && getSlotType(slot) === type) {
            const add = Math.min(100 - getSlotCount(slot), remaining);
            if (add > 0) {
                hotbar[i] = createStackItem(type, getSlotCount(slot) + add);
                remaining -= add;
            }
        } else if (!slot && remaining > 0) {
            const add = Math.min(100, remaining);
            hotbar[i] = createStackItem(type, add);
            remaining -= add;
        }
    }
    return remaining < count;
}
