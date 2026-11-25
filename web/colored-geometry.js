import * as T from 'three';

export function coloredGeometry(geometry, matrix, color) {
  const copy = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  copy.applyMatrix4(matrix);
  copy.deleteAttribute('uv');
  copy.clearGroups();
  const tint = new T.Color(color);
  const colors = new Float32Array(copy.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
  copy.setAttribute('color', new T.BufferAttribute(colors, 3));
  return copy;
}
