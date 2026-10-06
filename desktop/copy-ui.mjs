// Copies the UI (../public) into desktop/ui so it ships inside the installer.
import fs from "node:fs";
fs.rmSync("ui", { recursive: true, force: true });
fs.cpSync("../public", "ui", { recursive: true });
console.log("UI copied into desktop/ui");
