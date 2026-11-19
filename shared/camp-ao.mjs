// 纯函数：把“近地竖直面变暗”的 AO 烘进顶点色，供静态网格一次生成、渲染时零成本。
export function bakeVertexAO(mesh, stride = 15, startVertex = 0) {
  for (let v = startVertex; v * stride < mesh.length; v += 1) {
    const i = v * stride;
    const y = mesh[i + 1];
    const ny = mesh[i + 12];
    if (!Number.isFinite(y) || !Number.isFinite(ny)) continue;
    let ao = 1;
    if (Math.abs(ny) < 0.55) {
      // 竖直面：越靠近地面越暗，墙脚/树根/屋檐下有接触感。
      ao = 0.80 + 0.20 * Math.max(0, Math.min(1, y / 1.05));
    } else if (ny < -0.45) {
      // 底面（屋檐/楼板下）本来就少环境光。
      ao = 0.82;
    }
    if (ao >= 1) continue;
    mesh[i + 3] *= ao;
    mesh[i + 4] *= ao;
    mesh[i + 5] *= ao;
  }
  return mesh;
}
