/**
 * ColorXBridge - panel bootstrap.
 *
 * Confirms the panel is really talking to Bridge's ExtendScript engine and
 * dumps a capability report to /tmp/cxb-diag.json for inspection.
 */
(function () {
  'use strict';

  var cs = new CSInterface();

  function show(text) {
    var el = document.getElementById('diagOut');
    if (el) el.textContent = text;
  }

  function hostLine() {
    var el = document.getElementById('hostInfo');
    if (!el) return;
    try {
      var env = cs.getHostEnvironment();
      el.textContent = env.appName + ' ' + env.appVersion;
    } catch (e) {
      el.textContent = 'host unknown';
    }
  }

  function nodeStatus() {
    if (typeof require !== 'function') return 'require(): NOT available';
    try {
      require('fs');
      return 'require(): ok, node ' +
        ((typeof process !== 'undefined' && process.versions)
          ? process.versions.node
          : 'unknown');
    } catch (e) {
      return 'require(): present but fs failed - ' + e.message;
    }
  }

  function run() {
    hostLine();

    var lines = [nodeStatus(), ''];

    cs.evalScript('cxbDiagnosticsToFile("/tmp/cxb-diag.json")', function (res) {
      if (!res || res === 'EvalScript error.') {
        lines.push('evalScript FAILED: ' + res);
        show(lines.join('\n'));
        return;
      }

      var parsed;
      try {
        parsed = JSON.parse(res);
      } catch (e) {
        lines.push('Unparseable reply: ' + res);
        show(lines.join('\n'));
        return;
      }

      var d = parsed.diagnostics || {};
      for (var k in d) {
        if (d.hasOwnProperty(k)) lines.push(k + ': ' + d[k]);
      }
      show(lines.join('\n'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
