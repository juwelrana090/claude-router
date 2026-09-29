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

// Inline provider icons (src/ui/icons/*.svg) as data URIs -> window.ICONS.
const iconsDir = path.join(root, "src", "ui", "icons");
const icons = {};
if (fs.existsSync(iconsDir)) {
  for (const f of fs.readdirSync(iconsDir).sort()) {
    if (!f.endsWith(".svg") || /\(\d+\)\.svg$/.test(f)) continue;
    icons[f.slice(0, -4)] = "data:image/svg+xml," + encodeURIComponent(fs.readFileSync(path.join(iconsDir, f), "utf8"));
  }
}

// Inline vendored libs (src/ui/vendor/*.js) ahead of the app script.
const vendorDir = path.join(root, "src", "ui", "vendor");
const vendor = [];
if (fs.existsSync(vendorDir)) {
  for (const f of fs.readdirSync(vendorDir).sort()) {
    if (!f.endsWith(".js")) continue;
    vendor.push("// -- vendor: " + f + " --\n" + fs.readFileSync(path.join(vendorDir, f), "utf8").replace(/<\/script>/g, "<\\/script>"));
  }
}

const html = fs.readFileSync(src, "utf8")
  .replace("/*VENDOR*/", () => vendor.join("\n"))
  .replace("/*ICONS*/{}", () => "/*ICONS*/" + JSON.stringify(icons));
fs.writeFileSync(dest, html);
console.log(`ui -> ${path.relative(root, dest)} (${(fs.statSync(dest).size / 1024).toFixed(1)} kB, ${Object.keys(icons).length} icons, vendor ${vendor.length})`);
