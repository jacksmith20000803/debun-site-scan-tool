'use strict';

require('./net');

const { analyze } = require('./analyze');
const { analyzeSite } = require('./site-analyze');
const { mergeEvidence } = require('./inference/merge');
const { renderText, toJson } = require('./report');
const debunPlus = require('../dist/src/debun-plus');

module.exports = { analyze, analyzeSite, analyzeBundles: debunPlus.analyzeBundles, debunPlus, mergeEvidence, renderText, toJson };
