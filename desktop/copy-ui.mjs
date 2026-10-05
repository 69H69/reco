// Copie l'interface (../public) dans desktop/ui pour l'intégrer à l'installateur.
import fs from "node:fs";
fs.rmSync("ui", { recursive: true, force: true });
fs.cpSync("../public", "ui", { recursive: true });
console.log("interface copiée dans desktop/ui");
