// Only explicit first-person preferences or a direct remember request qualify.
// The proposal is pending until the Owner confirms it; no model-generated claim is treated as fact.
export function explicitMemoryCandidate(text) {
  if (typeof text !== 'string') return null;
  const source = text.trim();
  if (source.length < 6 || source.length > 4000) return null;
  if (!/(?:请记住|记住我的|我(?:喜欢|偏好|习惯|希望)|please remember|i (?:prefer|like|always want))/i.test(source)) return null;
  const directRequest = /(?:请记住|记住我的|please remember)/i.test(source);
  if (!directRequest && !/(?:中文|英文|回答|回复|句子|风格|格式|主题|界面|语言|markdown|表格|代码块|简洁|详细|短句|长句|dark mode)/i.test(source)) return null;
  if (/(?:密码|口令|验证码|身份证|银行卡|私钥|密钥|地址|住址|电话|生日|病史|诊断|疾病|宗教|政治立场|性取向|收入|工资|过敏|药物|token|api[_ -]?key|secret|password|\b\d{11}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(source)) return null;
  // Avoid storing an entire conversation or code block as a candidate.
  const content = source.split(/[。.!！\n]/, 1)[0].trim();
  if (content.length < 6 || content.length > 400) return null;
  return { type: 'user', scope: 'user:desktop', content, reason: '用户在聊天中明确表达长期偏好；待 Owner 确认' };
}
