const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Compile the actual detector class, not a copied implementation. Browser
// objects are injected so failure paths can be checked without a camera.
const sourcePath = path.resolve(__dirname, '../app/index.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'WebQrDetector');
assert.ok(declaration, 'WebQrDetector must exist');
const compiled = ts.transpileModule(`${declaration.getText(ast)}\nmodule.exports = WebQrDetector;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture({native = 'absent', decode = 'success', moduleFails = false, realFrame = false} = {}) {
  const stats = {native: 0, fallback: 0, loads: 0};
  class NotFoundException extends Error {}
  class FormatException extends Error {}
  class ChecksumException extends Error {}
  const zxing = {
    NotFoundException, FormatException, ChecksumException,
    QRCodeReader: class { decode() {
      stats.fallback++;
      if (decode === 'no-code') throw new NotFoundException();
      if (decode === 'error') throw new Error('Unexpected decoder failure');
      return {getText: () => 'PM1:test'};
    }},
    RGBLuminanceSource: class {}, BinaryBitmap: class {}, HybridBinarizer: class {},
  };
  let width = 2;
  let height = 2;
  let pixels = new Uint8ClampedArray(16);
  let detectorModule = zxing;
  let expectedPayload = null;
  if (realFrame) {
    detectorModule = require('@zxing/library');
    const qr = require('./qr-detector-fixture.json');
    expectedPayload = qr.payload;
    const scale = 4;
    const margin = 4;
    width = (qr.rows.length + margin * 2) * scale;
    height = width;
    pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const row = Math.floor(y / scale) - margin;
      const col = Math.floor(x / scale) - margin;
      const dark = qr.rows[row]?.[col] === '1';
      pixels.fill(dark ? 0 : 255, offset, offset + 3);
      pixels[offset + 3] = 255;
    }
  }
  const context = {
    module: {exports: {}},
    document: {createElement: () => ({getContext: () => ({drawImage() {}, getImageData: () => ({data: pixels})})})},
    require(name) { assert.equal(name, '@zxing/library'); stats.loads++; if (moduleFails) throw new Error('Module unavailable'); return detectorModule; },
  };
  if (native !== 'absent') context.BarcodeDetector = class { async detect() {
    stats.native++;
    if (native === 'throws') throw new Error('Native unsupported');
    return native === 'success' ? [{rawValue: 'PM1:native'}] : [];
  }};
  vm.createContext(context);
  vm.runInContext(compiled, context);
  return {detector: new context.module.exports(), stats, video: {videoWidth: width, videoHeight: height}, expectedPayload};
}

(async () => {
  let f = fixture({native: 'success'});
  assert.equal(await f.detector.detect(f.video), 'PM1:native');
  assert.equal(f.stats.loads, 0);

  f = fixture({native: 'empty'});
  let result = null;
  for (let i = 0; i < 4 && !result; i++) result = await f.detector.detect(f.video);
  assert.equal(result, 'PM1:test', 'An empty native result must periodically reach the JS detector');

  f = fixture({native: 'throws'});
  assert.equal(await f.detector.detect(f.video), 'PM1:test');

  f = fixture({decode: 'no-code'});
  for (let i = 0; i < 5; i++) assert.equal(await f.detector.detect(f.video), null);
  assert.equal(f.detector.unavailable, false, 'No QR in a frame is not a broken decoder');

  f = fixture({decode: 'error'});
  for (let i = 0; i < 3; i++) await f.detector.detect(f.video);
  assert.equal(f.detector.unavailable, true, 'Repeated unexpected JS errors must become visible to the caller');

  f = fixture({moduleFails: true});
  assert.equal(await f.detector.detect(f.video), null);
  assert.equal(f.detector.unavailable, true);
  for (const native of ['absent', 'empty']) {
    f = fixture({native, realFrame: true});
    let decoded = null;
    for (let i = 0; i < 4 && !decoded; i++) decoded = await f.detector.detect(f.video);
    assert.equal(decoded, f.expectedPayload, `Real ZXing QR pixels must decode with native detector ${native}`);
  }
  console.log('PASS: six failure-path tests and two real QR-pixel decoding tests');
})().catch(error => {console.error(error); process.exitCode = 1;});
