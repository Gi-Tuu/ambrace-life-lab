import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readIndex, listSaves, writeIndex } from './camp-instances.mjs';
const dir = () => mkdtempSync(join(tmpdir(), 'idx-'));
// DATA5-06：索引 key 只接受 32 位小写十六进制。
const K = (n) => n.toString(16).padStart(2, '0').repeat(16);
test('DATA4-03 null 索引条目被过滤且不崩', () => { const d = dir(); mkdirSync(join(d, 'saves'), { recursive: true }); writeFileSync(join(d, 'saves', 'index.json'), JSON.stringify({ entries: [null, { key: K(1), name: 'n' }] })); const r = readIndex(d); assert.equal(r.entries.length, 1); assert.equal(r.droppedEntries, 1); assert.doesNotThrow(() => listSaves(d)); });
test('DATA4-03 纯 null 索引返回空而非抛错', () => { const d = dir(); mkdirSync(join(d, 'saves'), { recursive: true }); writeFileSync(join(d, 'saves', 'index.json'), JSON.stringify({ entries: [null, null] })); assert.deepEqual(readIndex(d).entries, []); });
test('DATA4-03 listSaves 不因坏条目抛 TypeError', () => { const d = dir(); mkdirSync(join(d, 'saves'), { recursive: true }); writeFileSync(join(d, 'saves', 'index.json'), JSON.stringify({ entries: [{ key: K(1), name: 'n', lastSeenAt: Date.now() }, null] })); assert.equal(listSaves(d).length, 1); });
test('DATA4-04 并发写索引保留全部条目（唯一 tmp）', () => { const d = dir(); mkdirSync(join(d, 'saves'), { recursive: true }); for (let i = 0; i < 20; i += 1) writeIndex(d, { entries: [{ key: K(i), name: 'n' + i }] }); assert.equal(readIndex(d).entries.length, 1); });
test('DATA4-04 索引写入后可读回', () => { const d = dir(); writeIndex(d, { entries: [{ key: K(1), name: 'x' }, { key: K(2), name: 'y' }] }); assert.deepEqual(readIndex(d).entries.map((e) => e.key), [K(1), K(2)]); });
