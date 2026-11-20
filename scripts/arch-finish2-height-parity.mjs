#!/usr/bin/env node
// arch-finish2：heightAt 单一实现的前后逐位对照（22,000 点，host + seed13/v2）。
//
// 用法：
//   node scripts/arch-finish2-height-parity.mjs --label before
//   node scripts/arch-finish2-height-parity.mjs --label after
//   node scripts/arch-finish2-height-parity.mjs --compare
//
// 口径：
//   · 采样器与 scripts/p2-space-parity.mjs 同一套（8k 均匀 + 1k 河岸 + 1k 桥带 + 1k 地点），
//     每个世界 11,000 点，两个世界共 22,000 点；
//   · 每个点同时问三处：生产空间 space.heightAt、重放 stage.heightAt、campSurface(stage).heightAt；
//   · 哈希用 String(数值) 逐点拼接后 SHA-256，浮点不经 toFixed/四舍五入；
//   · before/after 必须 combined 哈希逐位相同；任一 notSame 退出 1。
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { campBridgeBounds, generateCampLayout, TOWN_SIZE } from '../shared/camp-layout.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { campSite } from '../shared/camp-interaction.mjs';
import { campSceneContent, campSitesOf, staticCampSites } from '../shared/camp-scene-content.mjs';
import { outdoorStage } from '../shared/camp-scene.mjs';
import { createSurvPlay } from '../life/survplay.mjs';
import { constructionSpace, sceneSpace } from '../life/construction-access.mjs';
import { campSurface } from '../life/space.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'arch-finish2');
mkdirSync(OUT, { recursive: true });

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const LABEL = arg('--label', 'before');
const COMPARE = process.argv.includes('--compare');
const WORLDS = [
  { label: 'host', seed: 0, version: 0 },
  { label: 'seed13v2', seed: 13, version: 2 },
];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const commit = () => {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
};

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// 与 scripts/p2-space-parity.mjs 的 samplesFor 逐行同源；改这里必须同步那边。
function samplesFor(mapSeed, layoutVersion) {
  const rnd = prng(20261119);
  const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, true, layoutVersion);
  const layout = generateCampLayout(mapSeed, layoutVersion);
  const points = [];
  for (let i = 0; i < 8000; i += 1) points.push([rnd() * 120, rnd() * 80]);
  for (let i = 0; i < 1000; i += 1) {
    const z = rnd() * 80;
    const center = riverCenter(z * 16) / 16;
    const half = riverHalfWidth(z * 16) / 16;
    points.push([center + (rnd() * 2 - 1) * (half + .35), z]);
  }
  const bounds = campBridgeBounds(layout.crossZ - 1, layout.crossZ + 1, riverCenter, riverHalfWidth);
  for (let i = 0; i < 1000; i += 1) {
    points.push([bounds[0] + rnd() * (bounds[2] - bounds[0]), bounds[1] + rnd() * (bounds[3] - bounds[1])]);
  }
  const sites = Object.values(layout.sites);
  for (let i = 0; i < 1000; i += 1) {
    const [sx, sz] = sites[Math.floor(rnd() * sites.length)];
    points.push([sx + .5 + (rnd() * 2 - 1) * 2.5, sz + .5 + (rnd() * 2 - 1) * 3.5]);
  }
  return points;
}

// 逐字复刻 life/construction-access.mjs 的 sceneGeometry()：服务端没有导出 stage，
// 这里用同一批公共生成器重放，先验证 spaceHeight===campHeight 才说明重放忠实。
function stageFor(w) {
  const layout = w.campLayout ?? null;
  const landmarks = Object.fromEntries(['home', 'hall', 'store', 'yard', 'workshop', 'garden', 'watch', 'well']
    .map((loc) => [loc, campSite(loc, layout)]));
  const liveSites = campSitesOf({ rooms: w.locs, districts: w.districts, layout, peripheralHomes: w.peripheralHomes });
  const sites = staticCampSites(liveSites, w.districts, w.peripheralHomes);
  const content = campSceneContent({
    mapSeed: w.mapSeed, layoutVersion: w.layoutVersion ?? 0, layout,
    camp: true, timber: true, sites,
    districts: w.districts, peripheralHomes: w.peripheralHomes,
    households: w.survival?.households, homeRoads: w.survival?.homeRoads,
  });
  return outdoorStage({
    tw: TOWN_SIZE.width, th: TOWN_SIZE.depth, sites,
    trees: content.trees, grass: [], hills: content.landscape ? [] : content.hills,
    height: content.landscape?.height, layoutSeed: layout ? w.mapSeed : null,
  }, content.bridges, content.rocks);
}

function makeWorld(seed, version) {
  return createSurvPlay(seed, {
    gameRules: true, mapSeed: seed, layoutVersion: version, settlementLife: true,
    regionalWork: true, independentWorld: true, residentialDecisions: true,
    unifiedCooperation: true, actTimeModel: true,
  }).world;
}

function run() {
  const worlds = [];
  const combined = [];
  for (const spec of WORLDS) {
    const w = makeWorld(spec.seed, spec.version);
    const space = constructionSpace(w) ?? sceneSpace(w);
    if (!space) throw new Error(`${spec.label} 没有 space`);
    const stage = stageFor(w);
    const camp = campSurface({
      mapSeed: w.mapSeed, layoutVersion: w.layoutVersion ?? 0,
      layout: w.campLayout ?? null, stage,
    });
    const points = samplesFor(spec.seed, spec.version);
    const lines = [];
    let notSame = 0, spaceVsCampDiff = 0, stageVsCampDiff = 0, maxDiff = 0, nonzero = 0;
    const firstDiffs = [];
    for (const [x, z] of points) {
      const spaceH = space.heightAt(x, z);
      const stageH = stage.heightAt(x, z);
      const campH = camp.heightAt(x, z);
      if (spaceH !== campH) {
        spaceVsCampDiff += 1;
        if (firstDiffs.length < 8) firstDiffs.push({ kind: 'space-vs-camp', x, z, spaceH, campH });
      }
      if (stageH !== campH) {
        stageVsCampDiff += 1;
        if (firstDiffs.length < 8) firstDiffs.push({ kind: 'stage-vs-camp', x, z, stageH, campH });
      }
      if (!Object.is(spaceH, stageH) || !Object.is(stageH, campH)) notSame += 1;
      const diff = Math.abs(spaceH - campH);
      if (diff > maxDiff) maxDiff = diff;
      if (campH !== 0) nonzero += 1;
      lines.push(`${x},${z},${spaceH},${stageH},${campH}`);
    }
    const worldHash = sha256(lines.join('\n'));
    worlds.push({
      label: spec.label, seed: spec.seed, version: spec.version,
      layout: Boolean(w.campLayout), points: points.length,
      nonzeroHeights: nonzero, notSame, spaceVsCampDiff, stageVsCampDiff,
      maxDiff, firstDiffs,
      hash: worldHash,
    });
    combined.push(`${spec.label}:${worldHash}`);
  }
  return {
    label: LABEL,
    commit: commit(),
    algorithm: 'sha256 of per-point "x,z,spaceH,stageH,campH" lines',
    pointsPerWorld: 11000,
    totalPoints: WORLDS.length * 11000,
    worlds,
    combinedHash: sha256(combined.join('\n')),
    allSame: worlds.every((w) => w.notSame === 0 && w.spaceVsCampDiff === 0 && w.stageVsCampDiff === 0),
  };
}

function compare() {
  const a = JSON.parse(readFileSync(join(OUT, 'height-before.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(OUT, 'height-after.json'), 'utf8'));
  const perWorld = a.worlds.map((wa) => {
    const wb = b.worlds.find((w) => w.label === wa.label);
    return {
      label: wa.label, before: wa.hash, after: wb?.hash ?? null,
      same: Boolean(wb) && wa.hash === wb.hash,
      beforeNotSame: wa.notSame, afterNotSame: wb?.notSame ?? null,
    };
  });
  const result = {
    before: { label: a.label, commit: a.commit, combinedHash: a.combinedHash, allSame: a.allSame },
    after: { label: b.label, commit: b.commit, combinedHash: b.combinedHash, allSame: b.allSame },
    perWorld,
    pointsPerRun: a.totalPoints,
    runs: 2,
    totalComparedPoints: a.totalPoints + b.totalPoints,
    allSame: a.combinedHash === b.combinedHash && perWorld.every((w) => w.same) && a.allSame && b.allSame,
  };
  writeFileSync(join(OUT, 'height-compare.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`before ${a.combinedHash}`);
  console.log(`after  ${b.combinedHash}`);
  for (const w of perWorld) console.log(`[${w.label}] same ${w.same} · beforeNotSame ${w.beforeNotSame} · afterNotSame ${w.afterNotSame}`);
  console.log(`22,000 点逐位相同：${result.allSame}`);
  if (!result.allSame) process.exitCode = 1;
}

if (COMPARE) {
  compare();
} else {
  const result = run();
  writeFileSync(join(OUT, `height-${LABEL}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`label ${result.label} · commit ${result.commit}`);
  for (const w of result.worlds) {
    console.log(`[${w.label}] ${w.points} 点 · notSame ${w.notSame} · spaceVsCamp ${w.spaceVsCampDiff} · stageVsCamp ${w.stageVsCampDiff} · nonzero ${w.nonzeroHeights} · hash ${w.hash}`);
  }
  console.log(`combined ${result.combinedHash} · allSame ${result.allSame}`);
  if (!result.allSame) process.exitCode = 1;
}
