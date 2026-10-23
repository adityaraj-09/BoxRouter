import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "..", "dist");
mkdirSync(dist, { recursive: true });
copyFileSync(path.join(root, "..", "src", "pricing.json"), path.join(dist, "pricing.json"));
