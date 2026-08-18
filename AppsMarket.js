var display = require("display");
var keyboard = require("keyboard");
var storage = require("storage");
var wifi = require("wifi");
var dialog = require("dialog");

// ----- Colors -----
var COL_BLACK = display.color(0, 0, 0);
var COL_WHITE = display.color(255, 255, 255);
var COL_GREY  = display.color(127, 127, 127);
var COL_GREEN = display.color(0, 255, 0);
var COL_CYAN  = display.color(0, 255, 255);
var COL_YELLOW = display.color(255, 255, 0);
var COL_RED   = display.color(255, 0, 0);
var COL_ORANGE = display.color(255, 165, 0);

var W = display.width();
var H = display.height();

// ----- Config -----
var API_BASE = "http://1mpsb1.malsky.net:65030";
var INSTALLED_FILE = "/AppsMarket/installed.json";
var APPS_DIR = "/BruceJS/AppsMarket/";

// ----- State -----
var apps = [];
var installed = {};
var currentIndex = 0;
var mode = "list"; // "list" or "detail"
var selectedApp = null;
var message = "";
var messageTimer = 0;
var isWorking = false;
var dirty = true;

// ----- Filesystem (SD or LittleFS) -----
var fs = "littlefs";
try {
    var conf = storage.read({ fs: "sd", path: "/bruce.conf" });
    if (conf) fs = "sd";
} catch (e) {
    fs = "littlefs";
}

// ----- Ensure apps directory exists -----
function ensureAppDir() {
    try {
        storage.readdir({ fs: fs, path: APPS_DIR });
    } catch (e) {
        try {
            storage.mkdir({ fs: fs, path: APPS_DIR });
        } catch (err) {
            try {
                storage.mkdir({ fs: fs, path: "/BruceJS" });
                storage.mkdir({ fs: fs, path: APPS_DIR });
            } catch (err2) {
                setMessage("Cannot create dir");
            }
        }
    }
}

// ----- Helpers -----
function setMessage(msg) {
    message = msg;
    messageTimer = Date.now() + 3000;
    dirty = true;
}

function clearMessage() {
    message = "";
    messageTimer = 0;
}

function isMessageActive() {
    return message && Date.now() < messageTimer;
}

function drawMessage() {
    if (isMessageActive()) {
        display.setTextAlign("center", "bottom");
        display.setTextSize(1);
        display.setTextColor(COL_YELLOW);
        display.drawText(message, W/2, H - 4);
        return true;
    }
    return false;
}

// ----- Centered text with automatic line breaking -----
function drawCenteredLine(text, y, maxLen) {
    if (!maxLen) maxLen = 35;
    if (text.length > maxLen) {
        text = text.substring(0, maxLen - 3) + "...";
    }
    display.setTextAlign("center", "top");
    display.drawText(text, W/2, y);
}

// ----- Installed apps -----
function loadInstalled() {
    try {
        var data = storage.read({ fs: fs, path: INSTALLED_FILE });
        if (data) {
            installed = JSON.parse(data);
        } else {
            installed = {};
        }
    } catch (e) {
        installed = {};
    }
    dirty = true;
}

function saveInstalled() {
    try {
        storage.write({ fs: fs, path: INSTALLED_FILE }, JSON.stringify(installed, null, 2), "write");
    } catch (e) {
        setMessage("Save error");
    }
    dirty = true;
}

// ----- Fetch apps from server -----
function fetchApps() {
    setMessage("Loading...");
    isWorking = true;
    try {
        var url = API_BASE + "/api/apps";
        var resp = wifi.httpFetch(url, { method: "GET", responseType: "json" });
        if (resp.status === 200) {
            apps = resp.body;
            apps.sort(function(a, b) {
                var nameA = a.name ? a.name.toLowerCase() : "";
                var nameB = b.name ? b.name.toLowerCase() : "";
                if (nameA < nameB) return -1;
                if (nameA > nameB) return 1;
                return 0;
            });
            setMessage("Loaded " + apps.length + " apps");
            currentIndex = 0;
        } else {
            setMessage("HTTP " + resp.status);
        }
    } catch (e) {
        setMessage("Network error");
    }
    isWorking = false;
    dirty = true;
}

// ----- Sync installed with actual files (исправлено!) -----
function syncInstalled(appsList) {
    var changed = false;
    var newInstalled = {};
    for (var id in installed) {
        if (installed.hasOwnProperty(id)) {
            var app = null;
            for (var i = 0; i < appsList.length; i++) {
                if (appsList[i].id === id) {
                    app = appsList[i];
                    break;
                }
            }
            if (app) {
                var filename = app.filename || (app.id + ".js");
                var filePath = APPS_DIR + filename;
                try {
                    // Пытаемся прочитать файл – если успешно, значит файл существует
                    storage.read({ fs: fs, path: filePath });
                    newInstalled[id] = installed[id];
                } catch (e) {
                    // Файла нет – удаляем запись
                    changed = true;
                }
            } else {
                // Приложение больше не в списке – удаляем запись
                changed = true;
            }
        }
    }
    if (changed) {
        installed = newInstalled;
        saveInstalled();
    }
}

// ----- App status -----
function getAppStatus(app) {
    var ver = installed[app.id];
    if (!ver) return { text: "MISSING", color: COL_YELLOW };
    if (ver === app.version) return { text: "OK", color: COL_GREEN };
    return { text: "UPDATE", color: COL_ORANGE };
}

// ----- Install / Update -----
function installApp(app) {
    if (isWorking) return;
    isWorking = true;
    setMessage("Downloading " + app.name + "...");

    var url = API_BASE + "/api/apps/" + app.id + "/download";
    var filename = app.filename || (app.id + ".js");
    var savePath = APPS_DIR + filename;

    ensureAppDir();

    try {
        var resp = wifi.httpFetch(url, {
            method: "GET",
            save: { fs: fs, path: savePath, mode: "write" }
        });
        if (resp.status === 200) {
            installed[app.id] = app.version;
            saveInstalled();
            setMessage(app.name + " installed!");
        } else {
            setMessage("Download error: " + resp.status);
        }
    } catch (e) {
        setMessage("Error: " + e.message);
    }
    isWorking = false;
    dirty = true;
    mode = "list";
    selectedApp = null;
}

// ----- Delete -----
function deleteApp(app) {
    if (isWorking) return;
    isWorking = true;
    setMessage("Deleting " + app.name + "...");

    var filename = app.filename || (app.id + ".js");
    var path = APPS_DIR + filename;

    try {
        storage.remove({ fs: fs, path: path });
        delete installed[app.id];
        saveInstalled();
        setMessage(app.name + " deleted.");
    } catch (e) {
        setMessage("Delete error");
    }
    isWorking = false;
    dirty = true;
    mode = "list";
    selectedApp = null;
}

// ----- Draw list -----
function drawList() {
    display.drawFillRect(0, 0, W, H, COL_BLACK);
    display.setTextAlign("center", "top");
    display.setTextSize(1);
    display.setTextColor(COL_CYAN);
    display.drawText("=== App Store ===", W/2, 2);

    var y = 16;
    var lineHeight = 12;
    var maxDisplay = Math.floor((H - y - 10) / lineHeight);
    var start = Math.max(0, currentIndex - Math.floor(maxDisplay / 2));
    var end = Math.min(apps.length, start + maxDisplay);

    for (var i = start; i < end; i++) {
        var app = apps[i];
        var isSelected = (i === currentIndex);
        var status = getAppStatus(app);
        var color = isSelected ? COL_WHITE : COL_GREY;
        var prefix = isSelected ? "> " : "  ";

        display.setTextColor(color);
        var line = prefix + app.name + " v" + app.version + " (" + app.author + ")";
        var statusText = status.text;
        var fullLine = line + "  " + statusText;
        if (fullLine.length > 38) {
            fullLine = fullLine.substring(0, 35) + "...";
        }
        drawCenteredLine(fullLine, y + (i - start) * lineHeight, 38);
    }

    display.setTextColor(COL_GREY);
    display.setTextAlign("center", "bottom");
    display.drawText((currentIndex+1) + "/" + apps.length + "   Prev/Next, Sel details, Esc exit", W/2, H - 4);

    drawMessage();
}

// ----- Draw detail (centered) -----
function drawDetail() {
    var app = selectedApp;
    if (!app) return;

    display.drawFillRect(0, 0, W, H, COL_BLACK);
    display.setTextAlign("center", "top");
    display.setTextSize(1);
    var y = 2;
    var lineHeight = 12;

    display.setTextColor(COL_CYAN);
    drawCenteredLine("=== " + app.name + " ===", y, 35);
    y += lineHeight + 2;

    display.setTextColor(COL_WHITE);
    drawCenteredLine("Author: " + app.author, y, 35);
    y += lineHeight;
    drawCenteredLine("Version: " + app.version, y, 35);
    y += lineHeight;

    var status = getAppStatus(app);
    display.setTextColor(status.color);
    drawCenteredLine("Status: " + status.text, y, 35);
    y += lineHeight + 2;

    display.setTextColor(COL_GREY);
    display.drawText("Description:", W/2, y);
    y += lineHeight;
    display.setTextColor(COL_WHITE);
    var desc = app.description || "No description";
    var words = desc.split(" ");
    var line = "";
    var maxDescLen = 32;
    for (var i = 0; i < words.length; i++) {
        var test = line + (line ? " " : "") + words[i];
        if (test.length > maxDescLen) {
            drawCenteredLine(line, y, maxDescLen);
            y += lineHeight;
            line = words[i];
        } else {
            line = test;
        }
    }
    if (line) {
        drawCenteredLine(line, y, maxDescLen);
        y += lineHeight + 4;
    }

    display.setTextColor(COL_YELLOW);
    display.drawText("Press Select for actions, Esc back", W/2, H - 10);
    drawMessage();
}

// ----- Main loop -----
function main() {
    keyboard.setLongPress(true);
    loadInstalled();
    ensureAppDir();
    fetchApps();

    // Синхронизация после загрузки списка
    syncInstalled(apps);

    dirty = true;
    var exit = false;
    var escPrev = 0;
    var selPrev = 0;

    while (!exit) {
        var escNow = keyboard.getEscPress() ? 1 : 0;
        if (escNow && !escPrev) {
            if (mode === "detail") {
                mode = "list";
                selectedApp = null;
                dirty = true;
            } else {
                exit = true;
                break;
            }
        }
        escPrev = escNow;

        var selNow = keyboard.getSelPress() ? 1 : 0;
        if (selNow && !selPrev) {
            if (mode === "list") {
                if (apps.length > 0) {
                    selectedApp = apps[currentIndex];
                    mode = "detail";
                    dirty = true;
                }
            } else {
                var app = selectedApp;
                if (app) {
                    var status = getAppStatus(app);
                    var actions = [];
                    if (status.text === "MISSING") {
                        actions = ["Install", "Back"];
                    } else if (status.text === "UPDATE") {
                        actions = ["Update", "Delete", "Back"];
                    } else {
                        actions = ["Delete", "Back"];
                    }
                    var choiceMap = {};
                    for (var i = 0; i < actions.length; i++) {
                        choiceMap[actions[i]] = actions[i];
                    }
                    var choice = dialog.choice(choiceMap);
                    if (choice === "Install" || choice === "Update") {
                        installApp(app);
                    } else if (choice === "Delete") {
                        deleteApp(app);
                    } else if (choice === "Back") {
                        // остаёмся в деталях
                    }
                    dirty = true;
                }
            }
        }
        selPrev = selNow;

        if (mode === "list") {
            if (keyboard.getNextPress()) {
                currentIndex = (currentIndex + 1) % apps.length;
                dirty = true;
            }
            if (keyboard.getPrevPress()) {
                currentIndex = (currentIndex - 1 + apps.length) % apps.length;
                dirty = true;
            }
        }

        if (message && Date.now() >= messageTimer) {
            clearMessage();
            dirty = true;
        }

        if (dirty) {
            if (mode === "list") {
                drawList();
            } else {
                drawDetail();
            }
            dirty = false;
        }

        delay(50);
    }

    keyboard.setLongPress(false);
    display.drawFillRect(0, 0, W, H, COL_BLACK);
    display.setTextAlign("center", "middle");
    display.setTextColor(COL_WHITE);
    display.drawText("Exit App Store", W/2, H/2);
    delay(500);
    display.drawFillRect(0, 0, W, H, COL_BLACK);
}

main();