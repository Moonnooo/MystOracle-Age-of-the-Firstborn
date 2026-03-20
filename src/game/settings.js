/**
 * Game settings (e.g. blood particles). Persisted in localStorage.
 */

const STORAGE_BLOOD_PARTICLES = 'voxelShooterBloodParticles';

function getStoredBloodParticles() {
    const v = localStorage.getItem(STORAGE_BLOOD_PARTICLES);
    if (v === null) return true; // default: on
    return v !== 'false';
}

let _bloodParticles = getStoredBloodParticles();

export function getBloodParticlesEnabled() {
    return _bloodParticles;
}

export function setBloodParticlesEnabled(enabled) {
    _bloodParticles = Boolean(enabled);
    localStorage.setItem(STORAGE_BLOOD_PARTICLES, _bloodParticles ? 'true' : 'false');
}
