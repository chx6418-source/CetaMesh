// CetaMesh Desktop —— 安装包下载（分发运行时 v1）。
//
// 只做「下载 + SHA256 校验 + 原子落盘」：**从不执行**任何下载物；
// 安装仍由用户手动确认（checker 返回的 handoff 语义不变）。这样阶段 12 的
// 「不静默执行未知安装程序」红线保持成立，同时补上「下载完成必须验证」。
//
// 安全约束：
//   - 仅 https；每一跳重定向都要重新过 https + 主机白名单（默认取设置里的 allowedUpdateHosts）；
//   - 有界响应：体积上限（默认 512 MiB）+ 全下载超时（默认 5 分钟）+ 最多 5 跳重定向；
//   - **必须**提供期望 sha256（64 位十六进制）；落盘后重读校验，不匹配即失败并清理；
//   - 原子落盘：先写同目录 .part-<random> 临时文件，校验通过后 rename 到目标名；
//     任何失败（超时 / 超限 / 校验失败 / 写盘失败）都删除临时文件，不留残余；
//   - 目标已存在 → 拒绝覆盖（TARGET_EXISTS），不静默替换用户已有文件；
//   - 全部失败以结构化结果返回（{ ok:false, code, message }），绝不抛出。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { hostAllowedForDownload } from './manifest.js';

export const DOWNLOAD_MAX_BYTES_DEFAULT = 512 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS_DEFAULT = 5 * 60 * 1000;
export const DOWNLOAD_MAX_REDIRECTS_DEFAULT = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SHA256_RE = /^[a-f0-9]{64}$/i;

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value === undefined || value === null ? null : value;
  }
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === lower) return headers[key];
  }
  return null;
}

function classifyTransportError(error) {
  const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
  return aborted ? 'TIMEOUT' : 'NETWORK_ERROR';
}

export function createArtifactDownloader({
  fetchImpl = null,
  fsImpl = fs,
  allowedHosts = [],
  maxBytes = DOWNLOAD_MAX_BYTES_DEFAULT,
  timeoutMs = DOWNLOAD_TIMEOUT_MS_DEFAULT,
  maxRedirects = DOWNLOAD_MAX_REDIRECTS_DEFAULT,
  randomSuffix = () => crypto.randomBytes(8).toString('hex')
} = {}) {
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  async function download({
    url,
    sha256,
    bytes = null,
    targetPath,
    allowedHosts: hostsOverride,
    maxBytes: limitOverride,
    timeoutMs: deadlineOverride
  } = {}) {
    if (!targetPath || typeof targetPath !== 'string') {
      return fail('TARGET_REQUIRED', '必须提供下载目标路径');
    }
    const expectedSha = String(sha256 || '').trim().toLowerCase();
    if (!SHA256_RE.test(expectedSha)) {
      return fail('SHA256_REQUIRED', '必须提供期望的 sha256（64 位十六进制）——不校验不下载');
    }
    if (!doFetch) return fail('NO_FETCH', '当前运行时不支持网络请求');

    const hosts = Array.isArray(hostsOverride) ? hostsOverride : allowedHosts;
    const limit = Number.isFinite(limitOverride) && limitOverride > 0 ? limitOverride : maxBytes;
    const budget = Number.isFinite(deadlineOverride) && deadlineOverride > 0 ? deadlineOverride : timeoutMs;

    let currentUrl = String(url || '');
    let redirects = 0;
    let response = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, budget));
    try {
      // ── 逐跳校验并抓取（重定向最多 maxRedirects 跳，每跳都重新过 https + 主机白名单）──
      while (true) {
        let parsed;
        try {
          parsed = new URL(currentUrl);
        } catch {
          return fail('INSECURE_URL', '下载地址非法：' + currentUrl.slice(0, 120));
        }
        if (parsed.protocol !== 'https:') {
          return fail(redirects ? 'REDIRECT_INSECURE' : 'INSECURE_URL', '下载必须走 https：' + currentUrl.slice(0, 120));
        }
        if (!hostAllowedForDownload(currentUrl, hosts)) {
          return fail(redirects ? 'REDIRECT_HOST_NOT_ALLOWED' : 'HOST_NOT_ALLOWED', '下载主机不在允许列表内：' + parsed.hostname);
        }
        const hop = await doFetch(currentUrl, { method: 'GET', signal: controller.signal, redirect: 'manual' }).catch((error) => ({ __error: error }));
        if (hop && hop.__error) {
          return fail(classifyTransportError(hop.__error), '下载失败：' + ((hop.__error && hop.__error.message) || String(hop.__error)));
        }
        if (!hop) return fail('NETWORK_ERROR', '下载无响应');
        if (REDIRECT_STATUSES.has(hop.status)) {
          redirects += 1;
          if (redirects > maxRedirects) return fail('TOO_MANY_REDIRECTS', '重定向超过上限 ' + maxRedirects);
          const location = headerValue(hop.headers, 'location');
          if (!location) return fail('REDIRECT_INVALID', '重定向缺少 location');
          try {
            currentUrl = new URL(String(location), currentUrl).toString();
          } catch {
            return fail('REDIRECT_INVALID', '重定向 location 非法');
          }
          continue;
        }
        if (hop.status < 200 || hop.status >= 300) return fail('HTTP_ERROR', '下载失败：HTTP ' + hop.status);
        response = hop;
        break;
      }

      const declared = Number(headerValue(response.headers, 'content-length'));
      if (Number.isFinite(declared) && declared > limit) {
        return fail('TOO_LARGE', '安装包体积超过上限（' + declared + ' > ' + limit + '）');
      }

      let targetExists = true;
      try {
        await fsImpl.access(targetPath);
      } catch {
        // ENOENT：目标不存在，可以继续下载；其它访问错误会在写盘环节结构化上报。
        targetExists = false;
      }
      if (targetExists) return fail('TARGET_EXISTS', '目标文件已存在，拒绝覆盖：' + targetPath);

      const tempPath = targetPath + '.part-' + randomSuffix();
      let total = 0;
      let handle = null;
      let writing = false;
      const cleanup = async () => {
        try {
          await fsImpl.unlink(tempPath);
          return true;
        } catch {
          // 清理是尽力而为：临时文件不存在（或删除失败）时不影响主错误返回。
          return false;
        }
      };
      const closeQuietly = async () => {
        if (!handle) return true;
        const pending = handle;
        handle = null;
        try {
          await pending.close();
          return true;
        } catch {
          // 关闭失败：文件随即在 cleanup 中删除，这里不掩盖原始错误。
          return false;
        }
      };
      try {
        try {
          handle = await fsImpl.open(tempPath, 'w');
        } catch (error) {
          return fail('WRITE_FAILED', '无法创建临时文件：' + ((error && error.message) || String(error)));
        }
        const body = response.body;
        if (!body) {
          await closeQuietly();
          await cleanup();
          return fail('BODY_MISSING', '下载响应没有响应体');
        }
        for await (const chunk of body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > limit) {
            await closeQuietly();
            await cleanup();
            return fail('TOO_LARGE', '安装包体积超过上限 ' + limit);
          }
          let offset = 0;
          while (offset < buf.length) {
            writing = true;
            const { bytesWritten } = await handle.write(buf, offset, buf.length - offset);
            if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buf.length - offset) {
              throw new Error('磁盘写入未前进');
            }
            offset += bytesWritten;
          }
          writing = false;
        }
        if (!await closeQuietly()) throw new Error('无法关闭下载文件');
      } catch (error) {
        await closeQuietly();
        await cleanup();
        return fail(writing || error?.message === '无法关闭下载文件' ? 'WRITE_FAILED' : classifyTransportError(error), '下载中断：' + ((error && error.message) || String(error)));
      }

      let actual;
      let diskBytes;
      try {
        const reader = await fsImpl.open(tempPath, 'r');
        try {
          const hash = crypto.createHash('sha256');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          diskBytes = 0;
          for (;;) {
            const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
            diskBytes += bytesRead;
          }
          actual = hash.digest('hex');
        } finally {
          await reader.close();
        }
      } catch (error) {
        await cleanup();
        return fail('WRITE_FAILED', '落盘文件无法校验：' + ((error && error.message) || String(error)));
      }
      if (diskBytes !== total) {
        await cleanup();
        return fail('SIZE_MISMATCH', '落盘体积与下载数据不符', { expected: total, actual: diskBytes });
      }
      if (actual !== expectedSha) {
        await cleanup();
        return fail('SHA_MISMATCH', 'sha256 校验不匹配（拒绝安装未验证的下载物）', { expected: expectedSha, actual });
      }
      if (Number.isFinite(bytes) && bytes > 0 && total !== bytes) {
        await cleanup();
        return fail('SIZE_MISMATCH', '体积与清单不符（' + total + ' != ' + bytes + '）', { expected: bytes, actual: total });
      }
      try {
        await fsImpl.rename(tempPath, targetPath);
      } catch (error) {
        await cleanup();
        return fail('WRITE_FAILED', '落盘失败：' + ((error && error.message) || String(error)));
      }
      return { ok: true, path: targetPath, bytes: total, sha256: actual };
    } finally {
      clearTimeout(timer);
    }
  }

  return { download, maxBytes, timeoutMs, maxRedirects };
}
