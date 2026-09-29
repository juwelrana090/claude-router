// Copies the self-contained UI into dist/ after `tsc` (which ignores .html files).
// No bundler, no CDN - the HTML is the artifact.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "src", "ui", "index.html");
const destDir = path.join(root, "dist", "ui");
const dest = path.join(destDir, "index.html");

if (!fs.existsSync(src)) {
  console.error("src/ui/index.html is missing");
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`ui -> ${path.relative(root, dest)} (${(fs.statSync(dest).size / 1024).toFixed(1)} kB)`);
