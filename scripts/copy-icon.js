const fs = require('fs');
const path = require('path');

const dest = path.join(__dirname, '..', 'build', 'icon.ico');
if (fs.existsSync(dest)) return;

const root = path.join(__dirname, '..');
const candidates = ['icon.ico', 'icon_mc.ico', 'icon_mc.icon'];
for (const name of candidates) {
  const src = path.join(root, name);
  if (fs.existsSync(src)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      console.log('Copied', name, 'to build/icon.ico');
      break;
    } catch (e) {
      console.warn('Failed to copy icon:', e.message);
    }
  }
}
