# Build assets

## App icon (Windows)

The .exe and installer use an icon from **`build/icon.ico`**.

1. **Add the file:** Put your Windows icon file at **`build/icon.ico`** (multi-size .ico, e.g. 256×256).
2. **If your file has another name** (e.g. `icon_mc.icon` or `icon.ico` in the project root):  
   Either rename/copy it to `build/icon.ico`, or run `npm run pack` / `npm run dist` — a prepack script will copy `icon.ico`, `icon_mc.ico`, or `icon_mc.icon` from the project root into `build/icon.ico` if `build/icon.ico` doesn’t exist.
3. **Rebuild:** Run `npm run dist` (or `npm run pack`) **after** the icon is in place. The icon is baked in at build time.
4. **If the icon still doesn’t show:** Windows caches icons. Try a new build, delete the old `release` folder first, or restart. Ensure the file is a real Windows .ico (not a renamed .png).
