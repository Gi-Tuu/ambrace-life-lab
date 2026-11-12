import { collisionIndex, ROOM_BOUNDS, readCollisionData, writeCollisionData } from './collision.mjs';

const STORAGE = 'ambrace-collision-v1';
const EMPTY = new Map();
const ZOOM_LEVELS = [1, 2, 4, 8, 16];

export function createCollisionEditor({ dialog, enabled = true, editable = true, grids, labels, makeScene, move, changed }) {
  if (!enabled) return { cells: () => EMPTY, revision: 0 };
  const find = id => dialog.querySelector('#' + id);
  const canvas = find('collisionCanvas'), surface = find('collisionSurface'), sceneSelect = find('collisionScene');
  const status = find('collisionStatus'), cursor = find('collisionCursor');
  const overlay = find('collisionOverlay'), undo = find('collisionUndo'), redo = find('collisionRedo');
  const zoomSelect = find('collisionZoom'), zoomOut = find('collisionZoomOut'), zoomIn = find('collisionZoomIn');
  const brush = find('collisionBrush'), clearPass = find('collisionClearPass');
  const context = canvas.getContext('2d');
  let data = new Map(), scene, pixelLayer, layerContext, revision = 0, stroke = null, player = null, tool = 'block';
  let pan = null, zoom = 1, hover = null, frame = 0, lastTime = 0, storageNotice = '';
  const keys = new Set(), past = [], future = [];
  const cellMap = id => data.get(id) ?? EMPTY;

  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved) data = readCollisionData(saved, grids);
  } catch {
    storageNotice = '无法读取本机存档。可导入备份。';
  }

  if (!editable) return { cells: cellMap, revision };

  function save() {
    revision += 1;
    changed();
    try {
      localStorage.setItem(STORAGE, writeCollisionData(data,grids));
      storageNotice = '已保存到当前浏览器';
    } catch {
      storageNotice = '浏览器无法保存，请导出备份';
    }
    draw();
  }

  function fillBlock(x, y, width, height, color) {
    context.globalAlpha = 0.36;
    context.fillStyle = color;
    context.fillRect(x, y, width, height);
    context.globalAlpha = 1;
  }

  function brushSize() {
    return Math.max(Number(brush.min), Math.min(Number(brush.max), Math.round(Number(brush.value)) || 1));
  }

  function brushBounds(grid, id, [x, y]) {
    const size = brushSize(), offset = Math.floor((size - 1) / 2);
    const left = x - offset, top = y - offset;
    const { cell, width, height } = grid;
    const bounds = id === 'map' ? { left: 0, top: 0, right: width, bottom: height } : scene.roomBounds ?? ROOM_BOUNDS;
    return [
      Math.max(left, Math.floor(bounds.left / cell)),
      Math.max(top, Math.floor(bounds.top / cell)),
      Math.min(left + size, Math.ceil(bounds.right / cell)),
      Math.min(top + size, Math.ceil(bounds.bottom / cell)),
    ];
  }

  function draw() {
    if (!dialog.open || !scene) return;
    const id = sceneSelect.value, grid = grids[id], cells = cellMap(id);
    const { width, height, cell } = grid;
    context.imageSmoothingEnabled = false;
    context.drawImage(scene.background, 0, 0, width, height);
    if (overlay.checked) {
      if (id !== 'map') {
        const b = scene.roomBounds ?? ROOM_BOUNDS;
        fillBlock(0, 0, width, b.top, '#83769C');
        fillBlock(0, b.top, b.left, height - b.top, '#83769C');
        fillBlock(b.right, b.top, width - b.right, height - b.top, '#83769C');
        context.save();
        context.beginPath();
        context.rect(b.left, b.top, b.right - b.left, b.bottom - b.top);
        context.clip();
      }
      context.drawImage(pixelLayer, 0, 0);
      if (id !== 'map') context.restore();
      context.globalAlpha = 0.22;
      context.strokeStyle = '#FFF0CC';
      context.lineWidth = 1;
      context.beginPath();
      for (let x = 8; x < width; x += 8) { context.moveTo(x + 0.5, 0); context.lineTo(x + 0.5, height); }
      for (let y = 8; y < height; y += 8) { context.moveTo(0, y + 0.5); context.lineTo(width, y + 0.5); }
      context.stroke();
      context.globalAlpha = 1;
    }
    if (hover && tool !== 'test' && tool !== 'pan') {
      const [left, top, right, bottom] = brushBounds(grid, id, hover);
      if (left < right && top < bottom) {
        context.strokeStyle = '#FFF0CC';
        context.lineWidth = 1;
        context.strokeRect(left * cell - 0.5, top * cell - 0.5,
          (right - left) * cell + 1, (bottom - top) * cell + 1);
      }
    }
    if (player) {
      context.fillStyle = '#000000';
      context.fillRect(player.x - 5, player.y - 5, 10, 10);
      context.fillStyle = '#FFEC27';
      context.fillRect(player.x - 3, player.y - 3, 6, 6);
    }
    undo.disabled = !past.length;
    redo.disabled = !future.length;
    const message = '手绘 ' + cells.size + ' 像素' + (storageNotice ? ' · ' + storageNotice : '');
    if (status.textContent !== message) status.textContent = message;
  }

  function sizeCanvas() {
    if (!scene) return;
    const grid = grids[sceneSelect.value];
    const { width, height } = surface.getBoundingClientRect();
    const fit = Math.min(grid.width * 2, width - 4, (height - 4) * grid.width / grid.height);
    canvas.style.width = Math.max(1, Math.floor(fit * zoom)) + 'px';
  }

  function overlayColor(index, edit) {
    if (scene.assetPixels?.[index] === 0) return '#FF004D';
    if (edit === 1) return '#98BD51';
    if (edit === 0 || scene.pixelWalk?.[index] === 0) return '#FF004D';
    return null;
  }

  function updateOverlay(index, edit) {
    const x = index % canvas.width, y = Math.floor(index / canvas.width);
    layerContext.clearRect(x, y, 1, 1);
    const color = overlayColor(index, edit);
    if (color) {
      layerContext.fillStyle = color;
      layerContext.fillRect(x, y, 1, 1);
    }
  }

  function rebuildOverlay() {
    const id = sceneSelect.value, { width, height } = grids[id], cells = cellMap(id);
    const raster = layerContext.createImageData(width, height);
    for (let i = 0; i < width * height; i += 1) {
      const color = overlayColor(i, cells.get(i));
      if (!color) continue;
      const at = i * 4, red = color === '#FF004D';
      raster.data[at] = red ? 255 : 152;
      raster.data[at + 1] = red ? 0 : 189;
      raster.data[at + 2] = red ? 77 : 81;
      raster.data[at + 3] = 92;
    }
    layerContext.putImageData(raster, 0, 0);
  }

  function selectScene() {
    scene = makeScene(sceneSelect.value);
    const grid = grids[sceneSelect.value];
    pixelLayer = document.createElement('canvas');
    pixelLayer.width = grid.width;
    pixelLayer.height = grid.height;
    layerContext = pixelLayer.getContext('2d');
    layerContext.globalAlpha = 92 / 255;
    rebuildOverlay();
    canvas.width = grid.width;
    canvas.height = grid.height;
    surface.scrollTo(0, 0);
    player = null;
    hover = null;
    cursor.textContent = '';
    sizeCanvas();
    draw();
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * canvas.width / rect.width,
      (event.clientY - rect.top) * canvas.height / rect.height];
  }

  function applyStroke(from, to) {
    const id = sceneSelect.value, grid = grids[id];
    const cells = data.get(id) ?? new Map();
    data.set(id, cells);
    const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), 1);
    const value = tool === 'block' ? 0 : tool === 'clear' ? 1 : undefined;
    const columns = grid.width / grid.cell;
    for (let i = 0; i <= steps; i += 1) {
      const x = Math.round(from[0] + (to[0] - from[0]) * i / steps);
      const y = Math.round(from[1] + (to[1] - from[1]) * i / steps);
      const [left, top, right, bottom] = brushBounds(grid, id, [x, y]);
      for (let row = top; row < bottom; row += 1) {
        for (let col = left; col < right; col += 1) {
          const index = row * columns + col;
          const previous = cells.get(index);
          if (previous === value || (value === 1 && scene.assetPixels?.[index] === 0)) continue;
          if (!stroke.before.has(index)) stroke.before.set(index, previous);
          if (value === undefined) cells.delete(index);
          else cells.set(index, value);
          updateOverlay(index, value);
        }
      }
    }
    revision += 1;
  }

  function pushHistory(entry) {
    past.push(entry);
    if (past.length > 40) past.shift();
    future.length = 0;
    save();
  }

  function finishStroke() {
    if (!stroke) return;
    const completed = stroke;
    stroke = null;
    if (completed.before.size) pushHistory({ id: completed.sceneId, edits: completed.before });
  }

  canvas.addEventListener('pointerdown', event => {
    if (!scene || stroke || pan || event.button !== 0) return;
    if (tool === 'pan') {
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: surface.scrollLeft, top: surface.scrollTop };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const p = point(event), grid = grids[sceneSelect.value];
    const index = collisionIndex(grid, ...p);
    if (index < 0) return;
    canvas.focus({ preventScroll: true });
    if (tool === 'test') {
      const result = move(sceneSelect.value, cellMap(sceneSelect.value), p, 0, 0, true);
      if (result) player = { x: result[0], y: result[1] };
      cursor.textContent = result ? '用 WASD 或方向键试走' : '起点挡路，请点可走区域';
      draw();
      return;
    }
    const tile = p.map(v => Math.floor(v / grid.cell));
    stroke = { id: event.pointerId, sceneId: sceneSelect.value, last: tile, before: new Map() };
    canvas.setPointerCapture(event.pointerId);
    applyStroke(tile, tile);
    draw();
  });

  canvas.addEventListener('pointermove', event => {
    if (!scene) return;
    if (pan?.id === event.pointerId) {
      surface.scrollTo(pan.left + pan.x - event.clientX, pan.top + pan.y - event.clientY);
      return;
    }
    const grid = grids[sceneSelect.value];
    const p = point(event), index = collisionIndex(grid, ...p);
    hover = index < 0 ? null : p.map(v => Math.floor(v / grid.cell));
    if (stroke?.id === event.pointerId && hover) {
      applyStroke(stroke.last ?? hover, hover);
      stroke.last = hover;
    } else if (stroke?.id === event.pointerId) stroke.last = null;
    if (hover && tool !== 'test' && tool !== 'pan') {
      const edit = cellMap(sceneSelect.value).get(index);
      const base = scene.pixelWalk?.[index];
      const label = scene.assetPixels?.[index] === 0 ? '素材阻挡'
        : edit === 0 ? '手绘阻挡' : edit === 1 ? '手绘通行' : base === 0 ? '原始阻挡' : '可通行';
      cursor.textContent = hover.join(', ') + ' · ' + label;
    }
    draw();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(event, e => {
      if (stroke?.id === e.pointerId) finishStroke();
      if (pan?.id === e.pointerId) pan = null;
    });
  }
  canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
  canvas.addEventListener('blur', () => keys.clear());
  surface.addEventListener('wheel', event => {
    if (!event.deltaY || stroke || pan) return;
    event.preventDefault();
    if (event.shiftKey) surface.scrollLeft += event.deltaY;
    else changeZoom(event.deltaY < 0 ? 1 : -1, event);
  }, { passive: false });

  const directions = { w: 'up', a: 'left', s: 'down', d: 'right', arrowup: 'up',
    arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };
  canvas.addEventListener('keydown', event => {
    const direction = directions[event.key.toLowerCase()];
    if (tool !== 'test' || !player || !direction) return;
    event.preventDefault();
    keys.add(direction);
    if (!frame) { lastTime = 0; frame = requestAnimationFrame(testFrame); }
  });
  window.addEventListener('keyup', event => keys.delete(directions[event.key.toLowerCase()]));
  window.addEventListener('blur', () => keys.clear());

  function testFrame(now) {
    frame = 0;
    if (!dialog.open || tool !== 'test' || !player || !keys.size) return;
    const speed = Math.min(0.05, lastTime ? (now - lastTime) / 1000 : 0) * 48;
    lastTime = now;
    const dx = Number(keys.has('right')) - Number(keys.has('left'));
    const dy = Number(keys.has('down')) - Number(keys.has('up'));
    const norm = Math.hypot(dx, dy) || 1;
    const p = move(sceneSelect.value, cellMap(sceneSelect.value), [player.x, player.y], dx * speed / norm, dy * speed / norm);
    if (p) [player.x, player.y] = p;
    draw();
    frame = requestAnimationFrame(testFrame);
  }

  function replay(from, to) {
    finishStroke();
    if (!from.length) return;
    const entry = from.pop();
    if (entry.scenes) {
      to.push({ scenes: data });
      data = entry.scenes;
      rebuildOverlay();
    } else {
      const cells = data.get(entry.id) ?? new Map(), inverse = new Map();
      data.set(entry.id, cells);
      for (const [index, value] of entry.edits) {
        inverse.set(index, cells.get(index));
        if (value === undefined) cells.delete(index);
        else cells.set(index, value);
        if (entry.id === sceneSelect.value) updateOverlay(index, value);
      }
      to.push({ id: entry.id, edits: inverse });
    }
    save();
  }

  for (const [id, label] of Object.entries(labels)) sceneSelect.add(new Option(label, id));
  sceneSelect.onchange = () => { finishStroke(); selectScene(); };
  dialog.querySelectorAll('[data-collision-tool]').forEach(button => {
    button.onclick = () => {
      finishStroke();
      tool = button.dataset.collisionTool;
      canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
      keys.clear();
      if (tool !== 'test') player = null;
      dialog.querySelectorAll('[data-collision-tool]').forEach(item => {
        item.setAttribute('aria-pressed', String(item === button));
      });
      cursor.textContent = tool === 'test' ? '点可走区域设置起点' : '';
      draw();
    };
  });
  undo.onclick = () => replay(past, future);
  redo.onclick = () => replay(future, past);
  clearPass.onclick = () => {
    finishStroke();
    const id = sceneSelect.value, cells = cellMap(id), edits = new Map();
    for (const [index, value] of cells) {
      if (value !== 1) continue;
      edits.set(index, value);
      cells.delete(index);
    }
    if (!edits.size) { cursor.textContent = '当前场景没有通行覆盖'; return; }
    rebuildOverlay();
    pushHistory({ id, edits });
    cursor.textContent = '已清除 ' + edits.size + ' 个通行像素，可撤销';
  };
  overlay.onchange = draw;
  brush.oninput = draw;
  brush.onchange = () => { brush.value = brushSize(); draw(); };
  function setZoom(next, anchor) {
    if (next === zoom) return;
    const rect = canvas.getBoundingClientRect();
    const viewport = surface.getBoundingClientRect();
    const x = anchor?.clientX ?? viewport.left + viewport.width / 2;
    const y = anchor?.clientY ?? viewport.top + viewport.height / 2;
    const fraction = (point, start, size) => Math.max(0, Math.min(1, (point - start) / size));
    const u = fraction(x, rect.left, rect.width);
    const v = fraction(y, rect.top, rect.height);
    zoom = next;
    zoomSelect.value = String(zoom);
    zoomOut.disabled = zoom === ZOOM_LEVELS[0];
    zoomIn.disabled = zoom === ZOOM_LEVELS.at(-1);
    sizeCanvas();
    const resized = canvas.getBoundingClientRect();
    surface.scrollBy(resized.left + u * resized.width - x, resized.top + v * resized.height - y);
  }

  function changeZoom(direction, anchor) {
    const next = ZOOM_LEVELS[ZOOM_LEVELS.indexOf(zoom) + direction];
    if (next) setZoom(next, anchor);
  }

  zoomSelect.onchange = () => setZoom(Number(zoomSelect.value));
  zoomOut.onclick = () => changeZoom(-1);
  zoomIn.onclick = () => changeZoom(1);
  find('collisionExport').onclick = () => {
    finishStroke();
    const link = document.createElement('a');
    link.download = 'collision-overrides.json';
    link.href = URL.createObjectURL(new Blob([writeCollisionData(data,grids)], { type: 'application/json' }));
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  find('collisionImport').onchange = async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 64_000_000) throw new Error('碰撞文件太大');
      const next = readCollisionData(await file.text(), grids);
      if (!dialog.open || !confirm('用导入文件替换当前所有场景的手绘碰撞？替换后可以撤销。')) return;
      finishStroke();
      const before = data;
      data = next;
      player = null;
      rebuildOverlay();
      pushHistory({ scenes: before });
    } catch (error) {
      cursor.textContent = error.message;
    }
  };
  find('collisionClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { finishStroke(); keys.clear(); pan = null; });
  new ResizeObserver(sizeCanvas).observe(surface);

  return {
    cells: cellMap,
    get revision() { return revision; },
    open() {
      dialog.showModal();
      selectScene();
    },
  };
}
