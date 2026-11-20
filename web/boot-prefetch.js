// 首屏关键数据预取（classic script，放在 <head> 最前）。
// 为什么不用模块：app.js 的静态 import 图要先下载/解析完才执行，等到那里再 fetch /world
// 已经晚了几十毫秒。这个 400 字节的小脚本在 HTML 解析到 head 时就发起 GET /world，
// 模块加载与 JSON 传输重叠；net.mjs 的 postJson 会优先消费这条 promise（失败则正常回退）。
// 只预取首屏一定会请求的那一个 mode；camp 追加规则与 web/net.mjs 保持一致。
(function () {
  try {
    var params = new URLSearchParams(location.search);
    var mode = params.get('mode') === 'survival' ? 'survival' : params.get('mode') === 'compare' ? 'compare' : 'menu';
    var key = params.get('camp');
    if (!/^[0-9a-f]{32}$/.test(key || '')) {
      try { key = localStorage.getItem('ambrace.camp.v1'); } catch (e) { key = null; }
    }
    var path = '/world?mode=' + mode + (key ? '&camp=' + encodeURIComponent(key) : '');
    window.__lifeWorldPrefetch = {
      path: path,
      used: false,
      promise: fetch(path, { headers: { accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; }),
    };
  } catch (e) { /* 预取失败不影响正常加载 */ }
})();
