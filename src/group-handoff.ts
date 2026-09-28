export const MAX_GROUP_HANDOFFS = 6;

export interface GroupHandoffCandidate {
  id: string;
  name: string;
  aliases?: readonly string[];
}

export type GroupHandoffInvalidReason = 'unknown_target' | 'ambiguous_target' | 'multiple_targets' | 'self_target' | 'empty_instruction';

export type GroupHandoffResult =
  | { kind: 'none' }
  | { kind: 'handoff'; targetBotId: string; instruction: string; line: string; lineNumber: number }
  | { kind: 'invalid'; reason: GroupHandoffInvalidReason; message: string; line: string; lineNumber: number };

const errorMessages: Record<GroupHandoffInvalidReason, string> = {
  unknown_target: '没有找到这个群里可接收交接的机器人，请使用已配置的完整角色名。',
  ambiguous_target: '有多个机器人使用这个名称，无法确认交接对象，请使用唯一名称。',
  multiple_targets: '一次只能交接给一个机器人，请明确一个接收者。',
  self_target: '不能把任务交接给自己，请选择另一个机器人。',
  empty_instruction: '交接需要说明具体任务。',
};

function candidateNames(candidate: GroupHandoffCandidate): string[] {
  return [...new Set([candidate.id, candidate.name, ...(candidate.aliases ?? [])].map(name => name.trim()).filter(Boolean))];
}

function isExampleIntroduction(line: string): boolean {
  // A final instruction shown immediately after an example heading is documentation, not an action.
  return /(?:示例|举例|例如|样例|范例|格式|模板|写法|可以这样写|可以写成|比如|example|e\.g\.)[^。！？!?]*[：:]\s*$/iu.test(line)
    || /^(?:#{1,6}\s*)?(?:示例|举例|例如|样例|范例|格式|模板|写法|可以这样写|可以写成|比如|example|e\.g\.)\s*$/iu.test(line)
    || /^(?:如下|像这样|如)\s*[：:]\s*$/u.test(line);
}

function finalLineIsProtected(lines: string[], targetIndex: number): boolean {
  let fence: { character: string; length: number } | undefined;
  let htmlComment = false;
  for (let index = 0; index <= targetIndex; index++) {
    const line = lines[index]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (index === targetIndex) return true;
      if (fenceMatch && fenceMatch[1]![0] === fence.character && fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      if (index === targetIndex) return true;
      fence = { character: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    if (line.includes('<!--')) htmlComment = true;
    if (index === targetIndex && (htmlComment || /^(?: {4}|\t|\s*>)/u.test(line))) return true;
    if (line.includes('-->')) htmlComment = false;
  }
  for (let index = targetIndex - 1; index >= 0; index--) {
    const previous = lines[index]!.trim();
    if (!previous) continue;
    return isExampleIntroduction(previous);
  }
  return false;
}

function isNonAction(instruction: string): boolean {
  return /[?？]/u.test(instruction)
    || /^(?:请)?(?:不要|勿|无需|不用|别)(?:再)?(?:回复|执行|处理|开始|接手|接力|交接|工作|回答|行动|继续|运行)/u.test(instruction);
}

function containsAnotherTarget(instruction: string, candidates: readonly GroupHandoffCandidate[]): boolean {
  return candidates.some(candidate => candidateNames(candidate).some(name => {
    const token = `@${name}`;
    let offset = instruction.indexOf(token);
    while (offset >= 0) {
      const before = offset === 0 ? '' : instruction[offset - 1]!;
      const after = instruction[offset + token.length] ?? '';
      if ((!before || /[\s，,。；;：:、（(]/u.test(before)) && (!after || /[\s，,。；;：:、）)!！?？]/u.test(after))) return true;
      offset = instruction.indexOf(token, offset + token.length);
    }
    return false;
  }));
}

function parseHandoffLine(lines: string[], index: number, candidates: readonly GroupHandoffCandidate[], selfBotId: string): GroupHandoffResult {
  const line = lines[index]!.trim();
  const strict = /^交接给\s+@([^：:\r\n]+)[：:]\s*(.*)$/u.exec(line);
  const legacy = strict ? null : /^@(.+?)\s+(轮到你了[。！!]?|(?:请|接着|继续)(?:\s*.*))$/u.exec(line);
  const match = strict ?? legacy;
  if (!match || finalLineIsProtected(lines, index)) return { kind: 'none' };
  const name = match[1]!.trim();
  const instruction = match[2]!.trim();
  // Markdown links, inline code, quoted names and escaped mentions are not routing syntax.
  if (/[`<>\[\]\\“”「」『』"']/u.test(name) || isNonAction(instruction)) return { kind: 'none' };
  const invalid = (reason: GroupHandoffInvalidReason): GroupHandoffResult => ({ kind: 'invalid', reason, message: errorMessages[reason], line, lineNumber: index + 1 });
  if (name.includes('@') || /[、,，;；]/u.test(name) || containsAnotherTarget(instruction, candidates)) return invalid('multiple_targets');
  const matches = [...new Set(candidates.filter(candidate => candidateNames(candidate).includes(name)).map(candidate => candidate.id))];
  if (matches.length === 0) return invalid('unknown_target');
  if (matches.length > 1) return invalid('ambiguous_target');
  if (matches[0] === selfBotId) return invalid('self_target');
  if (!instruction || /^(?:请|接着|继续)[。！!]?$/u.test(instruction)) return invalid('empty_instruction');
  return { kind: 'handoff', targetBotId: matches[0]!, instruction, line, lineNumber: index + 1 };
}

/** Only an explicit final handoff line can initiate a relay; ordinary mentions never do. */
export function parseGroupHandoff(text: string, candidates: readonly GroupHandoffCandidate[], selfBotId: string): GroupHandoffResult {
  const lines = text.split(/\r?\n/u);
  let finalIndex = lines.length - 1;
  while (finalIndex >= 0 && !lines[finalIndex]!.trim()) finalIndex--;
  if (finalIndex < 0) return { kind: 'none' };
  const final = parseHandoffLine(lines, finalIndex, candidates, selfBotId);
  if (final.kind !== 'handoff') return final;
  for (let index = 0; index < finalIndex; index++) {
    const previous = parseHandoffLine(lines, index, candidates, selfBotId);
    if (previous.kind === 'invalid') return previous;
    if (previous.kind === 'handoff' && previous.targetBotId !== final.targetBotId) {
      return { kind: 'invalid', reason: 'multiple_targets', message: errorMessages.multiple_targets, line: final.line, lineNumber: final.lineNumber };
    }
  }
  // Repeated wording and aliases for the same bot produce one handoff, using the final task.
  return final;
}

export function canContinueGroupHandoff(completedHandoffs: number): boolean {
  return Number.isSafeInteger(completedHandoffs) && completedHandoffs >= 0 && completedHandoffs < MAX_GROUP_HANDOFFS;
}

export function buildGroupHandoffGuidance(candidates: readonly GroupHandoffCandidate[], selfBotId: string): string {
  const names = [...new Set(candidates.filter(candidate => candidate.id !== selfBotId).map(candidate => candidate.name.trim()).filter(Boolean))];
  if (!names.length) return '';
  return `可交接角色：${JSON.stringify(names)}`;
}
