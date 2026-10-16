/*
 * Shared assertion used by every test file in this directory: verifies that
 * every sentence a compose() call produced is traceable to codes.json, the
 * caller-supplied citation, a real field on input.claim, or a fixed
 * boilerplate id — never invented. Not a test file itself (deliberately
 * named so Node's `--test` file discovery does not pick it up).
 */
'use strict';
var assert = require('node:assert/strict');

function firstClaimField(sourceRef) {
  // 'claim.lines[0].dos' -> 'lines' ; 'claim.payer' -> 'payer'
  return sourceRef.slice('claim.'.length).split(/[.[]/)[0];
}

function assertGrounded(result, input, codes) {
  assert.ok(result && Array.isArray(result.sentences), 'result.sentences must be an array');
  for (var i = 0; i < result.sentences.length; i++) {
    var s = result.sentences[i];
    assert.ok(typeof s.text === 'string' && s.text.length > 0, 'sentence #' + i + ' has non-empty text');
    assert.ok(typeof s.source_ref === 'string' && s.source_ref.length > 0, 'sentence #' + i + ' has a source_ref: ' + s.text);

    if (s.source_ref === 'missing_input') {
      assert.ok(s.text.indexOf('[NEEDS:') === 0, 'missing_input sentence must be a [NEEDS: ...] placeholder, got: ' + s.text);
    } else if (s.source_ref.indexOf('boilerplate#') === 0) {
      var bid = s.source_ref.slice('boilerplate#'.length);
      assert.ok(Object.prototype.hasOwnProperty.call(codes.boilerplate, bid), 'unknown boilerplate id in source_ref: ' + bid);
      assert.equal(s.text, codes.boilerplate[bid], 'boilerplate sentence must match codes.json verbatim: ' + bid);
    } else if (s.source_ref.indexOf('codes.json#carc.') === 0) {
      var ccode = s.source_ref.slice('codes.json#carc.'.length);
      assert.ok(codes.carc[ccode], 'unknown CARC in source_ref: ' + ccode);
      assert.ok(s.text.indexOf(codes.carc[ccode].text) !== -1, 'CARC sentence must quote codes.json verbatim: ' + s.text);
    } else if (s.source_ref.indexOf('codes.json#rarc.') === 0) {
      var rcode = s.source_ref.slice('codes.json#rarc.'.length);
      assert.ok(codes.rarc[rcode], 'unknown RARC in source_ref: ' + rcode);
      assert.ok(s.text.indexOf(codes.rarc[rcode].text) !== -1, 'RARC sentence must quote codes.json verbatim: ' + s.text);
    } else if (s.source_ref.indexOf('codes.json#cms_manual.') === 0) {
      var mkey = s.source_ref.slice('codes.json#cms_manual.'.length);
      assert.ok(codes.cms_manual[mkey], 'unknown cms_manual key in source_ref: ' + mkey);
      assert.ok(s.text.indexOf(codes.cms_manual[mkey].text) !== -1, 'cms_manual sentence must quote codes.json verbatim: ' + s.text);
    } else if (s.source_ref === 'citation.excerpt') {
      assert.ok(input.citation && input.citation.excerpt, 'citation.excerpt source_ref used without an input.citation.excerpt');
      assert.ok(s.text.indexOf(input.citation.excerpt) !== -1, 'citation sentence must quote the excerpt verbatim: ' + s.text);
    } else if (s.source_ref.indexOf('claim.') === 0) {
      var field = firstClaimField(s.source_ref);
      assert.ok(input.claim && Object.prototype.hasOwnProperty.call(input.claim, field),
        'claim-sourced sentence references claim.' + field + ' but input.claim has no such field (source_ref=' + s.source_ref + ', text=' + s.text + ')');
    } else {
      throw new Error('sentence #' + i + ' has an unrecognized source_ref shape: ' + s.source_ref);
    }
  }

  if (result.letter_markdown) {
    for (var j = 0; j < result.sentences.length; j++) {
      var sent = result.sentences[j];
      assert.ok(result.letter_markdown.indexOf(sent.text) !== -1,
        'tracked sentence is missing from letter_markdown (untracked prose would fail this the other way): ' + sent.text);
    }
  }
}

module.exports = { assertGrounded: assertGrounded };
