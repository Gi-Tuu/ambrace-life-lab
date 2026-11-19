// 兼容层：纯数据/几何已移到 shared/camp-scene.mjs；浏览器侧保持原导入路径。
// 服务端（life/*、host.mjs、serve.mjs）只 import shared，不再把本模块拖进闭包。
export * from '../shared/camp-scene.mjs';

