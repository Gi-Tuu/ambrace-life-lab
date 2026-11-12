import { atSpot, boxes, movePerson, surfaceHeight, surfaces, trees } from './corridor-3d-world.mjs';

const canvas = document.getElementById('scene');
const status = document.getElementById('status');
const notice = document.getElementById('unsupported');
const gl = canvas.getContext('webgl', { antialias: false, depth: true });
const spots = [...document.querySelectorAll('[data-spot]')];
const moves = [...document.querySelectorAll('[data-move]')];

function unavailable(message) {
  notice.textContent = message;
  notice.hidden = false;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
}

function shader(type, source) {
  const compiled = gl.createShader(type);
  gl.shaderSource(compiled, source);
  gl.compileShader(compiled);
  if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(compiled));
  return compiled;
}

function createProgram() {
  const vertex = shader(gl.VERTEX_SHADER, `
    attribute vec3 aPosition;
    attribute vec3 aColor;
    uniform mat4 uView;
    uniform mat4 uProjection;
    varying vec3 vColor;
    void main() {
      gl_Position = uProjection * uView * vec4(aPosition, 1.0);
      vColor = aColor;
    }`);
  const fragment = shader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec3 vColor;
    void main() { gl_FragColor = vec4(vColor, 1.0); }`);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

const rgb = (hex, shade = 1) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) * shade / 255);
function quad(out, a, b, c, d, color) {
  for (const p of [a, b, c, a, c, d]) out.push(...p, ...color);
}

function prism(out, x0, y0, z0, x1, z1, top, color) {
  const a = [x0, top(x0, z0), z0], b = [x1, top(x1, z0), z0];
  const c = [x1, top(x1, z1), z1], d = [x0, top(x0, z1), z1];
  const A = [x0, y0, z0], B = [x1, y0, z0], C = [x1, y0, z1], D = [x0, y0, z1];
  quad(out, a, b, c, d, rgb(color));
  quad(out, a, b, B, A, rgb(color, .68));
  quad(out, b, c, C, B, rgb(color, .76));
  quad(out, c, d, D, C, rgb(color, .88));
  quad(out, d, a, A, D, rgb(color, .58));
}

const block = (out, x0, y0, z0, x1, y1, z1, color) =>
  prism(out, x0, y0, z0, x1, z1, () => y1, color);

function flat(out, x0, z0, x1, z1, height, color) {
  quad(out, [x0,height(x0,z0),z0], [x1,height(x1,z0),z0], [x1,height(x1,z1),z1], [x0,height(x0,z1),z1], rgb(color));
}

function landscape() {
  const out = [];
  block(out, -11, -1.1, -6.5, 11, -.79, 6.5, '#514134');
  block(out, -11, -.79, -6.5, -2.4, -.02, 6.5, '#976A45');
  block(out, 2.4, -.79, -6.5, 11, -.02, 6.5, '#976A45');
  flat(out, -2.4, -6.5, 2.4, 6.5, () => -.27, '#458996');
  for (let i = 0; i < 24; i += 1) {
    const x = -2.12 + (i * 27 % 37) * .10, z = -6.3 + i * .52;
    flat(out, x, z, Math.min(x + .54, 2.39), z + .06, () => -.264, i % 3 === 0 ? '#A0D2C6' : '#5AA8AD');
  }
  for (const floor of surfaces) {
    const {x0, x1, z0, z1, y, end, color} = floor;
    const height = (x, z) => surfaceHeight(floor, x, z);
    if (color === '#568D3E') flat(out, x0, z0, x1, z1, height, color);
    else {
      prism(out, x0, Math.min(y, end ?? y) - .14, z0, x1, z1, height, color);
      for (let z = z0 + .3; z < z1 - .04; z += .31) {
        flat(out, x0, z, x1, z + .024, (x, pz) => height(x, pz) + .002, '#976A45');
      }
    }
  }
  for (const [x0,z0,x1,z1] of [[-10,-1,-4.5,1],[4.5,-.77,6,1.3],[6.85,3.5,8.15,5.85]]) {
    flat(out,x0,z0,x1,z1,()=>.005,'#D8A667');
  }
  for (let i = 0; i < 128; i += 1) {
    const x = -10.8 + (i * 131 % 211) / 10, z = -6.2 + (i * 67 % 124) / 10;
    if (Math.abs(x) < 2.44 || Math.abs(z) < 1.25 || (x > 4.5 && z > -2.6 && z < 5.9)) continue;
    flat(out,x,z,x+.2,z+.09,()=>.004,i % 3 === 0 ? '#98BD51' : '#3F7036');
  }
  for (const [x,z] of trees) {
    block(out,x-.68,.88,z-.65,x+.67,1.7,z+.65,'#315431');
    block(out,x-.57,1.5,z-.53,x+.54,2.17,z+.52,'#3F7036');
    block(out,x-.36,2.04,z-.31,x+.32,2.44,z+.31,'#568D3E');
  }
  for (const b of boxes) block(out, b.x0,b.y0,b.z0,b.x1,b.y1,b.z1,b.color);
  return new Float32Array(out);
}

function character(p) {
  const out = [];
  const draw = (x0,y0,z0,x1,y1,z1,color) =>
    block(out,p.x+x0,p.y+y0,p.z+z0,p.x+x1,p.y+y1,p.z+z1,color);
  flat(out,p.x-.28,p.z-.20,p.x+.28,p.z+.22,()=>p.y+.009,'#72513B');
  draw(-.23,0,-.15,-.04,.15,.19,'#514134');
  draw(.04,0,-.15,.23,.15,.19,'#514134');
  draw(-.19,.15,-.13,.19,.56,.13,'#324D59');
  draw(-.23,.56,-.16,.23,1.02,.16,'#AB5236');
  draw(-.32,.51,-.13,-.23,.97,.13,'#D58274');
  draw(.23,.51,-.13,.32,.97,.13,'#D58274');
  draw(-.22,.97,-.18,.22,1.37,.18,'#EDC787');
  draw(-.26,1.29,-.22,.26,1.53,.21,'#514134');
  draw(-.19,1.21,.179,-.105,1.27,.193,'#18251E');
  draw(.105,1.21,.179,.19,1.27,.193,'#18251E');
  draw(-.065,.77,.159,.065,.97,.178,'#F6DDA8');
  return new Float32Array(out);
}

const dot = (a,b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const normalize = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
function viewOf(eye, target) {
  const back = normalize(eye.map((n,i)=>n-target[i]));
  const right = normalize(cross([0,1,0],back));
  const up = cross(back,right);
  return [right[0],up[0],back[0],0, right[1],up[1],back[1],0, right[2],up[2],back[2],0,
    -dot(right,eye),-dot(up,eye),-dot(back,eye),1];
}

function start() {
  const program = createProgram(), scenery = landscape();
  const staticBuffer = gl.createBuffer(), actorBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, staticBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, scenery, gl.STATIC_DRAW);
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(...rgb('#263D29'), 1);
  const position = gl.getAttribLocation(program,'aPosition'), color = gl.getAttribLocation(program,'aColor');
  const view = gl.getUniformLocation(program,'uView'), projection = gl.getUniformLocation(program,'uProjection');
  gl.enableVertexAttribArray(position);
  gl.enableVertexAttribArray(color);
  let person = atSpot('back'), preset = 'back', heading = .43, pitch = .50, focusX = 3.1;
  let drag = null, frame = 0, last = 0;
  const keyboard = new Map(), touch = new Map();
  const directions = { w:'up', arrowup:'up', a:'left', arrowleft:'left', s:'down', arrowdown:'down', d:'right', arrowright:'right' };

  function drawBuffer(buffer, length) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.TRIANGLES, 0, length / 6);
  }

  function render() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    const aspect = width / height, halfY = Math.max(5.8, 8.7 / aspect), halfX = halfY * aspect;
    const target = [focusX, .25, 0];
    const eye = [target[0] + 22 * Math.sin(heading)*Math.cos(pitch), target[1] + 22*Math.sin(pitch), 22*Math.cos(heading)*Math.cos(pitch)];
    gl.uniformMatrix4fv(view, false, viewOf(eye, target));
    gl.uniformMatrix4fv(projection, false, [1/halfX,0,0,0, 0,1/halfY,0,0, 0,0,-2/59.9,0, 0,0,-60.1/59.9,1]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawBuffer(staticBuffer, scenery.length);
    const model = character(person);
    gl.bindBuffer(gl.ARRAY_BUFFER, actorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, model, gl.DYNAMIC_DRAW);
    drawBuffer(actorBuffer, model.length);
  }

  function updateStatus(blocked = false) {
    const text = person.floor + ' · 脚下高度 ' + person.y.toFixed(2) + (blocked ? ' · 前方不能通行' : '');
    if (status.textContent !== text) status.textContent = text;
  }

  function selectSpot(id) {
    preset = id;
    person = atSpot(id);
    focusX = id === 'bridge' ? -.9 : 3.1;
    for (const button of spots) button.setAttribute('aria-pressed', String(button.dataset.spot === id));
    updateStatus();
    requestDraw();
  }

  function tick(now) {
    frame = 0;
    const active = new Set([...keyboard.values(), ...touch.values()]);
    if (active.size) {
      const x = Number(active.has('right')) - Number(active.has('left'));
      const z = Number(active.has('down')) - Number(active.has('up'));
      const dt = last ? Math.min(.045, (now - last) / 1000) : 0;
      last = now;
      if (x || z) {
        const step = 3.1 * dt / Math.hypot(x,z);
        updateStatus(movePerson(person,x*step,z*step));
        if (person.x < focusX - 7) focusX = person.x + 7;
        if (person.x > focusX + 7) focusX = person.x - 7;
      }
      requestDraw();
    } else last = 0;
    render();
  }
  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  for (const button of spots) button.onclick = () => selectSpot(button.dataset.spot);
  document.getElementById('reset-camera').onclick = () => {
    heading = .43; pitch = .50; focusX = preset === 'bridge' ? -.9 : 3.1;
    requestDraw();
  };
  for (const button of moves) {
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      button.setPointerCapture(event.pointerId);
      touch.set(event.pointerId,button.dataset.move);
      requestDraw();
    });
    for (const event of ['pointerup','pointercancel','lostpointercapture']) {
      button.addEventListener(event, e => touch.delete(e.pointerId));
    }
    button.onclick = event => {
      if (event.detail !== 0) return;
      const direction = button.dataset.move;
      const step = .24;
      updateStatus(movePerson(person, (Number(direction === 'right') - Number(direction === 'left')) * step,
        (Number(direction === 'down') - Number(direction === 'up')) * step));
      requestDraw();
    };
  }

  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase(), direction = directions[key];
    if (!direction || event.metaKey || event.ctrlKey || event.altKey) return;
    keyboard.set(key,direction);
    event.preventDefault();
    requestDraw();
  });
  window.addEventListener('keyup', event => keyboard.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => { keyboard.clear(); touch.clear(); });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    canvas.setPointerCapture(event.pointerId);
    drag = { id:event.pointerId, x:event.clientX, y:event.clientY };
  });
  canvas.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    heading -= (event.clientX - drag.x) * .009;
    pitch = Math.max(.22, Math.min(1.12, pitch + (event.clientY - drag.y) * .007));
    drag.x = event.clientX; drag.y = event.clientY;
    requestDraw();
  });
  for (const event of ['pointerup','pointercancel','lostpointercapture']) {
    canvas.addEventListener(event, e => { if (drag?.id === e.pointerId) drag = null; });
  }
  canvas.addEventListener('webglcontextlost', () => unavailable('3D 渲染已中断，刷新页面可重新加载。'));
  new ResizeObserver(requestDraw).observe(canvas);
  selectSpot('back');
}

if (!gl) unavailable('此浏览器无法启用 WebGL。请在支持 WebGL 的浏览器中打开这个小样。');
else {
  try { start(); }
  catch (error) { unavailable('3D 画面加载失败：' + error.message); }
}

