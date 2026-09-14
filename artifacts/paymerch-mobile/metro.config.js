const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add support for web assets
config.resolver.assetExts.push('png', 'jpg', 'jpeg', 'gif', 'svg', 'webp');

// Add support for @expo/vector-icons
config.resolver.sourceExts.push('json', 'svg');

// Configure watch folders for better asset resolution
config.watchFolders = [
  __dirname,
];

module.exports = config;
