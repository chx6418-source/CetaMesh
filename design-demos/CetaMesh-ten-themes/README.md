# CetaMesh 十款控制台主题

此压缩包包含十款控制台主题及切换动画相关文件。

## 文件
- public/console.html：控制台页面、十款主题配色和主题选择器/过渡动画
- public/token-login.html：登录页主题衔接配色
- scripts/test-console-themes.mjs：主题切换和配色检查
- whalebridge-ten-themes.patch：相对仓库原始版本的补丁

## 应用方式
将 public 和 scripts 目录覆盖/合并到项目根目录即可；或在原始仓库版本上运行：

```bash
git apply whalebridge-ten-themes.patch
node scripts/test-console-themes.mjs
```

主题包括：苏打、深海、护眼、纸墨、松林、樱白、暖砂、冰川、暮灰、星紫。切换时使用浏览器 View Transitions API，并尊重减少动态效果设置。
