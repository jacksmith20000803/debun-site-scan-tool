var __defProp = Object.defineProperty;
var __export = (target, all) => { for (var name in all) __defProp(target, name, { get: all[name], enumerable: true }); };
var initPalette = (() => { function parseColor(value) { const match = /^#?([a-f0-9]{6})$/i.exec(value); return match ? match[1].toLowerCase() : "invalid-color"; } return { parseColor }; })();
export { initPalette };
