import test from 'node:test';
import assert from 'node:assert/strict';
import { measureConservation } from './resource-conservation-probe.mjs';
test('DATA4-01/02 守恒：meat/wool 纳入后 closed 残差为 0', async () => { const r = await measureConservation(7, 48); assert.ok(r.balanced, JSON.stringify({ rows: r.rows, worst: r.worstClosed })); });
test('DATA4-01 篡改账面 gross 必红', async () => { const r = await measureConservation(7, 48, { tamper: (L) => { L.gross.crop = (L.gross.crop ?? 0) + 5; } }); assert.equal(r.balanced, false); });
test('DATA4-02 篡改 consumed meat 必红', async () => { const r = await measureConservation(7, 48, { tamper: (L) => { (L.consumed.meat ??= { total: 0 }).total += 5; } }); assert.equal(r.balanced, false); });

