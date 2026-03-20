// main.js
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// --- GPU / Hardware acceleration ---
// Use GPU acceleration if available; comment out disable if you want full GPU
app.commandLine.appendSwitch('ignore-gpu-blacklist');
// app.disableHardwareAcceleration(); // optional: disable if needed

// Keep a global reference to prevent GC
let mainWindow;

function createWindow() {
    const isDev = !app.isPackaged;
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'build', 'icon.ico')
        : path.join(__dirname, 'build', 'icon.ico');
    const iconOpt = require('fs').existsSync(iconPath) ? { icon: iconPath } : {};

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        fullscreen: true, // start in fullscreen (user can press Esc/F11 to exit)
        show: false, // show when ready to prevent flicker
        ...iconOpt,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // allow Node access
            enableWebSQL: false,
            webgl: true,
            spellcheck: false,
        },
        backgroundColor: '#000000',
        fullscreenable: true,
        frame: true // set false for frameless window
    });

    if (isDev) {
        console.log('🚀 Running in DEVELOPMENT mode');
        const devURL = 'http://localhost:5173';
        mainWindow.loadURL(devURL).catch(err =>
            console.error('Failed to load Vite dev server:', err)
        );
        mainWindow.webContents.openDevTools({ mode: 'right' });
    } else {
        console.log('📦 Running in PRODUCTION mode');
        // Production path: use __dirname + dist
        const indexPath = path.join(__dirname, 'dist', 'index.html');
        mainWindow.loadFile(indexPath).catch(err =>
            console.error('Failed to load production index.html:', err)
        );
        // Optional: DevTools in production
        // mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    // Remove menu bar (File, Edit, View, etc.) for true fullscreen game experience
    Menu.setApplicationMenu(null);

    // Intercept Escape before it reaches the page so pointer lock isn't exited by the browser.
    // One Escape = we send 'game-toggle-pause'; renderer shows pause menu and handles pointer lock itself.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') {
            event.preventDefault();
            mainWindow.webContents.send('game-toggle-pause');
        }
    });

    // Show window when ready to prevent flicker
    mainWindow.once('ready-to-show', () => mainWindow.show());

    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Optional: log crashes / GPU info
    mainWindow.webContents.on('crashed', () => console.error('WebContents crashed'));
    mainWindow.on('unresponsive', () => console.warn('Window is unresponsive'));
}

// App ready
app.whenReady().then(createWindow).catch(err =>
    console.error('App failed to start:', err)
);

// macOS: re-create window when dock icon clicked
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Quit when all windows are closed (except macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Optional: global uncaught exception handler
process.on('uncaughtException', err => {
    console.error('Uncaught Exception:', err);
});

// Optional: unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
