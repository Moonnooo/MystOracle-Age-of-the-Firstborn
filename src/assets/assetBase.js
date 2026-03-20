// Base URL for static assets so the game works when packaged (Electron file://) and in dev (Vite).
export const ASSET_BASE = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL != null
  ? import.meta.env.BASE_URL
  : './';
