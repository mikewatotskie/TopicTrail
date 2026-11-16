const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('html')) config.resolver.assetExts.push('html');
if (!config.resolver.assetExts.includes('txt')) config.resolver.assetExts.push('txt');
module.exports = config;
