// Independent OneBot v11 WebSocket transport. No vendor SDK implementation.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const failure = (code, message) => Object.assign(new Error(message), { code });
export const text = value => ({ type: 'text', data: { text: String(value ?? '') } });

export class OneBotWebSocketClient extends EventEmitter {
  constructor({ url, accessToken, reconnect = true, requestTimeoutMs = 30000,
    maxPendingRequests = 256, reconnectDelayMs = 1000 } = {}) {
    super();
    Object.assign(this, { url, accessToken, reconnect, requestTimeoutMs, maxPendingRequests, reconnectDelayMs });
    this.pending = new Map();
    this.stopped = false;
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.stopped = false;
    clearTimeout(this.retryTimer);
    const promise = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url, { headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
          handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024, followRedirects: false });
      } catch (error) { reject(error); return; }
      this.socket = socket;
      let opened = false;
      socket.on('open', () => {
        opened = true;
        resolve();
        this.emit('open');
      });
      socket.on('message', bytes => {
        if (this.socket !== socket) return;
        let frame;
        try { frame = JSON.parse(bytes.toString()); } catch { return; /* Ignore malformed peer frames. */ }
        if (!frame || typeof frame !== 'object') return;
        const pending = this.pending.get(frame.echo);
        if (pending && Object.hasOwn(frame, 'retcode')) {
          this.pending.delete(frame.echo);
          clearTimeout(pending.timer);
          pending.resolve(frame);
          return;
        }
        if (!frame.post_type) return;
        this.emit('event', frame);
        if (frame.post_type === 'message' && ['private', 'group'].includes(frame.message_type)) {
          this.emit(`${frame.message_type}-message`, frame);
        }
        if (frame.post_type === 'notice') this.emit(`notice:${frame.notice_type}`, frame);
      });
      socket.on('error', error => {
        if (!opened) reject(error);
        if (this.listenerCount('error')) this.emit('error', error);
      });
      socket.on('close', (code, reason) => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!opened) reject(failure('ONEBOT_DISCONNECTED', 'OneBot connection closed before opening'));
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(failure('ONEBOT_DISCONNECTED', 'OneBot connection closed; request was not replayed'));
        }
        this.pending.clear();
        this.emit('close', { code, reason: reason.toString() });
        if (this.reconnect && !this.stopped) {
          this.retryTimer = setTimeout(() => this.connect().catch(() => { /* Connection errors are emitted above. */ }), this.reconnectDelayMs);
          this.retryTimer.unref?.();
        }
      });
    });
    this.connecting = promise;
    promise.then(() => { if (this.connecting === promise) this.connecting = null; },
      () => { if (this.connecting === promise) this.connecting = null; });
    return promise;
  }

  request(action, params = {}) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(failure('ONEBOT_NOT_CONNECTED', 'OneBot is not connected'));
    if (this.pending.size >= this.maxPendingRequests) return Promise.reject(failure('ONEBOT_QUEUE_FULL', 'OneBot request queue is full'));
    return new Promise((resolve, reject) => {
      const echo = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(failure('ONEBOT_TIMEOUT', 'OneBot request timed out; request was not replayed'));
      }, this.requestTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      const discard = error => {
        const entry = this.pending.get(echo);
        if (!entry) return;
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      };
      try { socket.send(JSON.stringify({ action, params, echo }), error => { if (error) discard(error); }); }
      catch (error) { discard(error); }
    });
  }

  async raw(action, params = {}) {
    const response = await this.request(action, params);
    if (response.status !== 'ok' || response.retcode !== 0) {
      throw failure('ONEBOT_API_FAILED', `OneBot action failed (${String(response.retcode)})`);
    }
    return response.data;
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.terminate();
  }
  onPrivateMessage(listener) { return this.on('private-message', listener); }
  onGroupMessage(listener) { return this.on('group-message', listener); }
  onNotice(type, listener) { return this.on(`notice:${type}`, listener); }
  getLoginInfo() { return this.raw('get_login_info'); }
  getStatus() { return this.raw('get_status'); }
  sendPrivateMessage(user_id, message) { return this.raw('send_private_msg', { user_id, message: Array.isArray(message) ? message : [message] }); }
  sendGroupMessage(group_id, message) { return this.raw('send_group_msg', { group_id, message: Array.isArray(message) ? message : [message] }); }
  getGroupMemberInfo(group_id, user_id, no_cache = false) { return this.raw('get_group_member_info', { group_id, user_id, no_cache }); }
  getGroupMemberList(group_id) { return this.raw('get_group_member_list', { group_id }); }
  getMessage(message_id) { return this.raw('get_msg', { message_id }); }
  getImage(file) { return this.raw('get_image', typeof file === 'string' ? { file } : file); }
  fetchFaceEntity(face_id, options = {}) { return this.raw('fetch_face_entity', { face_id, ...(options.refresh === undefined ? {} : { refresh: options.refresh }) }); }
}
