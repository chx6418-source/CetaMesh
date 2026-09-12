// 命令行实时状态面板：在终端底部固定一小块状态区，随事件实时刷新；
// 日志从面板上方滚动输出（先擦除面板 → 打印日志 → 重画面板）。
// 仅在交互式终端（TTY）下启用；stdout 被重定向到文件时自动退化为普通日志。
// 依赖 Windows 10+/现代终端的 ANSI VT 序列（Node 在 TTY 上默认启用）。
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** 按终端显示宽度截断（CJK/全角算 2 列），防止折行破坏光标回退计算。 */
function clipLine(text, maxWidth) {
  let width = 0;
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const cw = (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd))) ? 2 : 1;
    if (width + cw > maxWidth - 1) return out + '…';
    width += cw;
    out += ch;
  }
  return out;
}

export function createStatusPanel() {
  const enabled = Boolean(process.stdout.isTTY) && process.env.NO_STATUS_PANEL !== '1';
  let started = false;
  let renderedLines = 0;
  let currentLines = [];
  let gather = null;
  let timer = null;

  const termWidth = () => Number(process.stdout.columns) || 100;

  function erase() {
    if (!enabled || renderedLines === 0) return;
    // 光标回到面板首行并清屏到底，面板即被完整擦除
    process.stdout.write(`\x1b[${renderedLines}A\r\x1b[J`);
    renderedLines = 0;
  }

  function render(lines) {
    currentLines = lines;
    let out = '';
    for (const line of lines) {
      const isRule = typeof line === 'object' && line?.rule;
      const text = isRule ? line.text : String(line);
      const styled = isRule ? `${DIM}${text}${RESET}` : text;
      out += `\x1b[2K${clipLine(styled, termWidth())}\n`;
      renderedLines += 1;
    }
    process.stdout.write(out);
  }

  /** 日志行从面板上方插入：擦除 → 打印 → 重画。未启动/未启用时退化为 console.log。 */
  function logAbove(line) {
    if (!enabled || !started) {
      console.log(line);
      return;
    }
    erase();
    process.stdout.write(`${clipLine(line, termWidth())}\n`);
    render(gather ? gather() : currentLines);
  }

  function renderOnce() {
    if (!enabled || !started) return;
    erase();
    try {
      render(gather() ?? currentLines);
    } catch {
      render(currentLines);
    }
  }

  /** 启动面板。gather() 返回要展示的行数组（对象 {rule:true,text} 表示灰色分隔线）。 */
  function start(gatherFn, intervalMs = 1000) {
    if (!enabled || started) return;
    gather = gatherFn;
    started = true;
    process.stdout.on('resize', renderOnce);
    renderOnce();
    timer = setInterval(renderOnce, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!started) return;
    if (timer) clearInterval(timer);
    erase();
    started = false;
  }

  // 进程退出（Ctrl+C / 崩溃）时擦掉面板，让终端停在干净位置
  process.on('exit', () => {
    if (started) erase();
  });

  return { enabled, start, stop, logAbove, renderOnce };
}
