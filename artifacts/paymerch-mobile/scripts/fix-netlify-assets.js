const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const hiddenAssetsRoot = path.join(
  distRoot,
  "assets",
  "__node_modules",
  ".pnpm",
);
const publicAssetsRoot = path.join(distRoot, "assets", "vendor");
const webBundleRoot = path.join(distRoot, "_expo", "static", "js", "web");
const hiddenAssetPrefix = "/assets/__node_modules/.pnpm/";
const publicAssetPrefix = "/assets/vendor/";

function findJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Web bundle directory not found: ${directory}`);
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

function copyAsset(relativePath) {
  const sourcePath = path.resolve(hiddenAssetsRoot, relativePath);
  const destinationPath = path.resolve(publicAssetsRoot, relativePath);

  if (!sourcePath.startsWith(`${hiddenAssetsRoot}${path.sep}`)) {
    throw new Error(`Invalid hidden asset path: ${relativePath}`);
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Referenced web asset not found: ${sourcePath}`);
  }
  if (!destinationPath.startsWith(`${publicAssetsRoot}${path.sep}`)) {
    throw new Error(`Invalid public asset path: ${relativePath}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function main() {
  const bundles = findJavaScriptFiles(webBundleRoot);
  let copiedAssets = 0;
  let rewrittenBundles = 0;

  for (const bundlePath of bundles) {
    const bundle = fs.readFileSync(bundlePath, "utf8");
    const referencedPaths = new Set(
      Array.from(
        bundle.matchAll(/\/assets\/__node_modules\/\.pnpm\/([^"'\\\s]+)/g),
        (match) => decodeURIComponent(match[1]),
      ),
    );

    if (referencedPaths.size === 0) continue;
    if (!fs.existsSync(hiddenAssetsRoot)) {
      throw new Error(
        `Hidden pnpm asset directory not found: ${hiddenAssetsRoot}`,
      );
    }

    for (const relativePath of referencedPaths) {
      copyAsset(relativePath);
      copiedAssets++;
    }

    fs.writeFileSync(
      bundlePath,
      bundle.replaceAll(hiddenAssetPrefix, publicAssetPrefix),
    );
    rewrittenBundles++;
  }

  console.log(
    `Prepared ${copiedAssets} Netlify-safe asset(s) in ${rewrittenBundles} web bundle(s)`,
  );
}

main();
