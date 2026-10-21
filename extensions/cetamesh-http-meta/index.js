// HTTP Meta Reader —— 阶段 10 的"需要明确权限"示例扩展。
//
// 它声明了三项权限：log（低）、storage（低）、network（高）。
// 因此安装前必须经过 Permission Review 并由用户显式批准 —— 没有批准凭据装不上。
//
// 运行期约束：
//   - ctx.fetch 只存在于此扩展被授予 network 时才注入；
//   - 即便注入了，也只允许访问 manifest.network.hosts 里声明的主机；
//   - 越界主机直接抛 HOST_NOT_ALLOWED，不会发起请求。

module.exports.handlers = {
  'meta.fetch-title': async (input, ctx) => {
    const url = input && typeof input.url === 'string' ? input.url : '';
    if (!url) throw new Error('url 不能为空');
    const response = await ctx.fetch(url, { method: 'GET' });
    const body = response && typeof response.body === 'string' ? response.body : '';
    const match = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
    const title = match ? String(match[1]).trim() : '';
    ctx.storage.set('lastTitle', title);
    ctx.log('fetched title', title);
    return { title, bytes: body.length, status: response ? response.status : null };
  },

  'meta.last-title': (input, ctx) => ({ title: ctx.storage.get('lastTitle') })
};
