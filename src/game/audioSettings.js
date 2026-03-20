/**
 * Game sound volume and mute. Persisted in localStorage.
 */

const STORAGE_VOLUME = 'voxelShooterGameVolume';
const STORAGE_MUTED = 'voxelShooterGameMuted';

function getStoredVolume() {
    const v = localStorage.getItem(STORAGE_VOLUME);
    if (v === null) return 1;
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function getStoredMuted() {
    const m = localStorage.getItem(STORAGE_MUTED);
    return m === 'true';
}

let _volume = getStoredVolume();
let _muted = getStoredMuted();

export function getGameVolume() {
    return _volume;
}

export function getGameMuted() {
    return _muted;
}

export function setGameVolume(value) {
    const v = Math.max(0, Math.min(1, Number(value)));
    _volume = v;
    localStorage.setItem(STORAGE_VOLUME, String(v));
}

export function setGameMuted(muted) {
    _muted = Boolean(muted);
    localStorage.setItem(STORAGE_MUTED, _muted ? 'true' : 'false');
}

/** Effective volume multiplier for game sounds (0 when muted). */
export function getEffectiveVolume() {
    return _muted ? 0 : _volume;
}
