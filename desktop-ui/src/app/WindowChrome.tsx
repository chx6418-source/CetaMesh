import { useEffect, useRef, useState } from 'react';
import { hostClient, type WindowAction } from '../bridge/typed-client';

const edges = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'] as const;

// Delay native mouse capture until movement: stationary clicks must still reach
// the WebView's dblclick handler for maximize/restore.
export function createWindowDragGesture() {
  let start: { x: number; y: number; pointerId: number } | null = null;
  return {
    begin(x: number, y: number, pointerId: number) { start = { x, y, pointerId }; },
    end() { start = null; },
    move(x: number, y: number, pointerId: number, buttons: number) {
      if (!start || start.pointerId !== pointerId) return false;
      if ((buttons & 1) === 0) { start = null; return false; }
      if (Math.hypot(x - start.x, y - start.y) < 4) return false;
      start = null;
      return true;
    }
  };
}

export function WindowChrome() {
  const gesture = useRef(createWindowDragGesture());
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');
  async function command(action: WindowAction) {
    try {
      const state = await hostClient.windowAction(action);
      setMaximized(state.maximized);
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '窗口操作失败'); }
  }
  useEffect(() => {
    const update = () => { void command('state'); };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return <>
    <header className="window-chrome" aria-label="窗口标题栏">
      <div className="window-drag-area" onPointerDown={event => {
        if (event.button === 0) gesture.current.begin(event.clientX, event.clientY, event.pointerId);
      }} onPointerMove={event => {
        if (gesture.current.move(event.clientX, event.clientY, event.pointerId, event.buttons)) {
          event.preventDefault(); void command('drag');
        }
      }} onPointerUp={() => gesture.current.end()} onPointerCancel={() => gesture.current.end()}
        onPointerLeave={() => gesture.current.end()} onDoubleClick={() => void command('maximize')}><strong>CetaMesh</strong></div>
      {error && <span className="window-error" role="alert">{error}</span>}
      <div className="window-controls">
        <button aria-label="最小化" onClick={() => void command('minimize')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
        <button aria-label={maximized ? '还原窗口' : '最大化'} onClick={() => void command('maximize')}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5 5V3h8v8h-2M3 5h8v8H3Z" /> : <path d="M3 3h10v10H3Z" />}</svg></button>
        <button className="window-close" aria-label="关闭窗口" onClick={() => void command('close')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" /></svg></button>
      </div>
    </header>
    {!maximized && edges.map(edge => <div key={edge} aria-hidden="true" className={`window-resize edge-${edge}`} onPointerDown={event => {
      if (event.button === 0) { event.preventDefault(); void command(`resize${edge}`); }
    }} />)}
  </>;
}
