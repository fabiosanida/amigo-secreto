import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCrop } from '../prototype/profile.js';

function canvasEnvironment(t, responses) {
  const originalDocument = globalThis.document;
  const originalFileReader = globalThis.FileReader;
  const canvases = [], encodings = [], operations = [];
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const index = canvases.length;
      const context = {
        fillStyle: '',
        fillRect(...args) { operations.push({ index, operation: 'fill', color: this.fillStyle, args }); },
        drawImage(...args) { operations.push({ index, operation: 'draw', args }); },
      };
      const canvas = {
        width: 0, height: 0,
        getContext(type) { assert.equal(type, '2d'); return context; },
        toBlob(callback, type, quality) {
          encodings.push({ index, type, quality });
          assert.ok(responses.length, 'Unexpected encoding attempt');
          const response = responses.shift();
          callback(response ? new Blob([new Uint8Array(response.size)], { type: response.type }) : null);
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
        this.onload?.();
      });
    }
  };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalFileReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = originalFileReader;
  });
  return { canvases, encodings, operations };
}

const image = { naturalWidth: 960, naturalHeight: 640 };
const crop = () => encodeCrop(image, 280, 1, { x: 0, y: 0 });

test('Safari PNG fallback from a WebP request can be saved as a cropped avatar', async t => {
  const browser = canvasEnvironment(t, [{ type: 'image/png', size: 12000 }]);
  const result = await crop();
  assert.match(result, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(result.split(',')[1], 'base64').length, 12000);
  assert.deepEqual(browser.encodings, [{ index: 0, type: 'image/webp', quality: .8 }]);
  assert.equal(browser.canvases[0].width, 256);
  assert.equal(browser.canvases[0].height, 256);
  assert.deepEqual(browser.operations[0].args, [image, 160, 0, 640, 640, 0, 0, 256, 256]);
});

test('browsers with WebP support keep the compact WebP result', async t => {
  const browser = canvasEnvironment(t, [{ type: 'image/webp', size: 8000 }]);
  assert.match(await crop(), /^data:image\/webp;base64,/);
  assert.equal(browser.encodings.length, 1);
  assert.equal(browser.canvases.length, 1);
});

test('a missing WebP encoder falls back to an explicit PNG request', async t => {
  const browser = canvasEnvironment(t, [null, { type: 'image/png', size: 15000 }]);
  assert.match(await crop(), /^data:image\/png;base64,/);
  assert.deepEqual(browser.encodings.map(item => item.type), ['image/webp', 'image/png']);
});

test('large PNG uses JPEG quality fallback after compositing transparency onto white', async t => {
  const browser = canvasEnvironment(t, [
    { type: 'image/png', size: 300000 },
    { type: 'image/jpeg', size: 280000 },
    { type: 'image/jpeg', size: 70000 },
  ]);
  const result = await crop();
  assert.match(result, /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.from(result.split(',')[1], 'base64').length <= 256 * 1024);
  assert.deepEqual(browser.encodings, [
    { index: 0, type: 'image/webp', quality: .8 },
    { index: 1, type: 'image/jpeg', quality: .8 },
    { index: 1, type: 'image/jpeg', quality: .65 },
  ]);
  assert.deepEqual(browser.operations[1], { index: 1, operation: 'fill', color: '#ffffff', args: [0, 0, 256, 256] });
  assert.equal(browser.operations[2].operation, 'draw');
  assert.equal(browser.operations[2].args[0], browser.canvases[0]);
  assert.ok(browser.canvases.every(canvas => canvas.width === 256 && canvas.height === 256));
});

test('avatar output still fails closed when every encoding exceeds 256 KB', async t => {
  canvasEnvironment(t, [
    { type: 'image/png', size: 300000 },
    { type: 'image/jpeg', size: 290000 },
    { type: 'image/jpeg', size: 280000 },
  ]);
  await assert.rejects(crop(), /Não foi possível reduzir essa foto/);
});
