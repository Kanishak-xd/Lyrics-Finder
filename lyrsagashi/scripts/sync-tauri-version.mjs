import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function writeJson(p, obj) {
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function bumpCargoTomlVersion(cargoTomlText, version) {
  // Update the first `version = "..."` inside the `[package]` section.
  const re = /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/m;
  if (!re.test(cargoTomlText)) {
    throw new Error("Couldn't find [package] version in Cargo.toml");
  }
  return cargoTomlText.replace(re, `$1${version}$3`);
}

const pkgPath = path.join(root, "package.json");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");

const pkg = await readJson(pkgPath);
if (!pkg?.version) throw new Error("package.json has no version");

const version = pkg.version;

const tauriConf = await readJson(tauriConfPath);
tauriConf.version = version;
await writeJson(tauriConfPath, tauriConf);

const cargoToml = await fs.readFile(cargoTomlPath, "utf8");
await fs.writeFile(cargoTomlPath, bumpCargoTomlVersion(cargoToml, version), "utf8");

console.log(`Synced Tauri and Cargo version to ${version}`);

