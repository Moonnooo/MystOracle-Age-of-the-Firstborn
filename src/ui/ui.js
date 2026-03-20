import * as THREE from 'three';
// --- Grid Helper, Compass, Clock, Coords Overlay ---
let gridHelper = null;
let compass = null;
let clockDisplay = null;
let coordsDisplay = null;
let dayCounter = null;
let worldTempDisplay = null;
let playerTempDisplay = null;
let seasonDisplay = null;

export function setupGridHelper(scene, chunkSize) {
    if (gridHelper) scene.remove(gridHelper);
    gridHelper = new THREE.GridHelper(chunkSize * 2, chunkSize * 2, 0x888888, 0x444444);
    scene.add(gridHelper);
}

export function setupCompassAndClock() {
    compass = document.getElementById('compassOverlay');
    clockDisplay = document.getElementById('clockOverlay');
    coordsDisplay = document.getElementById('coordsDisplay');
    worldTempDisplay = document.getElementById('worldTempOverlay');
    playerTempDisplay = document.getElementById('playerTempOverlay');
    seasonDisplay = document.getElementById('seasonOverlay');

    // Create coords display if not present (kept for safety)
    if (!coordsDisplay) {
        coordsDisplay = document.createElement('div');
        coordsDisplay.id = 'coordsDisplay';
        document.body.appendChild(coordsDisplay);
    }

    dayCounter = document.getElementById('dayCounter');

    // Create temperature/season HUD container + overlays if missing.
    let tempSeasonHud = document.getElementById('tempSeasonHud');
    if (!tempSeasonHud) {
        tempSeasonHud = document.createElement('div');
        tempSeasonHud.id = 'tempSeasonHud';
        const topLeftHud = document.getElementById('topLeftHud');
        if (topLeftHud) {
            topLeftHud.appendChild(tempSeasonHud);
        } else {
            document.body.appendChild(tempSeasonHud);
        }
    } else {
        const topLeftHud = document.getElementById('topLeftHud');
        if (topLeftHud && tempSeasonHud.parentElement !== topLeftHud) {
            topLeftHud.appendChild(tempSeasonHud);
        }
    }

    if (!worldTempDisplay) {
        worldTempDisplay = document.createElement('div');
        worldTempDisplay.id = 'worldTempOverlay';
        tempSeasonHud.appendChild(worldTempDisplay);
    }
    if (!playerTempDisplay) {
        playerTempDisplay = document.createElement('div');
        playerTempDisplay.id = 'playerTempOverlay';
        tempSeasonHud.appendChild(playerTempDisplay);
    }
    if (!seasonDisplay) {
        seasonDisplay = document.createElement('div');
        seasonDisplay.id = 'seasonOverlay';
        tempSeasonHud.appendChild(seasonDisplay);
    }
}

/**
 * @param {THREE.Camera} camera
 * @param {THREE.Vector3} [playerPosition] - Player world position (for home distance/bearing).
 * @param {THREE.Vector3 | null} [homePosition] - Respawn/bed position; when set, show "Home" on compass.
 */
export function updateCompass(camera, playerPosition = null, homePosition = null) {
    if (!compass) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    let degrees = THREE.MathUtils.radToDeg(Math.atan2(dir.x, dir.z));
    if (degrees < 0) degrees += 360;
    // 8-point compass: N, NE, E, ES, S, SW, W, NW
    const directions = ['N', 'NE', 'E', 'ES', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(degrees / 45) % 8; // 0-7
    const direction = directions[index];
    let text = `🧭 ${direction} (${degrees.toFixed(0)}°)`;

    if (homePosition && playerPosition) {
        const dx = homePosition.x - playerPosition.x;
        const dz = homePosition.z - playerPosition.z;
        const distXZ = Math.sqrt(dx * dx + dz * dz);
        const bearing = THREE.MathUtils.radToDeg(Math.atan2(dx, dz));
        let bearingDeg = bearing;
        if (bearingDeg < 0) bearingDeg += 360;
        const bearingIndex = Math.round(bearingDeg / 45) % 8;
        const homeDir = directions[bearingIndex];
        const distM = Math.round(distXZ);
        text += `  ·  🏠 Home: ${homeDir} ${distM}m`;
    }

    compass.textContent = text;
}

export function updateClock(sky) {
    if (!clockDisplay) return;
    const time = sky.getTime();
    const hours = Math.floor(time);
    const minutes = Math.floor((time - hours) * 60);
    const timeStr = `${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}`;
    // Day: 6:00–18:00, Night: 18:00–6:00 (matches sky dawn/dusk feel)
    const isDay = time >= 6 && time < 18;
    const dayNightLabel = isDay ? '☀️ Day' : '🌙 Night';
    clockDisplay.textContent = `🕒 ${timeStr}  ${dayNightLabel}`;

    // Update day counter: "Day 1", "Day 2", ... (world age)
    if (dayCounter && typeof sky.getDayCount === 'function') {
        const days = sky.getDayCount();
        dayCounter.textContent = `Day ${days + 1}`;
    }
}

/**
 * Update world and player temperature + season display.
 * World temperature is a simple derived value; player temperature can
 * come from gameplay systems, but we fall back to world temp if absent.
 *
 * @param {object} opts
 * @param {number} opts.worldTempC - approximate world temperature in °C
 * @param {number} [opts.playerTempC] - player body temperature in °C
 * @param {string} [opts.seasonName] - current season name, e.g. "Spring"
 * @param {string} [opts.weatherLabel] - e.g. "Storm" (from weatherEffects mode)
 * @param {number} [opts.wetness] - 0..1 exposure wetness (rain/snow soak)
 * @param {boolean} [opts.underCover] - under roof while precipitation is active
 */
export function updateTemperatureAndSeason({ worldTempC, playerTempC, seasonName, weatherLabel, wetness, underCover }) {
    if (worldTempDisplay) {
        worldTempDisplay.textContent = `World: ${worldTempC.toFixed(1)}°C`;
    }
    if (playerTempDisplay) {
        const t = (typeof playerTempC === 'number') ? playerTempC : worldTempC;
        let line = `Player: ${t.toFixed(1)}°C`;
        if (typeof wetness === 'number' && wetness > 0.12) {
            line += ` · ${Math.round(wetness * 100)}% wet`;
        }
        playerTempDisplay.textContent = line;
    }
    if (seasonDisplay && seasonName) {
        const w = weatherLabel ? `Weather: ${weatherLabel}` : '';
        let line = `Season: ${seasonName}`;
        if (w) line += ` · ${w}`;
        if (underCover) line += ' · Under cover';
        seasonDisplay.textContent = line;
    }
}

export function updateCoords(player) {
    if (!coordsDisplay) return;
    coordsDisplay.textContent =
        `X: ${player.position.x.toFixed(1)}, ` +
        `Y: ${player.position.y.toFixed(2)}, ` +
        `Z: ${player.position.z.toFixed(1)}`;
}

// Health & stamina bar system
let healthBar = null;
let healthBarFill = null;
let staminaBar = null;
let staminaBarFill = null;

export function setupHealthBar() {
    healthBar = document.getElementById('healthBar');
    if (!healthBar) {
        healthBar = document.createElement('div');
        healthBar.id = 'healthBar';
        document.body.appendChild(healthBar);
    }
    
    // Position/size come from CSS so health and stamina bars match exactly
    healthBar.style.display = 'flex';
    healthBar.style.position = 'absolute';
    healthBar.style.zIndex = '1000';
    
    // Ensure we have a label so the user knows this is health
    let healthLabel = healthBar.querySelector('#healthLabel');
    if (!healthLabel) {
        healthLabel = document.createElement('div');
        healthLabel.id = 'healthLabel';
        healthLabel.textContent = 'HEALTH';
        healthBar.appendChild(healthLabel);
    }

    // Set up fill bar (styles are now in CSS)
    healthBarFill = healthBar.querySelector('.health-bar-fill') || healthBar.querySelector('#healthBarFill');
    if (!healthBarFill) {
        healthBarFill = document.createElement('div');
        healthBarFill.className = 'health-bar-fill';
        healthBarFill.id = 'healthBarFill';
        healthBar.appendChild(healthBarFill);
    }
    healthBarFill.style.width = '100%'; // Initial width, will be updated dynamically
    healthBarFill.style.height = '100%';
    healthBarFill.style.position = 'absolute';
    healthBarFill.style.left = '0';
    healthBarFill.style.top = '0';
    
    // Set up text (numerical HP, styles are now in CSS)
    let healthText = document.getElementById('healthText');
    if (!healthText) {
        healthText = document.createElement('div');
        healthText.id = 'healthText';
        healthBar.appendChild(healthText);
    }
    healthText.style.position = 'absolute';
    healthText.style.zIndex = '1001';
    healthText.style.pointerEvents = 'none';
}

export function updateHealthBar(currentHealth, maxHealth) {
    if (!healthBar || !healthBarFill) return;
    const percentage = Math.max(0, Math.min(100, (currentHealth / maxHealth) * 100));
    healthBarFill.style.width = `${percentage}%`;
    
    const healthText = document.getElementById('healthText');
    if (healthText) {
        healthText.textContent = `${Math.ceil(currentHealth)}/${maxHealth}`;
    }
}

// Stamina bar – displayed above the health bar
export function setupStaminaBar() {
    staminaBar = document.getElementById('staminaBar');
    if (!staminaBar) {
        staminaBar = document.createElement('div');
        staminaBar.id = 'staminaBar';
        document.body.appendChild(staminaBar);
    }

    staminaBar.style.display = 'flex';
    staminaBar.style.position = 'absolute';
    staminaBar.style.zIndex = '1000';

    // Ensure we have a label so the user knows this is stamina
    let staminaLabel = staminaBar.querySelector('#staminaLabel');
    if (!staminaLabel) {
        staminaLabel = document.createElement('div');
        staminaLabel.id = 'staminaLabel';
        staminaLabel.textContent = 'STAMINA';
        staminaBar.appendChild(staminaLabel);
    }

    // Numeric display (current/max) like health bar – stamina is 0–100 in UI
    let staminaText = staminaBar.querySelector('#staminaText');
    if (!staminaText) {
        staminaText = document.createElement('div');
        staminaText.id = 'staminaText';
        staminaText.textContent = '100/100';
        staminaBar.appendChild(staminaText);
    }

    staminaBarFill = staminaBar.querySelector('.stamina-bar-fill') || staminaBar.querySelector('#staminaBarFill');
    if (!staminaBarFill) {
        staminaBarFill = document.createElement('div');
        staminaBarFill.className = 'stamina-bar-fill';
        staminaBarFill.id = 'staminaBarFill';
        staminaBar.appendChild(staminaBarFill);
    }
}

// staminaNormalized is expected 0.0–1.0; display as current/max (e.g. 100/100)
const STAMINA_MAX = 100;
export function updateStaminaBar(staminaNormalized) {
    if (!staminaBar || !staminaBarFill) return;
    const pct = Math.max(0, Math.min(1, staminaNormalized));
    staminaBarFill.style.width = `${pct * 100}%`;
    const staminaText = document.getElementById('staminaText');
    if (staminaText) {
        const current = Math.round(pct * STAMINA_MAX);
        staminaText.textContent = `${current}/${STAMINA_MAX}`;
    }
}
// UI logic for overlays, compass, clock, coords, notifications, hotbar, backpack
// Extracted from renderer.js
import { hotbar, backpackSlots, getSlotType, getSlotCount, createStackItem, getEquippedHead, setEquippedHead, getEquippedBody, setEquippedBody, getEquippedLegs, setEquippedLegs, getEquippedFeet, setEquippedFeet, getEquippedRing1, setEquippedRing1, getEquippedRing2, setEquippedRing2, getEquippedNecklace, setEquippedNecklace, isBodyArmour, isHelmet, isLeggings, isBoots, isRing, isNecklace, craftLogToPlanks, craftStoneAxe, craftStonePickaxe, craftSpade, craftStoneBlockToStones, craftFurnace, craftSticksToSpares, craftBow, craftArrows, craftFeatheredArrows, craftLoom, craftBodyArmour, craftHelmet, craftLeggings, craftBoots, craftRing, craftNecklace } from '../game/inventory.js';
import { BLOCK_DEFS, BLOCK_IDS, waterLevel } from '../world/blocksRegistry.js';

// --- Responsive UI ---
export function updateUIPositions() {
    // Positions are now handled entirely by CSS - no inline style overrides needed
    // This function is kept for compatibility but does nothing
}

// --- Item Pickup Notification UI (stack of cards, max 5, each fades out) ---
const PICKUP_MAX_VISIBLE = 5;
const PICKUP_VISIBLE_MS = 3200;
const PICKUP_FADE_MS = 800;

const pickupNotifContainer = document.createElement('div');
pickupNotifContainer.id = 'pickup-notif';
document.body.appendChild(pickupNotifContainer);

export function showPickupNotification(itemName, amount, newTotal) {
    while (pickupNotifContainer.children.length >= PICKUP_MAX_VISIBLE) {
        pickupNotifContainer.removeChild(pickupNotifContainer.firstChild);
    }
    const card = document.createElement('div');
    card.className = 'pickup-notif-item';
    card.innerHTML = `<span style="color:#ffe066">+${amount}</span> <b>${itemName}</b><br><span style="font-size:0.9em;opacity:0.7">Total: ${newTotal}</span>`;
    pickupNotifContainer.appendChild(card);
    // Force reflow so transition runs
    card.offsetHeight;
    card.classList.add('visible');
    const timeout = setTimeout(() => {
        card.classList.remove('visible');
        setTimeout(() => {
            if (card.parentNode === pickupNotifContainer) {
                pickupNotifContainer.removeChild(card);
            }
        }, PICKUP_FADE_MS);
    }, PICKUP_VISIBLE_MS);
    card._timeout = timeout;
}

// --- Simple status message (center-top) for things like respawn point updates ---
const statusMessageEl = document.createElement('div');
statusMessageEl.id = 'statusMessage';
statusMessageEl.style.position = 'fixed';
statusMessageEl.style.top = '18%';
statusMessageEl.style.left = '50%';
statusMessageEl.style.transform = 'translateX(-50%)';
statusMessageEl.style.padding = '8px 16px';
statusMessageEl.style.borderRadius = '8px';
statusMessageEl.style.background = 'rgba(0,0,0,0.7)';
statusMessageEl.style.color = '#fff';
statusMessageEl.style.fontSize = '14px';
statusMessageEl.style.zIndex = '4000';
statusMessageEl.style.display = 'none';
document.body.appendChild(statusMessageEl);

export function showStatusMessage(text, timeoutMs = 2600) {
    statusMessageEl.textContent = text;
    statusMessageEl.style.display = 'block';
    if (statusMessageEl._timeout) {
        clearTimeout(statusMessageEl._timeout);
    }
    statusMessageEl._timeout = setTimeout(() => {
        statusMessageEl.style.display = 'none';
    }, timeoutMs);
}

// --- Look-at card (top right): block/item or mob name + health ---
const lookAtCardEl = document.createElement('div');
lookAtCardEl.id = 'lookAtCard';
document.body.appendChild(lookAtCardEl);

export function updateLookAtCard(info) {
    if (!lookAtCardEl) return;
    if (!info) {
        lookAtCardEl.style.display = 'none';
        lookAtCardEl.innerHTML = '';
        return;
    }
    const name = info.name || 'Unknown';
    lookAtCardEl.style.display = 'block';
    if (info.health != null && info.maxHealth != null) {
        const pct = Math.max(0, Math.min(100, (info.health / info.maxHealth) * 100));
        lookAtCardEl.innerHTML = `<div class="lookat-name">${name}</div><div class="lookat-health-row"><div class="lookat-health-fill" style="width:${pct}%"></div></div><div class="lookat-health-text">${Math.ceil(info.health)} / ${info.maxHealth}</div>`;
    } else {
        lookAtCardEl.innerHTML = `<div class="lookat-name">${name}</div>`;
    }
}

// --- Hotbar & Backpack UI ---
const hotbarEl = document.createElement('div');
hotbarEl.id = 'hotbar';
document.body.appendChild(hotbarEl);

// Inventory overlay: holds both crafting panel and backpack (E = backpack only, C = crafting + backpack)
const inventoryOverlay = document.createElement('div');
inventoryOverlay.id = 'inventory-overlay';

// Crafting panel with categories (shown when C is pressed)
const CRAFT_CATEGORIES = [
    { id: 'building', label: 'Building' },
    { id: 'tools', label: 'Tools & Weapons' },
    { id: 'ammo', label: 'Ammo' },
    { id: 'materials', label: 'Materials' },
    { id: 'armor', label: 'Armor' },
    { id: 'jewellery', label: 'Jewellery' },
    { id: 'cosmetics', label: 'Cosmetics' },
    { id: 'other', label: 'Other' },
];
const CRAFT_RECIPES = [
    { category: 'building', label: '1 Log → 4 Planks', craftFn: craftLogToPlanks },
    { category: 'armor', label: '4 Planks + 2 String + 2 Stone → Body Armour', craftFn: craftBodyArmour },
    { category: 'armor', label: '3 Planks + 2 String + 1 Stone → Helmet', craftFn: craftHelmet },
    { category: 'armor', label: '4 Planks + 2 String + 2 Stone → Leggings', craftFn: craftLeggings },
    { category: 'armor', label: '2 Planks + 2 String + 2 Stone → Boots', craftFn: craftBoots },
    { category: 'jewellery', label: '1 String + 1 Stone → Ring', craftFn: craftRing },
    { category: 'jewellery', label: '2 String + 2 Stone → Necklace', craftFn: craftNecklace },
    { category: 'tools', label: '2 Stick + 3 Stone → Stone Axe', craftFn: craftStoneAxe },
    { category: 'tools', label: '2 Stick + 3 Stone → Stone Pickaxe', craftFn: craftStonePickaxe },
    { category: 'tools', label: '2 Stick + 2 Stone → Spade', craftFn: craftSpade },
    { category: 'tools', label: '2 Stick → Spares', craftFn: craftSticksToSpares },
    { category: 'tools', label: '3 Stick + 3 String → Bow', craftFn: craftBow },
    { category: 'ammo', label: '1 Stick → 4 Arrows', craftFn: craftArrows },
    { category: 'ammo', label: '1 Stick + 1 Feather → 4 Feathered Arrows', craftFn: craftFeatheredArrows },
    { category: 'materials', label: '1 Stone Block → 4 Stone', craftFn: craftStoneBlockToStones },
    { category: 'building', label: '8 Stone → Furnace', craftFn: craftFurnace },
    { category: 'building', label: '4 Log + 2 Stick → Loom', craftFn: craftLoom },
];

const craftingPanel = document.createElement('div');
craftingPanel.id = 'crafting-panel';
craftingPanel.style.display = 'none';
const craftingTitle = document.createElement('h3');
craftingTitle.className = 'inventory-panel-title';
craftingTitle.textContent = 'Crafting';
craftingPanel.appendChild(craftingTitle);

const craftingTabs = document.createElement('div');
craftingTabs.className = 'crafting-tabs';
CRAFT_CATEGORIES.forEach((cat) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'crafting-tab';
    tab.dataset.category = cat.id;
    tab.textContent = cat.label;
    craftingTabs.appendChild(tab);
});
craftingPanel.appendChild(craftingTabs);

const craftingRecipes = document.createElement('div');
craftingRecipes.className = 'crafting-recipes';

// --- Creative panel (replaces crafting recipes when in creative mode) ---
const creativeItemsPanel = document.createElement('div');
creativeItemsPanel.id = 'creative-items-panel';
creativeItemsPanel.className = 'creative-items';
creativeItemsPanel.style.display = 'none';

let creativeItemsBuilt = false;
function buildCreativeItems() {
    if (creativeItemsBuilt) return;
    creativeItemsBuilt = true;

    creativeItemsPanel.innerHTML = '';

    const blockIds = Object.keys(BLOCK_DEFS)
        .map((k) => Number(k))
        .filter((id) => Number.isFinite(id) && id !== BLOCK_IDS.AIR)
        .sort((a, b) => a - b);

    const titleCase = (s) =>
        String(s)
            .split('_')
            .filter(Boolean)
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
            .join(' ');

    const typeLabel = (type) => {
        if (typeof type === 'number') {
            const def = BLOCK_DEFS[type];
            const lvl = waterLevel(type);
            if (lvl != null) return `Water (lvl ${lvl})`;
            return def?.name || `Block ${type}`;
        }
        return titleCase(type);
    };

    const addCreativeItemEl = (type) => {
        const label = typeLabel(type);
        const el = document.createElement('div');
        el.className = 'creative-item-slot';
        el.draggable = true;
        el.title = `${label} [type=${type}]`;
        el.innerHTML = `<div class="creative-item-label">${label}</div>`;

        el.addEventListener('dragstart', (ev) => {
            ev.dataTransfer.setData(
                'text/plain',
                JSON.stringify({
                    from: 'creative',
                    item: createStackItem(type, 1),
                })
            );
            window._lastDragData = { from: 'creative' };
            window._lastDragHandled = false;
        });

        creativeItemsPanel.appendChild(el);
    };

    // Categorized inventory list for creative mode drag-to-backpack.
    // This includes blocks (numeric IDs) and non-block items (string ids).
    const categories = [
        { id: 'blocks', title: 'Blocks', items: blockIds },
        {
            id: 'tools',
            title: 'Tools & Weapons',
            items: ['gun', 'spear', 'bow', 'pickaxe', 'stone_pickaxe', 'axe', 'stone_axe', 'spade', 'spares'],
        },
        {
            id: 'resources',
            title: 'Resources',
            items: [
                'wood',
                'leaves',
                'planks',
                'stick',
                'sapling',
                'stone',
                'coal',
                'iron_ore',
                'gold_ore',
                'iron_bar',
                'gold_ingot',
                'string',
                'wool',
                'bone',
                'leather',
            ],
        },
        { id: 'ammo', title: 'Ammo', items: ['arrow', 'feathered_arrow', 'feather'] },
        {
            id: 'food',
            title: 'Food',
            items: ['raw_beef', 'cooked_beef', 'raw_mutton', 'cooked_mutton'],
        },
        {
            id: 'armor',
            title: 'Armor & Jewellery',
            items: [
                'helmet',
                'body_armour',
                'leggings',
                'boots',
                'ring',
                'necklace',
                'iron_ring',
                'iron_necklace',
                'gold_ring',
                'gold_necklace',
            ],
        },
        {
            id: 'structures',
            title: 'Structures',
            items: ['chest', 'campfire', 'furnace', 'loom', 'bed'],
        },
        // Keep misc empty for now (most items already appear in other categories).
    ];

    for (const cat of categories) {
        const titleEl = document.createElement('div');
        titleEl.className = 'creative-category-title';
        titleEl.textContent = cat.title;
        creativeItemsPanel.appendChild(titleEl);

        for (const type of cat.items) addCreativeItemEl(type);
    }
}

export function setCreativeModeUI(isCreative) {
    // When creative mode is enabled, we turn the crafting panel into a creative
    // block list for drag-to-backpack placement.
    if (craftingTitle) craftingTitle.textContent = isCreative ? 'Creative' : 'Crafting';
    if (craftingTabs) craftingTabs.style.display = isCreative ? 'none' : 'flex';
    if (craftingRecipes) craftingRecipes.style.display = isCreative ? 'none' : 'block';

    if (isCreative) {
        // Keep CSS grid layout active.
        creativeItemsPanel.style.display = 'grid';
        buildCreativeItems();
    } else {
        creativeItemsPanel.style.display = 'none';
    }
}

function buildCraftRow(label, craftFn) {
    const row = document.createElement('div');
    row.className = 'craft-row';
    row.innerHTML = `<span>${label}</span>`;
    const btn = document.createElement('button');
    btn.className = 'craft-btn';
    btn.textContent = 'Craft';
    btn.addEventListener('click', () => {
        if (craftFn()) {
            document.dispatchEvent(new CustomEvent('inventoryChanged'));
        }
    });
    row.appendChild(btn);
    return row;
}

function showCraftCategory(categoryId) {
    craftingRecipes.innerHTML = '';
    const recipes = CRAFT_RECIPES.filter((r) => r.category === categoryId);
    if (recipes.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'crafting-empty';
        empty.textContent = 'No recipes in this category yet.';
        craftingRecipes.appendChild(empty);
    } else {
        recipes.forEach((r) => {
            craftingRecipes.appendChild(buildCraftRow(r.label, r.craftFn));
        });
    }
    craftingTabs.querySelectorAll('.crafting-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.category === categoryId);
    });
}

craftingTabs.querySelectorAll('.crafting-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        showCraftCategory(tab.dataset.category);
    });
});

showCraftCategory('building'); // default first category
craftingPanel.appendChild(craftingRecipes);
craftingPanel.appendChild(creativeItemsPanel);
inventoryOverlay.appendChild(craftingPanel);

// Equipment panel (body armour slot)
const equipmentEl = document.createElement('div');
equipmentEl.id = 'equipment-panel';
const equipmentTitle = document.createElement('h3');
equipmentTitle.className = 'inventory-panel-title';
equipmentTitle.textContent = 'Equipment';
equipmentEl.appendChild(equipmentTitle);
const equipmentGrid = document.createElement('div');
equipmentGrid.className = 'equipment-grid';
equipmentEl.appendChild(equipmentGrid);
inventoryOverlay.appendChild(equipmentEl);

// Backpack panel (inventory only; no crafting here)
const backpackEl = document.createElement('div');
backpackEl.id = 'backpack';
const backpackTitle = document.createElement('h3');
backpackTitle.className = 'inventory-panel-title';
backpackTitle.textContent = 'Backpack';
backpackEl.appendChild(backpackTitle);
const backpackGrid = document.createElement('div');
backpackGrid.className = 'grid';
backpackEl.appendChild(backpackGrid);
inventoryOverlay.appendChild(backpackEl);
document.body.appendChild(inventoryOverlay);

// Global drag-end handler to support dropping items into the world when
// the user drags them out of the hotbar/backpack UI.
window.addEventListener('dragend', () => {
    const data = window._lastDragData;
    if (!data || window._lastDragHandled) {
        window._lastDragData = null;
        window._lastDragHandled = false;
        return;
    }

    // Creative inventory is an infinite source; don't spawn world drops for it.
    if (data.from === 'creative') {
        window._lastDragData = null;
        window._lastDragHandled = false;
        return;
    }

    // If we get here, the drag ended without landing on any inventory slot.
    // Treat it as "drop into world". When paused, don't allow hotbar drops.
    if (data.from === 'hotbar' && typeof window.getGamePaused === 'function' && window.getGamePaused()) {
        window._lastDragData = null;
        window._lastDragHandled = false;
        return;
    }
    const from = data.from;
    const index = data.index;
    let item = null;

    if (from === 'hotbar') {
        item = hotbar[index];
    } else if (from === 'backpack') {
        item = backpackSlots[index];
    }

    if (!item) {
        window._lastDragData = null;
        window._lastDragHandled = false;
        return;
    }

    const type = getSlotType(item);
    const count = getSlotCount(item);

    if (window.spawnWorldDropFromUI && type) {
        window.spawnWorldDropFromUI(type, count);

        // Remove from inventory
        if (from === 'hotbar') {
            hotbar[index] = null;
        } else if (from === 'backpack') {
            backpackSlots[index] = null;
        }

        // Re-render UI
        // We don't have selectedHotbar or setSelectedHotbar here, but
        // renderHotbar/renderBackpack are called from renderer with those.
        // So we just trigger a full inventoryChanged event and let renderer
        // refresh things.
        document.dispatchEvent(new CustomEvent('inventoryChanged'));
    }

    window._lastDragData = null;
    window._lastDragHandled = false;
});

export function renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar) {
    const isPaused = typeof window.getGamePaused === 'function' && window.getGamePaused();
    hotbarEl.innerHTML = '';
    for (let i = 0; i < hotbar.length; i++) {
        const slot = document.createElement('div');
        slot.className = 'hotbar-slot' + (selectedHotbar === i ? ' selected' : '');
        slot.draggable = !isPaused;
        slot.dataset.index = i;
        const item = hotbar[i];
        let label = '';
        if (item != null) {
            const type = getSlotType(item);
            const count = getSlotCount(item);
            if (isValidBlockType(type)) {
                label = `${getBlockName(type)} x${count}`;
            } else {
                label = count > 1 ? `${type} x${count}` : type;
            }
        }
        slot.innerHTML = `<div class="item-label">${label}`;

        slot.addEventListener('click', (ev) => {
            if (typeof window.getGamePaused === 'function' && window.getGamePaused()) return;
            if (ev.shiftKey && hotbar[i]) {
                if (typeof window.tryShiftClickToCampfire === 'function' && window.tryShiftClickToCampfire('hotbar', i)) return;
                if (typeof window.tryShiftClickToFurnace === 'function' && window.tryShiftClickToFurnace('hotbar', i)) return;
                if (typeof window.tryShiftClickToLoom === 'function' && window.tryShiftClickToLoom('hotbar', i)) return;
                if (typeof window.tryShiftClickToChest === 'function' && window.tryShiftClickToChest('hotbar', i)) return;
                if (typeof window.tryShiftClickToBackpack === 'function' && window.tryShiftClickToBackpack(i)) return;
            }
            if (typeof setSelectedHotbar === 'function') setSelectedHotbar(i);
        });

        slot.addEventListener('dragstart', (ev) => {
            if (typeof window.getGamePaused === 'function' && window.getGamePaused()) {
                ev.preventDefault();
                return;
            }
            ev.dataTransfer.setData('text/plain', JSON.stringify({from:'hotbar',index:i,item:hotbar[i]}));
            window._lastDragData = { from: 'hotbar', index: i };
            window._lastDragHandled = false;
        });

        slot.addEventListener('dragover', (ev) => ev.preventDefault());
        slot.addEventListener('drop', (ev) => {
            ev.preventDefault();
            if (typeof window.getGamePaused === 'function' && window.getGamePaused()) return;
            const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
            const targetItem = hotbar[i];

            window._lastDragHandled = true;
            if (data.from === 'hotbar') {
                const fromIndex = data.index;
                if (fromIndex === i) {
                    // Dropped back onto the same slot – nothing to do
                    renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
                    return;
                }
                const draggedItem = hotbar[fromIndex];
                const draggedType = getSlotType(draggedItem);
                const targetType = getSlotType(targetItem);

                // If both are valid block types of same type, merge stacks up to 100
                if (draggedItem && targetItem && isValidBlockType(draggedType) && draggedType === targetType) {
                    const draggedCount = getSlotCount(draggedItem);
                    const targetCount = getSlotCount(targetItem);
                    const totalCount = draggedCount + targetCount;
                    if (totalCount <= 100) {
                        hotbar[i] = createStackItem(draggedType, totalCount);
                        hotbar[fromIndex] = null;
                    } else {
                        hotbar[i] = createStackItem(draggedType, 100);
                        hotbar[fromIndex] = createStackItem(draggedType, totalCount - 100);
                    }
                } else {
                    // Otherwise just swap items between the two hotbar slots (or move into empty)
                    hotbar[i] = draggedItem;
                    hotbar[fromIndex] = targetItem;
                }
            } else if (data.from === 'backpack') {
                const draggedItem = data.item;
                const draggedType = getSlotType(draggedItem);
                const targetType = getSlotType(targetItem);
                if (isValidBlockType(draggedType) && draggedType === targetType) {
                    const draggedCount = getSlotCount(draggedItem);
                    const targetCount = getSlotCount(targetItem);
                    const totalCount = draggedCount + targetCount;
                    if (totalCount <= 100) {
                        hotbar[i] = createStackItem(draggedType, totalCount);
                        backpackSlots[data.index] = null;
                    } else {
                        hotbar[i] = createStackItem(draggedType, 100);
                        backpackSlots[data.index] = createStackItem(draggedType, totalCount - 100);
                    }
                } else {
                    hotbar[i] = draggedItem;
                    backpackSlots[data.index] = targetItem;
                }
            } else if (data.from === 'creative') {
                const draggedItem = data.item;
                if (!draggedItem) return;

                const draggedType = getSlotType(draggedItem);

                // Creative items are effectively infinite; only place/merge into the slot.
                if (!targetItem) {
                    const draggedCount = getSlotCount(draggedItem) || 1;
                    hotbar[i] = createStackItem(draggedType, Math.min(100, draggedCount));
                } else if (getSlotType(targetItem) === draggedType) {
                    const draggedCount = getSlotCount(draggedItem) || 1;
                    const targetCount = getSlotCount(targetItem) || 1;
                    const totalCount = draggedCount + targetCount;
                    hotbar[i] = createStackItem(draggedType, Math.min(100, totalCount));
                }
            } else if (data.from === 'equipment') {
                const config = EQUIPMENT_SLOTS[data.slot];
                if (!config) return;
                const eqItem = config.getter();
                if (!eqItem) return;
                const type = config.itemType;
                config.setter(null);
                if (!targetItem) {
                    hotbar[i] = createStackItem(type, 1);
                } else if (getSlotType(targetItem) === type) {
                    const c = getSlotCount(targetItem);
                    if (c < 100) hotbar[i] = createStackItem(type, c + 1);
                    else { config.setter(eqItem); return; }
                } else {
                    hotbar[i] = createStackItem(type, 1);
                }
            } else if (data.from === 'chest') {
                // Move item from chest into hotbar
                const chestInv = window.currentChestInventory;
                if (Array.isArray(chestInv)) {
                    const draggedItem = chestInv[data.index];
                    const draggedType = getSlotType(draggedItem);
                    const targetType = getSlotType(targetItem);
                    if (draggedItem) {
                        if (isValidBlockType(draggedType) && draggedType === targetType) {
                            const draggedCount = getSlotCount(draggedItem);
                            const targetCount = getSlotCount(targetItem);
                            const totalCount = draggedCount + targetCount;
                            if (totalCount <= 100) {
                                hotbar[i] = createStackItem(draggedType, totalCount);
                                chestInv[data.index] = null;
                            } else {
                                hotbar[i] = createStackItem(draggedType, 100);
                                chestInv[data.index] = createStackItem(draggedType, totalCount - 100);
                            }
                        } else {
                            hotbar[i] = draggedItem;
                            chestInv[data.index] = targetItem;
                        }
                    }
                    if (window.showChestUI) window.showChestUI(chestInv);
                }
            } else if (data.from === 'campfire') {
                const mesh = window.currentCampfireMesh;
                const sys = window.campfireSystem;
                if (mesh && sys) {
                    const inv = sys.getCampfireInventory(mesh);
                    const draggedItem = inv[data.index];
                    const draggedType = draggedItem && getSlotType(draggedItem);
                    const targetType = targetItem && getSlotType(targetItem);
                    if (draggedItem) {
                        if (draggedType === targetType && (targetItem == null || getSlotCount(targetItem) + getSlotCount(draggedItem) <= 100)) {
                            const total = (targetItem ? getSlotCount(targetItem) : 0) + getSlotCount(draggedItem);
                            hotbar[i] = createStackItem(draggedType, total);
                            inv[data.index] = null;
                        } else {
                            hotbar[i] = draggedItem;
                            inv[data.index] = targetItem;
                        }
                        sys.setCampfireInventory(mesh, inv);
                        if (window.showCampfireUI) window.showCampfireUI(mesh);
                    }
                }
            } else if (data.from === 'furnace') {
                const mesh = window.currentFurnaceMesh;
                const sys = window.furnaceSystem;
                if (mesh && sys) {
                    const inv = sys.getFurnaceInventory(mesh);
                    const draggedItem = inv[data.index];
                    const draggedType = draggedItem && getSlotType(draggedItem);
                    const targetType = targetItem && getSlotType(targetItem);
                    if (draggedItem) {
                        if (draggedType === targetType && (targetItem == null || getSlotCount(targetItem) + getSlotCount(draggedItem) <= 100)) {
                            const total = (targetItem ? getSlotCount(targetItem) : 0) + getSlotCount(draggedItem);
                            hotbar[i] = createStackItem(draggedType, total);
                            inv[data.index] = null;
                        } else {
                            hotbar[i] = draggedItem;
                            inv[data.index] = targetItem;
                        }
                        sys.setFurnaceInventory(mesh, inv);
                        if (window.showFurnaceUI) window.showFurnaceUI(mesh);
                    }
                }
            } else if (data.from === 'loom') {
                const mesh = window.currentLoomMesh;
                const sys = window.loomSystem;
                if (mesh && sys) {
                    const inv = sys.getLoomInventory(mesh);
                    const draggedItem = inv[data.index];
                    const draggedType = draggedItem && getSlotType(draggedItem);
                    const targetType = targetItem && getSlotType(targetItem);
                    if (draggedItem) {
                        if (draggedType === targetType && (targetItem == null || getSlotCount(targetItem) + getSlotCount(draggedItem) <= 100)) {
                            const total = (targetItem ? getSlotCount(targetItem) : 0) + getSlotCount(draggedItem);
                            hotbar[i] = createStackItem(draggedType, total);
                            inv[data.index] = null;
                        } else {
                            hotbar[i] = draggedItem;
                            inv[data.index] = targetItem;
                        }
                        sys.setLoomInventory(mesh, inv);
                        if (window.showLoomUI) window.showLoomUI(mesh);
                    }
                }
            }
            renderHotbar(getBlockName, isValidBlockType, updateHeldModelVisibility, setSelectedHotbar, selectedHotbar);
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
            renderEquipment(getBlockName, isValidBlockType, updateHeldModelVisibility);
            updateHeldModelVisibility();
        });
        hotbarEl.appendChild(slot);
    }
}

export function renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility) {
    backpackGrid.innerHTML = '';
    for (let i = 0; i < backpackSlots.length; i++) {
        const slotEl = document.createElement('div');
        slotEl.className = 'backpack-slot';
        slotEl.dataset.index = i;
        const slotItem = backpackSlots[i];
        let label = '';
        if (slotItem != null) {
            const type = getSlotType(slotItem);
            const count = getSlotCount(slotItem);
            if (isValidBlockType(type)) {
                label = `${getBlockName(type)} x${count}`;
            } else {
                label = count > 1 ? `${type} x${count}` : type;
            }
        }
        slotEl.innerHTML = `<div class="item-label">${label}</div>`;
        slotEl.draggable = true;
        slotEl.addEventListener('click', (ev) => {
            if (!ev.shiftKey || !backpackSlots[i]) return;
            if (typeof window.tryShiftClickToCampfire === 'function' && window.tryShiftClickToCampfire('backpack', i)) return;
            if (typeof window.tryShiftClickToFurnace === 'function' && window.tryShiftClickToFurnace('backpack', i)) return;
            if (typeof window.tryShiftClickToLoom === 'function' && window.tryShiftClickToLoom('backpack', i)) return;
            if (typeof window.tryShiftClickToChest === 'function' && window.tryShiftClickToChest('backpack', i)) return;
            if (typeof window.tryShiftClickToHotbar === 'function' && window.tryShiftClickToHotbar(i)) return;
        });
        slotEl.addEventListener('dragstart', (ev) => {
            ev.dataTransfer.setData('text/plain', JSON.stringify({from:'backpack',index:i,item:backpackSlots[i]}));
            window._lastDragData = { from: 'backpack', index: i };
            window._lastDragHandled = false;
        });
        slotEl.addEventListener('dragover', (ev) => { ev.preventDefault(); slotEl.classList.add('drag-over'); });
        slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
        slotEl.addEventListener('drop', (ev) => {
            ev.preventDefault(); 
            slotEl.classList.remove('drag-over');
            const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
            window._lastDragHandled = true;
            const targetItem = backpackSlots[i];

            if (data.from === 'hotbar') {
                const draggedItem = data.item;
                const draggedType = getSlotType(draggedItem);
                const targetType = getSlotType(targetItem);
                if (isValidBlockType(draggedType) && draggedType === targetType) {
                    const draggedCount = getSlotCount(draggedItem);
                    const targetCount = getSlotCount(targetItem);
                    const totalCount = draggedCount + targetCount;
                    if (totalCount <= 100) {
                        backpackSlots[i] = createStackItem(draggedType, totalCount);
                        hotbar[data.index] = null;
                    } else {
                        backpackSlots[i] = createStackItem(draggedType, 100);
                        hotbar[data.index] = createStackItem(draggedType, totalCount - 100);
                    }
                } else {
                    backpackSlots[i] = draggedItem;
                    hotbar[data.index] = targetItem;
                }
            } else if (data.from === 'equipment') {
                const config = EQUIPMENT_SLOTS[data.slot];
                if (!config) return;
                const eqItem = config.getter();
                if (!eqItem) return;
                const type = config.itemType;
                config.setter(null);
                if (!targetItem) {
                    backpackSlots[i] = createStackItem(type, 1);
                } else if (getSlotType(targetItem) === type) {
                    const c = getSlotCount(targetItem);
                    if (c < 100) backpackSlots[i] = createStackItem(type, c + 1);
                    else { config.setter(eqItem); return; }
                } else {
                    let placed = false;
                    for (let j = 0; j < backpackSlots.length; j++) {
                        if (!backpackSlots[j]) { backpackSlots[j] = createStackItem(type, 1); placed = true; break; }
                        if (getSlotType(backpackSlots[j]) === type && getSlotCount(backpackSlots[j]) < 100) {
                            backpackSlots[j] = createStackItem(type, getSlotCount(backpackSlots[j]) + 1);
                            placed = true; break;
                        }
                    }
                    if (!placed) config.setter(eqItem);
                }
            } else if (data.from === 'backpack') {
                const fromIndex = data.index;
                if (fromIndex === i) {
                    // Dropped back onto the same slot – nothing to do
                    renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
                    return;
                }
                const draggedItem = backpackSlots[fromIndex];
                const draggedType = getSlotType(draggedItem);
                const targetType = getSlotType(targetItem);

                // If both are valid block types of same type, merge stacks up to 100
                if (draggedItem && targetItem && isValidBlockType(draggedType) && draggedType === targetType) {
                    const draggedCount = getSlotCount(draggedItem);
                    const targetCount = getSlotCount(targetItem);
                    const totalCount = draggedCount + targetCount;
                    if (totalCount <= 100) {
                        backpackSlots[i] = createStackItem(draggedType, totalCount);
                        backpackSlots[fromIndex] = null;
                    } else {
                        backpackSlots[i] = createStackItem(draggedType, 100);
                        backpackSlots[fromIndex] = createStackItem(draggedType, totalCount - 100);
                    }
                } else {
                    // Otherwise just swap items between the two backpack slots
                    backpackSlots[i] = draggedItem;
                    backpackSlots[fromIndex] = targetItem;
                }
            } else if (data.from === 'creative') {
                // Creative panel items are infinite; dropping them into the backpack should only add/merge.
                const draggedItem = data.item;
                if (!draggedItem) return;

                const draggedType = getSlotType(draggedItem);

                const draggedCount = getSlotCount(draggedItem) || 1;

                if (!targetItem) {
                    backpackSlots[i] = createStackItem(draggedType, Math.min(100, draggedCount));
                } else {
                    const targetType = getSlotType(targetItem);
                    if (targetType === draggedType) {
                        const totalCount = getSlotCount(targetItem) + draggedCount;
                        backpackSlots[i] = createStackItem(draggedType, Math.min(100, totalCount));
                    } else {
                        // Different item: try to put creative item into the first empty slot.
                        const emptyIndex = backpackSlots.findIndex((s, idx) => idx !== i && !s);
                        if (emptyIndex !== -1) {
                            backpackSlots[emptyIndex] = createStackItem(draggedType, Math.min(100, draggedCount));
                        }
                    }
                }
            } else if (data.from === 'chest') {
                // Move item from chest into backpack
                const chestInv = window.currentChestInventory;
                if (Array.isArray(chestInv)) {
                    const draggedItem = chestInv[data.index];
                    const draggedType = getSlotType(draggedItem);
                    const targetType = getSlotType(targetItem);
                    if (draggedItem) {
                        if (isValidBlockType(draggedType) && draggedType === targetType) {
                            const draggedCount = getSlotCount(draggedItem);
                            const targetCount = getSlotCount(targetItem);
                            const totalCount = draggedCount + targetCount;
                            if (totalCount <= 100) {
                                backpackSlots[i] = createStackItem(draggedType, totalCount);
                                chestInv[data.index] = null;
                            } else {
                                backpackSlots[i] = createStackItem(draggedType, 100);
                                chestInv[data.index] = createStackItem(draggedType, totalCount - 100);
                            }
                        } else {
                            backpackSlots[i] = draggedItem;
                            chestInv[data.index] = targetItem;
                        }
                    }
                    if (window.showChestUI) window.showChestUI(chestInv);
                }
            } else if (data.from === 'campfire') {
                const mesh = window.currentCampfireMesh;
                const sys = window.campfireSystem;
                if (mesh && sys) {
                    const inv = sys.getCampfireInventory(mesh);
                    const draggedItem = inv[data.index];
                    const draggedType = draggedItem && getSlotType(draggedItem);
                    const targetType = targetItem && getSlotType(targetItem);
                    if (draggedItem) {
                        if (draggedType === targetType && (targetItem == null || getSlotCount(targetItem) + getSlotCount(draggedItem) <= 100)) {
                            const total = (targetItem ? getSlotCount(targetItem) : 0) + getSlotCount(draggedItem);
                            backpackSlots[i] = createStackItem(draggedType, total);
                            inv[data.index] = null;
                        } else {
                            backpackSlots[i] = draggedItem;
                            inv[data.index] = targetItem;
                        }
                        sys.setCampfireInventory(mesh, inv);
                        if (window.showCampfireUI) window.showCampfireUI(mesh);
                    }
                }
            } else if (data.from === 'furnace') {
                const mesh = window.currentFurnaceMesh;
                const sys = window.furnaceSystem;
                if (mesh && sys) {
                    const inv = sys.getFurnaceInventory(mesh);
                    const draggedItem = inv[data.index];
                    const draggedType = draggedItem && getSlotType(draggedItem);
                    const targetType = targetItem && getSlotType(targetItem);
                    if (draggedItem) {
                        if (draggedType === targetType && (targetItem == null || getSlotCount(targetItem) + getSlotCount(draggedItem) <= 100)) {
                            const total = (targetItem ? getSlotCount(targetItem) : 0) + getSlotCount(draggedItem);
                            backpackSlots[i] = createStackItem(draggedType, total);
                            inv[data.index] = null;
                        } else {
                            backpackSlots[i] = draggedItem;
                            inv[data.index] = targetItem;
                        }
                        sys.setFurnaceInventory(mesh, inv);
                        if (window.showFurnaceUI) window.showFurnaceUI(mesh);
                    }
                }
            } else if (data.from === 'loom') {
                const mesh = window.currentLoomMesh;
                const sys = window.loomSystem;
                if (mesh && sys) {
                    const inv = sys.getLoomInventory(mesh);
                    const draggedItem = inv[data.index];
                    const draggedType = draggedItem && getSlotType(draggedItem);
                    const targetType = targetItem && getSlotType(targetItem);
                    if (draggedItem) {
                        if (draggedType === targetType && (targetItem == null || getSlotCount(targetItem) + getSlotCount(draggedItem) <= 100)) {
                            const total = (targetItem ? getSlotCount(targetItem) : 0) + getSlotCount(draggedItem);
                            backpackSlots[i] = createStackItem(draggedType, total);
                            inv[data.index] = null;
                        } else {
                            backpackSlots[i] = draggedItem;
                            inv[data.index] = targetItem;
                        }
                        sys.setLoomInventory(mesh, inv);
                        if (window.showLoomUI) window.showLoomUI(mesh);
                    }
                }
            }
            // Let renderer re-render hotbar/backpack with correct callbacks.
            document.dispatchEvent(new CustomEvent('inventoryChanged'));
            renderBackpack(getBlockName, isValidBlockType, updateHeldModelVisibility);
            renderEquipment(getBlockName, isValidBlockType, updateHeldModelVisibility);
            updateHeldModelVisibility();
        });
        backpackGrid.appendChild(slotEl);
    }
}

// Equipment slot config for character layout and drop handlers
const EQUIPMENT_SLOTS = {
    head:   { getter: getEquippedHead,   setter: setEquippedHead,   itemType: 'helmet',     emptyLabel: 'Head',    equippedLabel: 'Helmet',    validator: isHelmet },
    body:   { getter: getEquippedBody,   setter: setEquippedBody,   itemType: 'body_armour', emptyLabel: 'Chest',   equippedLabel: 'Body Armour', validator: isBodyArmour },
    legs:   { getter: getEquippedLegs,   setter: setEquippedLegs,   itemType: 'leggings',   emptyLabel: 'Legs',    equippedLabel: 'Leggings', validator: isLeggings },
    feet:   { getter: getEquippedFeet,   setter: setEquippedFeet,   itemType: 'boots',     emptyLabel: 'Feet',    equippedLabel: 'Boots',    validator: isBoots },
    ring1:  { getter: getEquippedRing1,  setter: setEquippedRing1,  itemType: 'ring',      emptyLabel: 'Ring 1',  equippedLabel: 'Ring',      validator: isRing },
    ring2:  { getter: getEquippedRing2,  setter: setEquippedRing2,  itemType: 'ring',      emptyLabel: 'Ring 2',  equippedLabel: 'Ring',      validator: isRing },
    necklace: { getter: getEquippedNecklace, setter: setEquippedNecklace, itemType: 'necklace', emptyLabel: 'Necklace', equippedLabel: 'Necklace', validator: isNecklace },
};

// Character-shaped grid: row0 = [_, head, _], row1 = [ring1, body, ring2], row2 = [_, necklace, _], row3 = [_, legs, _], row4 = [_, feet, _]
const EQUIPMENT_LAYOUT = [
    null, 'head', null,
    'ring1', 'body', 'ring2',
    null, 'necklace', null,
    null, 'legs', null,
    null, 'feet', null,
];

function createEquipmentSlotEl(slotId, getBlockName, isValidBlockType, updateHeldModelVisibility) {
    const config = EQUIPMENT_SLOTS[slotId];
    const item = config.getter();
    const label = item ? config.equippedLabel : config.emptyLabel;
    const el = document.createElement('div');
    el.className = 'equipment-slot';
    el.dataset.slot = slotId;
    el.innerHTML = `<div class="item-label">${label}</div>`;
    el.draggable = !!item;
    el.addEventListener('click', () => {
        if (!item) return;
        config.setter(null);
        const type = config.itemType;
        let added = false;
        for (let i = 0; i < backpackSlots.length; i++) {
            if (backpackSlots[i] && getSlotType(backpackSlots[i]) === type) {
                const c = getSlotCount(backpackSlots[i]);
                if (c < 100) { backpackSlots[i] = createStackItem(type, c + 1); added = true; break; }
            }
        }
        if (!added) for (let i = 0; i < backpackSlots.length; i++) {
            if (!backpackSlots[i]) { backpackSlots[i] = createStackItem(type, 1); added = true; break; }
        }
        document.dispatchEvent(new CustomEvent('inventoryChanged'));
    });
    el.addEventListener('dragstart', (ev) => {
        if (!item) return;
        ev.dataTransfer.setData('text/plain', JSON.stringify({ from: 'equipment', slot: slotId, item }));
        window._lastDragData = { from: 'equipment', slot: slotId };
        window._lastDragHandled = false;
    });
    el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (ev) => {
        ev.preventDefault();
        el.classList.remove('drag-over');
        // Mark as handled so dragend won't drop the item on the ground when we reject (wrong type, etc.)
        window._lastDragHandled = true;
        const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
        // Only accept from backpack or hotbar; only the correct item type for this slot
        if (data.from !== 'backpack' && data.from !== 'hotbar') return;
        if (config.getter()) return; // slot already filled
        const src = data.from === 'backpack' ? backpackSlots[data.index] : hotbar[data.index];
        if (!src || !config.validator(src)) return; // wrong item type — item stays in backpack/hotbar
        const count = getSlotCount(src);
        if (count <= 0) return;
        config.setter(createStackItem(config.itemType, 1));
        if (data.from === 'backpack') {
            if (count === 1) backpackSlots[data.index] = null;
            else backpackSlots[data.index] = createStackItem(config.itemType, count - 1);
        } else {
            if (count === 1) hotbar[data.index] = null;
            else hotbar[data.index] = createStackItem(config.itemType, count - 1);
        }
        document.dispatchEvent(new CustomEvent('inventoryChanged'));
    });
    return el;
}

export function renderEquipment(getBlockName, isValidBlockType, updateHeldModelVisibility) {
    if (!equipmentGrid) return;
    equipmentGrid.innerHTML = '';
    equipmentGrid.className = 'equipment-character';
    for (let i = 0; i < EQUIPMENT_LAYOUT.length; i++) {
        const slotId = EQUIPMENT_LAYOUT[i];
        if (slotId) {
            const slotEl = createEquipmentSlotEl(slotId, getBlockName, isValidBlockType, updateHeldModelVisibility);
            equipmentGrid.appendChild(slotEl);
        } else {
            const empty = document.createElement('div');
            empty.className = 'equipment-slot-empty';
            equipmentGrid.appendChild(empty);
        }
    }
}
