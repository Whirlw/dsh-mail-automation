/**
 * 二维码渲染（QQ 扫码绑定用）。
 *
 * 为什么用 `qrcode-generator`：纯 JS、零依赖、MIT，`createSvgTag()` 直接给 SVG；
 * 我们只把它转成 `data:image/svg+xml;base64,…`，前端用 `<img>` 显示 ——
 * 不往 DOM 里插 HTML，也就不需要 `dangerouslySetInnerHTML`。
 *
 * 注意：二维码内容（QQ 绑定 URL）本身就带着一次性 task_id，属于短期凭据；
 * 只放在设置页响应里，不写日志、不落盘。
 */
import qrcode from 'qrcode-generator';

/**
 * 文本 → SVG 字符串。内容过长/非法时抛错（由调用方转成"无法生成二维码"提示）。
 *
 * `margin` 的单位是**像素**（qrcode-generator 的 `createSvgTag` 语义），不是模块数。
 * 默认 4 个模块的静区（=4×cellSize）：QR 规范要求至少 4 模块，低于这个值在深色背景/
 * 小尺寸下扫码率明显下降。
 */
export function qrSvg(text, { cellSize = 5, margin } = {}) {
  const value = String(text ?? '');
  if (!value) throw new Error('二维码内容为空');
  const size = Math.max(1, Number(cellSize) || 5);
  const quiet = Math.max(0, Number(margin ?? size * 4));
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: size, margin: quiet, scalable: true });
}

/** 文本 → `data:image/svg+xml;base64,…`（直接给 `<img src>`） */
export function qrDataUrl(text, options) {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options), 'utf8').toString('base64')}`;
}
