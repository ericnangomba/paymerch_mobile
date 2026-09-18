/**
 * Generates PWA icon assets for Paymerch Mobile.
 *
 * - `favicon-*.png` (16/32/48) are derived from the small tab icon (`favicon.png`)
 *   so the browser favicon matches the brand favicon exactly.
 * - App / install icons (192/512/maskable/apple-touch) are derived from the
 *   `mlogopaymerch.png` brand mark so the installed PWA and app icon are
 *   consistent.
 *
 * Run from the paymerch-mobile project root: `node scripts/gen-pwa-icons.js`
 * Requires `sharp` (dev dependency).
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const assetsDir = path.join(root, 'assets', 'images');

const faviconSrc = path.join(assetsDir, 'favicon.png');
const logoSrc = path.join(assetsDir, 'mlogo.png');

(async () => {
  fs.mkdirSync(path.join(publicDir, 'icons'), { recursive: true });

  for (const size of [16, 32, 48]) {
    const out = path.join(publicDir, `favicon-${size}x${size}.png`);
    await sharp(faviconSrc).resize(size, size).toFormat('png').toFile(out);
    console.log(`wrote favicon-${size}x${size}.png (${size}x${size})`);
  }

  for (const size of [192, 512]) {
    const out = path.join(publicDir, 'icons', `${size}.png`);
    await sharp(logoSrc).resize(size, size).toFormat('png').toFile(out);
    console.log(`wrote icons/${size}.png (${size}x${size})`);
  }

  await sharp(logoSrc)
    .resize(480, 480)
    .extend({ top: 16, bottom: 16, left: 16, right: 16, background: '#00A8A8' })
    .toFormat('png')
    .toFile(path.join(publicDir, 'icons', 'maskable-512.png'));
  console.log('wrote icons/maskable-512.png (512x512 maskable)');

  const ati = path.join(publicDir, 'apple-touch-icon.png');
  await sharp(logoSrc).resize(180, 180).toFormat('png').toFile(ati);
  console.log('wrote apple-touch-icon.png (180x180)');
})();
