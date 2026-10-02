// One-time config repair for the Command Code provider. Run from the repo root:  node scripts/fix-commandcode.mjs
// What it does to routes.json (a backup is written to routes.json.bak first), and nothing else:
//   provider "commandcode": protocol -> "openai", baseURL -> https://api.commandcode.ai/provider/v1
//   model "cc-sonnet" (if it still has the wrong id "space-bunny-alpha-free"): model -> stealth/space-bunny-alpha
// Why: Command Code serves Claude models only on /v1/messages and every other model on /v1/chat/completions,
// and the free model's real id is stealth/space-bunny-alpha. It is safe to run twice.
import fs from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), "routes.json");
const raw = fs.readFileSync(file, "utf8");
const cfg = JSON.parse(raw);
const p = cfg.providers?.commandcode;
if (!p) {
  console.log('No provider named "commandcode" in routes.json: nothing to do.');
  process.exit(0);
}
fs.writeFileSync(`${file}.bak`, raw);
const changes = [];
if (p.protocol !== "openai") {
  p.protocol = "openai";
  changes.push('provider commandcode: protocol -> "openai"');
}
if (p.baseURL !== "https://api.commandcode.ai/provider/v1") {
  changes.push(
    `provider commandcode: baseURL ${p.baseURL} -> https://api.commandcode.ai/provider/v1`,
  );
  p.baseURL = "https://api.commandcode.ai/provider/v1";
}
for (const [alias, m] of Object.entries(cfg.models ?? {})) {
  if (m.provider === "commandcode" && m.model === "space-bunny-alpha-free") {
    m.model = "stealth/space-bunny-alpha";
    changes.push(
      `model ${alias}: model space-bunny-alpha-free -> stealth/space-bunny-alpha`,
    );
  }
}
const indent = /^\{\r?\n( +)"/.exec(raw)?.[1]?.length ?? 2;
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
fs.writeFileSync(
  file,
  JSON.stringify(cfg, null, indent).replace(/\n/g, eol) +
    (/\n$/.test(raw) ? eol : ""),
);
console.log(
  changes.length
    ? `Changed ${changes.length} thing(s):\n- ${changes.join("\n- ")}\nBackup: routes.json.bak`
    : "Already correct: nothing changed.",
);
