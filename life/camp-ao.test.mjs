import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeVertexAO } from '../shared/camp-ao.mjs';

const vertex = (y, ny) => {
  const v = new Float32Array(15);
  v[0] = 0; v[1] = y; v[2] = 0;
  v[3] = 1; v[4] = 1; v[5] = 1;
  v[11] = 0; v[12] = ny; v[13] = 0; v[14] = 0.5;
  return v;
};

test('baked AO darkens vertical faces near the ground and leaves ground normals alone', () => {
  const base = vertex(0, 0);
  const top = vertex(1, 0);
  const ground = vertex(0, 1);
  const mesh = new Float32Array([...base, ...top, ...ground]);
  bakeVertexAO(mesh, 15, 0);
  assert.ok(mesh[3] < 1, 'near-ground vertical face must be darkened');
  assert.ok(mesh[15 + 3] > mesh[3], 'higher vertex must be less darkened');
  assert.equal(mesh[30 + 3], 1, 'up-facing ground must not be darkened');
  assert.ok(mesh[3] >= 0.79, 'AO must not crush the color');
});
