import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const tauriConf = JSON.parse(
  await fs.readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")
);

const version = pkg.version;
const productName = tauriConf.productName || pkg.name;

const msiDir = path.join(root, "src-tauri", "target", "release", "bundle", "msi");

let entries;
try {
  entries = await fs.readdir(msiDir, { withFileTypes: true });
} catch {
  throw new Error(`MSI output folder not found: ${msiDir}`);
}

const msis = [];
for (const e of entries) {
  if (e.isFile() && e.name.toLowerCase().endsWith(".msi")) {
    const full = path.join(msiDir, e.name);
    const stat = await fs.stat(full);
    msis.push({ full, name: e.name, mtimeMs: stat.mtimeMs });
  }
}

if (msis.length === 0) {
  throw new Error(`No .msi files found in: ${msiDir}`);
}

msis.sort((a, b) => b.mtimeMs - a.mtimeMs);
const latest = msis[0];

const desiredName = `${productName}-v${version}.msi`;
const desiredPath = path.join(msiDir, desiredName);

if (path.resolve(latest.full) !== path.resolve(desiredPath)) {
  await fs.copyFile(latest.full, desiredPath);
  console.log(`Created: ${desiredPath}`);
} else {
  console.log(`MSI already named: ${desiredName}`);
}

