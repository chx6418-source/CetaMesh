// Only a direct, terminal imperative in the Owner's message selects an executor.
// Quoted/reference text and mere mentions never create execution authority.
export function explicitDelegationTarget(text) {
  if (typeof text !== 'string' || /[“”‘’\x22\x60]/u.test(text)) return null;
  return /(?:^|[，,。；;\n])\s*(?:请)?交给\s*codex(?:\s*执行)?[。.!！]?\s*$/iu.test(text) ? 'codex' : null;
}

// A direct collaboration request needs a Core Task even in ordinary Chat. This
// recognizes the request only: it selects no external provider, budget or grants.
function collaborationCommand(text) {
  if (typeof text !== 'string') return null;
  const command = text
    .replace(/```[\s\S]*?(?:```|$)/gu, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/gu, ' ')
    .replace(/^\s*>.*$/gmu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/gu, ' ');
  // Refusals and reference framing cover the whole message, including an
  // imperative on a later line or a cancellation following the first clause.
  // They must be applied before looking for an affirmative clause.
  if (/(?:不要|请勿|(?<![分特识告])别(?!的)|不用|无需|不必|禁止|暂不|先不|不需要|不实际|不真正|没有要求|停止|取消|暂停)[^，,。；;\n]{0,24}(?:执行|调用|委派|委托|交给|协作|agents?\b|智能体|指令|安排)/iu.test(command)
    || /(?:agents?\b|智能体)\s*(?:不要|不用|无需|不必|禁止|暂不|先不|别)(?:再|去|进行)?(?:分析|审查|检查|修复|开发|实现|修改|编写)/iu.test(command)
    || /(?:agents?\b|智能体)[^，,。；;\n]{0,40}(?:是什么|什么意思|有什么(?:优势|好处|风险|区别))/iu.test(command)
    || /(?:算了|不用了)|(?:^|[，,。；;\n])\s*(?:取消|停止|暂停)[吧。.!！]?\s*$/u.test(command)
    || /(?:下面|以下|上面|上述)[^，,。；;\n]{0,16}(?:日志|原文|引用|示例|例子|指令|需求)|(?:这段|这句|这个|这些)[^，,。；;\n]{0,16}(?:日志|原文|引用|示例|例子|指令)[^，,。；;\n]{0,12}[:：]|(?:日志原文|引用内容|示例文本|参考文本|原话|别人说|同事说|他说|她说|有人说)/u.test(command)) return null;
  if (/[“”‘’「」『』"'`]/u.test(command)
    || /^\s*(?:(?:请|帮我|麻烦你?)\s*)?(?:翻译|解释|总结|复述|转述|朗读|评价|点评|引用|讨论|介绍|讲解|(?:只想|仅想|我想)(?:了解|知道)|同事说|他说|她说|有人说)/u.test(command)) return null;
  return command;
}

// Generic Smart project keywords must not revive an excluded collaboration
// instruction found inside a reference or under an explicit execution refusal.
export function collaborationIntentExcluded(text) {
  return typeof text === 'string' && /agents?\b|智能体/iu.test(text) && !collaborationCommand(text)?.trim();
}

export function explicitCollaborationIntent(text) {
  const command = collaborationCommand(text);
  if (!command) return false;
  return command.split(/[，,。；;\n]/u).some(clause => {
    const match = /^\s*(?:(?:请你?|帮我|麻烦你?|我想|我希望|希望|现在|然后|接着|再|先)\s*)*(?:交给|委派给|委托|安排|让|请|用|使用|调用|组织)\s*(?:(?:其它|其他|别的|另外(?:一|几)?个|另一个|多个|多|几个)\s*(?:agents?\b|智能体))([\s\S]*)$/iu.exec(clause);
    if (!match) return false;
    const work = match[1];
    if (/(?:不要|不用|无需|不必|禁止|暂不|先不|不需要|停止|(?<![分特识告])别(?:再|去|进行|分析|审查|检查|修复|开发|实现|修改|编写))/u.test(work)
      || /^\s*(?:分析|协作分析)\s*(?:是什么|什么意思|有什么(?:优势|好处|风险|区别))/u.test(work)) return false;
    return /^[\s\S]{0,40}(?:分析|审查|检查|核实|核对|评估|梳理|调查|审计|阅读|修复|开发|实现|修改代码|编写(?:测试|代码))/u.test(work);
  });
}
