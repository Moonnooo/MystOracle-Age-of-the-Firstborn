/**
 * Chat-style command bar: T to open; commands start with a slash.
 * Suggestions filter as you type; click or Tab to complete (arrows to highlight).
 */

import { computeBaseHeight } from '../world/terrain/baseHeight.js';
import { getBiomeAt, BIOMES } from '../world/terrain/biomes.js';

const BIOME_ALIASES = {
    plains: BIOMES.PLAINS,
    forest: BIOMES.FOREST,
    mountains: BIOMES.MOUNTAINS,
    desert: BIOMES.DESERT,
    ocean: BIOMES.OCEAN,
    swamp: BIOMES.SWAMP,
    river: BIOMES.RIVER,
};

function findCoordsForBiome(biomeKey) {
    const want = BIOME_ALIASES[String(biomeKey).toLowerCase()];
    if (!want) return null;
    for (let r = 8; r < 800; r += 8) {
        const steps = Math.max(12, Math.floor(r * 0.2));
        for (let i = 0; i < steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            const wx = Math.round(Math.cos(a) * r);
            const wz = Math.round(Math.sin(a) * r);
            const bh = computeBaseHeight(wx, wz);
            if (getBiomeAt(wx, wz, bh) === want) {
                return { wx, wz };
            }
        }
    }
    return null;
}

/** Full strings for prefix autocomplete */
const ALL_SUGGESTIONS = [
    '/help',
    '/time 12',
    '/timescale 0',
    '/timescale 1',
    '/day',
    '/day 0',
    '/noon',
    '/midnight',
    '/dawn',
    '/dusk',
    '/weather clear',
    '/weather lightrain',
    '/weather rain',
    '/weather heavyrain',
    '/weather storm',
    '/weather snow',
    '/weather cold',
    '/tp ',
    '/tp forest',
    '/tp mountains',
    '/tp desert',
    '/tp plains',
    '/tp ocean',
    '/mobs on',
    '/mobs off',
    '/mobs clear',
    '/chunks 6',
    '/chunks 8',
    '/pos',
];

function filterSuggestions(input) {
    const t = input.trimStart();
    if (!t.startsWith('/')) return [];
    const tl = t.toLowerCase();
    return ALL_SUGGESTIONS.filter((s) => s.toLowerCase().startsWith(tl)).slice(0, 14);
}

const WEATHER_MAP = {
    clear: 'clear',
    sun: 'clear',
    lightrain: 'lightrain',
    drizzle: 'lightrain',
    rain: 'rain',
    light_rain: 'lightrain',
    heavyrain: 'heavyrain',
    heavy: 'heavyrain',
    downpour: 'heavyrain',
    storm: 'storm',
    thunder: 'storm',
    snow: 'snow',
    cold: 'snow',
};

/**
 * @param {object} ctx
 * @param {object} ctx.scene
 * @param {object} ctx.player
 * @param {object} ctx.sky
 * @param {object} ctx.terrain
 * @param {object} ctx.mobSystem
 * @param {object} ctx.weatherEffects - createWeatherEffects API
 * @param {function} ctx.placePlayerAtSpawn
 * @param {function} [ctx.onOpenChange]
 */
export function createDevConsole(ctx) {
    const {
        player,
        sky,
        terrain,
        mobSystem,
        weatherEffects,
        placePlayerAtSpawn,
        onOpenChange,
    } = ctx;

    let open = false;
    let selIdx = -1;

    const root = document.createElement('div');
    root.id = 'devCommandChat';
    root.style.cssText = [
        'display:none',
        'position:fixed',
        'left:50%',
        'bottom:20px',
        'transform:translateX(-50%)',
        'width:min(560px,calc(100vw - 28px))',
        'z-index:100002',
        'font:14px/1.35 system-ui,Segoe UI,sans-serif',
        'flex-direction:column',
        'align-items:stretch',
        'gap:0',
    ].join(';');

    const suggestBox = document.createElement('div');
    suggestBox.style.cssText = [
        'display:none',
        'max-height:min(200px,28vh)',
        'overflow:auto',
        'margin-bottom:4px',
        'background:rgba(8,12,22,0.94)',
        'border:1px solid rgba(120,160,255,0.35)',
        'border-radius:8px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
    ].join(';');
    root.appendChild(suggestBox);

    const logEl = document.createElement('div');
    logEl.style.cssText = [
        'display:none',
        'max-height:64px',
        'overflow:auto',
        'padding:6px 10px',
        'font-size:12px',
        'color:#b8c8e8',
        'background:rgba(8,12,22,0.85)',
        'border:1px solid rgba(120,160,255,0.2)',
        'border-radius:6px',
        'margin-bottom:4px',
        'white-space:pre-wrap',
        'word-break:break-word',
    ].join(';');
    root.appendChild(logEl);

    const row = document.createElement('div');
    row.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:10px 12px',
        'background:rgba(12,18,32,0.92)',
        'border:1px solid rgba(120,160,255,0.4)',
        'border-radius:8px',
        'box-shadow:0 6px 28px rgba(0,0,0,0.45)',
    ].join(';');

    const hint = document.createElement('span');
    hint.textContent = '/';
    hint.style.cssText = 'opacity:0.5;font-weight:600;user-select:none';
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'command…  (Tab = complete, ↑↓ = pick)';
    input.style.cssText = 'flex:1;background:transparent;border:none;color:#f0f4ff;padding:4px 0;outline:none;font:inherit';
    row.appendChild(hint);
    row.appendChild(input);
    root.appendChild(row);

    document.body.appendChild(root);

    let logLines = [];

    function log(line) {
        logLines.push(line);
        if (logLines.length > 5) logLines.shift();
        logEl.textContent = logLines.join('\n');
        logEl.style.display = logLines.length ? 'block' : 'none';
    }

    function renderSuggestions() {
        const list = filterSuggestions(input.value);
        suggestBox.innerHTML = '';
        selIdx = Math.min(selIdx, list.length - 1);
        if (list.length === 0) {
            suggestBox.style.display = 'none';
            return;
        }
        suggestBox.style.display = 'block';
        list.forEach((text, i) => {
            const el = document.createElement('div');
            el.textContent = text;
            el.style.cssText = [
                'padding:8px 12px',
                'cursor:pointer',
                'color:#e8f0ff',
                'border-bottom:1px solid rgba(80,100,140,0.25)',
            ].join(';');
            if (i === selIdx) {
                el.style.background = 'rgba(80,120,200,0.35)';
            }
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = text.endsWith(' ') ? text : `${text} `;
                selIdx = -1;
                renderSuggestions();
                input.focus();
            });
            el.addEventListener('mouseenter', () => {
                selIdx = i;
                renderSuggestions();
            });
            suggestBox.appendChild(el);
        });
    }

    function applyCompletion() {
        const list = filterSuggestions(input.value);
        if (list.length === 0) return;
        const pick = selIdx >= 0 ? list[selIdx] : list[0];
        input.value = pick.endsWith(' ') ? pick : `${pick} `;
        selIdx = -1;
        renderSuggestions();
    }

    function setOpen(v) {
        open = v;
        root.style.display = v ? 'flex' : 'none';
        if (v) {
            input.value = '/';
            selIdx = -1;
            renderSuggestions();
            input.focus();
            input.setSelectionRange(1, 1);
            if (typeof document.exitPointerLock === 'function' && document.pointerLockElement) {
                document.exitPointerLock();
            }
        } else {
            suggestBox.style.display = 'none';
        }
        if (typeof onOpenChange === 'function') onOpenChange(v);
    }

    function toggle() {
        setOpen(!open);
    }

    function runCommand(line) {
        const raw = line.trim();
        if (!raw.startsWith('/')) {
            log('Commands start with /  (e.g. /help)');
            return;
        }
        const body = raw.slice(1).trim();
        if (!body) return;

        const parts = body.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const a1 = parts[1];
        const a2 = parts[2];

        try {
            if (cmd === 'help' || cmd === '?') {
                log('/help /time /timescale /day /noon /midnight /dawn /dusk');
                log('/weather clear|lightrain|rain|heavyrain|storm|snow|cold');
                log('/tp x z  |  /tp forest|mountains|plains|ocean…  /mobs on|off|clear  /chunks n  /pos');
                return;
            }

            if (cmd === 'time') {
                const t = a1 === 'set' && parts[2] != null ? parseFloat(parts[2]) : parseFloat(a1);
                if (!Number.isFinite(t)) {
                    log('/time <0-24>');
                    return;
                }
                sky.setTime(Math.max(0, Math.min(24, t)));
                log(`time → ${sky.getTime().toFixed(2)}`);
                return;
            }

            if (cmd === 'timescale' || cmd === 'timespeed') {
                const s = parseFloat(a1);
                if (!Number.isFinite(s)) {
                    log(`timescale = ${sky.getTimeScale()}`);
                    return;
                }
                sky.setTimeScale(s);
                log(`timescale = ${sky.getTimeScale()}`);
                return;
            }

            if (cmd === 'day') {
                if (a1 != null && Number.isFinite(parseInt(a1, 10))) {
                    sky.setDayCount(parseInt(a1, 10));
                }
                log(`day = ${sky.getDayCount()}`);
                return;
            }

            if (cmd === 'noon') {
                sky.setTime(12);
                log('noon');
                return;
            }
            if (cmd === 'midnight') {
                sky.setTime(0);
                log('midnight');
                return;
            }
            if (cmd === 'dawn') {
                sky.setTime(5.5);
                log('dawn');
                return;
            }
            if (cmd === 'dusk') {
                sky.setTime(18.5);
                log('dusk');
                return;
            }

            if (cmd === 'weather') {
                const w = (a1 || 'clear').toLowerCase();
                const key = WEATHER_MAP[w] ?? 'clear';
                if (weatherEffects?.setManualMode) weatherEffects.setManualMode(key);
                else if (weatherEffects?.setMode) weatherEffects.setMode(key);
                log(`weather → ${key}`);
                return;
            }

            if (cmd === 'tp' || cmd === 'teleport') {
                if (!a1) {
                    log('/tp x z  or  /tp desert');
                    return;
                }
                const bio = a1.toLowerCase();
                if (BIOME_ALIASES[bio]) {
                    const found = findCoordsForBiome(bio);
                    if (!found) {
                        log(`no ${bio} found`);
                        return;
                    }
                    placePlayerAtSpawn(found.wx + 0.5, found.wz + 0.5);
                    log(`tp → ${bio}`);
                    return;
                }
                const x = parseFloat(a1);
                const z = parseFloat(a2);
                if (!Number.isFinite(x) || !Number.isFinite(z)) {
                    log('/tp x z');
                    return;
                }
                placePlayerAtSpawn(x, z);
                log(`tp ${x} ${z}`);
                return;
            }

            if (cmd === 'mobs') {
                const sub = (a1 || '').toLowerCase();
                if (sub === 'off' || sub === 'disable') {
                    mobSystem?.setMobsEnabled?.(false);
                    log('mobs off');
                } else if (sub === 'on' || sub === 'enable') {
                    mobSystem?.setMobsEnabled?.(true);
                    log('mobs on');
                } else if (sub === 'clear' || sub === 'killall') {
                    mobSystem?.clearAll?.();
                    log('mobs cleared');
                } else {
                    log('/mobs on | off | clear');
                }
                return;
            }

            if (cmd === 'chunks' || cmd === 'dist' || cmd === 'rd') {
                const n = parseInt(a1, 10);
                if (!Number.isFinite(n) || n < 1 || n > 16) {
                    log('/chunks 1–16');
                    return;
                }
                terrain?.setRenderDistance?.(n);
                log(`chunks ${n}`);
                return;
            }

            if (cmd === 'pos' || cmd === 'where') {
                if (player) {
                    log(`x ${player.position.x.toFixed(1)} y ${player.position.y.toFixed(1)} z ${player.position.z.toFixed(1)}`);
                }
                return;
            }

            log(`unknown: /${cmd}  — /help`);
        } catch (err) {
            log(String(err?.message || err));
        }
    }

    input.addEventListener('input', () => {
        selIdx = -1;
        renderSuggestions();
    });

    input.addEventListener('keydown', (e) => {
        const list = filterSuggestions(input.value);

        if (e.key === 'ArrowDown' && list.length) {
            e.preventDefault();
            selIdx = Math.min(list.length - 1, selIdx + 1);
            if (selIdx < 0) selIdx = 0;
            renderSuggestions();
            return;
        }
        if (e.key === 'ArrowUp' && list.length) {
            e.preventDefault();
            selIdx = Math.max(0, selIdx - 1);
            renderSuggestions();
            return;
        }
        if (e.key === 'Tab' && list.length) {
            e.preventDefault();
            applyCompletion();
            return;
        }

        if (e.key === 'Enter') {
            const line = input.value;
            input.value = '/';
            log(`> ${line}`);
            runCommand(line);
            selIdx = -1;
            renderSuggestions();
            input.setSelectionRange(1, 1);
            e.preventDefault();
            return;
        }
        if (e.key === 'Escape' && open) {
            setOpen(false);
            e.preventDefault();
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const isT = e.key === 't' || e.key === 'T';
        if (!isT) return;
        if (e.target === input) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        toggle();
    }, true);

    return {
        toggle,
        isOpen: () => open,
        log,
    };
}
