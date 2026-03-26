#!/usr/bin/env node
/**
 * Validate the Chrome extension structure.
 * Checks that manifest.json is well-formed and that all files it references exist.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let errors = 0;

function check(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    errors++;
  } else {
    console.log(`  OK    ${message}`);
  }
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ── 1. Parse manifest ────────────────────────────────────────────────────────
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  console.log('\nmanifest.json');
  check(true, 'valid JSON');
} catch (e) {
  console.error(`  FAIL  manifest.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

// ── 2. Required manifest fields ──────────────────────────────────────────────
console.log('\nManifest fields');
check(manifest.manifest_version === 3,    'manifest_version is 3');
check(typeof manifest.name === 'string',  'name is present');
check(typeof manifest.version === 'string', 'version is present');
check(manifest.content_security_policy?.extension_pages?.includes('wasm-unsafe-eval'),
      'CSP includes wasm-unsafe-eval (required for Stockfish WASM)');

// ── 3. Service worker ────────────────────────────────────────────────────────
console.log('\nBackground service worker');
const swPath = manifest.background?.service_worker;
check(typeof swPath === 'string', 'background.service_worker is declared');
if (swPath) check(exists(swPath), `${swPath} exists`);

// ── 4. Side panel ────────────────────────────────────────────────────────────
console.log('\nSide panel');
const spPath = manifest.side_panel?.default_path;
check(typeof spPath === 'string', 'side_panel.default_path is declared');
if (spPath) check(exists(spPath), `${spPath} exists`);

// ── 5. Content scripts ───────────────────────────────────────────────────────
console.log('\nContent scripts');
for (const entry of manifest.content_scripts ?? []) {
  for (const js of entry.js ?? []) {
    check(exists(js), `${js} exists`);
  }
}

// ── 6. Web-accessible resources ─────────────────────────────────────────────
console.log('\nWeb-accessible resources');
for (const group of manifest.web_accessible_resources ?? []) {
  for (const resource of group.resources ?? []) {
    if (resource.includes('*')) continue; // skip globs
    check(exists(resource), `${resource} exists`);
  }
}

// ── 7. Action icons ──────────────────────────────────────────────────────────
console.log('\nAction icons');
for (const [size, iconPath] of Object.entries(manifest.action?.default_icon ?? {})) {
  check(exists(iconPath), `icon${size} (${iconPath}) exists`);
}

// ── 8. Permissions sanity check ──────────────────────────────────────────────
console.log('\nPermissions');
const perms = manifest.permissions ?? [];
check(perms.includes('sidePanel'), 'sidePanel permission declared');
check(perms.includes('storage'),   'storage permission declared');

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${errors === 0 ? 'All checks passed.' : `${errors} check(s) failed.`}\n`);
process.exit(errors > 0 ? 1 : 0);
