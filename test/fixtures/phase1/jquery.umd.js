/*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors | jquery.org/license */
(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = global.document ? factory(global, true) : function (window) {
      if (!window.document) throw new Error('jQuery requires a window with a document');
      return factory(window);
    };
  } else {
    factory(global);
  }
})(typeof window !== 'undefined' ? window : this, function (window, noGlobal) {
  var jQuery = function (selector) { return new jQuery.fn.init(selector); };
  jQuery.fn = jQuery.prototype = {
    jquery: '3.7.1',
    constructor: jQuery,
    each: function (callback) { return callback.call(this); }
  };
  if (!noGlobal) window.jQuery = window.$ = jQuery;
  return jQuery;
});
