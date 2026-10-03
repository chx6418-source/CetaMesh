import { CetaError } from '../../shared/errors/CetaError';
export class SseDecoder {
  private buffer = '';
  push(text: string): string[] {
    this.buffer += text;
    if (this.buffer.length > 1024 * 1024) {
      throw new CetaError('invalid_protocol', 'Stream frame too large');
    }
    const frames: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) {
        frames.push(data);
      }
    }
    return frames;
  }
}
