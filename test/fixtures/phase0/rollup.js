"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function clampValue(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
exports.clampValue = clampValue;
