// CetaMesh 统一配对 v1.1 —— 邀请二维码矩阵（纯数据，渲染交给桌面壳）。
//
// 桌面壳（Rust/egui）不引入新 crate：这里用 qrcode 生成 0/1 矩阵，
// 通过 IPC 把 rows 交给壳自己画方块。'1' = 深色模块。

import QRCode from 'qrcode';

export function invitationQr(text, { errorCorrectionLevel = 'M' } = {}) {
  if (typeof text !== 'string' || !text) throw new Error('invitationQr 需要非空文本');
  const qr = QRCode.create(text, { errorCorrectionLevel });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    let row = '';
    for (let x = 0; x < size; x += 1) row += data[y * size + x] ? '1' : '0';
    rows.push(row);
  }
  return { size, rows };
}
