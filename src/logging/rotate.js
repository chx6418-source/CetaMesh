// D12 State Retention —— 运行日志按大小轮转（bridge.log → bridge.log.1）。
//
// 旧的行数裁剪（每次 log() 整读文件再截 2000 行）随日志增长越来越费 IO；
// 这里升级为大小触发：活跃文件超过 maxBytes 就整体挪到 .1（替换上一代），
// 活跃文件重新从空开始。最多保留 maxBytes × 2 的日志量，不引入任何 logging framework。
// tail 读取端（readControlTextTail）本就只读最后 1 MiB，轮转阈值与其对齐时，
// 控制台可读窗口不会因轮转而出现断层。

import fs from 'node:fs';
import { discardFile } from '../storage/json-file.js';

/**
 * 若 file 超过 maxBytes（含即将写入的 pendingBytes）则轮转一次。
 * 返回是否发生了轮转。任何失败都不抛出——日志是尽力而为的旁路，不能反过来阻塞业务。
 */
export function rotateLogFileBySize(file, { maxBytes, pendingBytes = 0 } = {}) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // 日志文件尚不存在（首次运行）是正常状态，无需轮转。
  }
  if (size + pendingBytes <= maxBytes) return false;
  const rotated = `${file}.1`;
  // 上一代 .1 可能被外部查看器占用：删不掉也继续尝试 rename（成功替换即完成轮转）。
  discardFile(rotated);
  try {
    fs.renameSync(file, rotated);
    return true;
  } catch {
    return false; // 轮转失败（Windows 下常见于 .1 被占用）：保留原文件继续追加，下一条日志再尝试。
  }
}
