// Hello Tool —— 阶段 10 的最小示例扩展。
//
// 这个文件运行在 host.js 提供的受限上下文里：
//   - 没有 require / process / fs / child_process；
//   - eval 与 new Function 在该上下文中被禁用；
//   - 只被授予了 log 权限，因此连 storage / fetch 都不存在。
//
// 约定：扩展通过 module.exports.handlers 暴露"能力 id -> 处理函数"。

module.exports.handlers = {
  'hello.greet': (input, ctx) => {
    const name = input && typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'world';
    ctx.log('greet called for', name);
    return {
      greeting: 'Hello, ' + name + '!',
      from: ctx.extensionId,
      capability: ctx.capability
    };
  }
};
