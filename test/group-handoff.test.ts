import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroupHandoffGuidance, canContinueGroupHandoff, MAX_GROUP_HANDOFFS, parseGroupHandoff, resolveGroupHandoffRequest } from '../src/group-handoff.js';
import { validateGroupHandoffRequest } from '../src/group-handoff-request.js';

const candidates = [
  { id: 'product', name: '产品经理', aliases: ['Codex-产品'] },
  { id: 'developer', name: '开发人员', aliases: ['Codex-开发', '开发'] },
  { id: 'qa', name: '测试人员', aliases: ['测试'] },
];

test('guidance exposes stable role IDs only when names need disambiguation', () => {
  assert.doesNotMatch(buildGroupHandoffGuidance(candidates, 'product'), /角色编号/);
  const ambiguous = [candidates[0]!, { id: 'dev-a', name: '开发' }, { id: 'dev-b', name: '开发' }];
  const guidance = buildGroupHandoffGuidance(ambiguous, 'product');
  assert.match(guidance, /角色编号/);
  assert.ok(guidance.includes('"id":"dev-a"'));
  assert.ok(guidance.includes('"id":"dev-b"'));
  assert.ok(!guidance.includes('"id":"product"'));
  assert.match(buildGroupHandoffGuidance([candidates[0]!, { id: 'qa', name: '测试：验收' }], 'product'), /角色编号/);
  assert.match(buildGroupHandoffGuidance([candidates[0]!, { id: 'dev', name: '产品经理' }], 'product'), /角色编号/);
});

test('final standalone handoff resolves an exact role, alias or id and preserves task and line', () => {
  for (const name of ['开发人员', 'Codex-开发', 'developer']) {
    const line = `交接给 @${name}：按上述验收标准开发，完成后说明验证结果。`;
    assert.deepEqual(parseGroupHandoff(`方案已经确认。\r\n\r\n${line}\r\n`, candidates, 'product'), {
      kind: 'handoff', targetBotId: 'developer', instruction: '按上述验收标准开发，完成后说明验证结果。', line, lineNumber: 3,
    });
  }
});

test('compatible final direct requests support the card-game screenshot and concrete tasks', () => {
  for (const instruction of ['轮到你了。', '请按照方案实现新增功能。', '接着上一轮继续出牌。', '继续排查这条失败日志。']) {
    const result = parseGroupHandoff(`我出一张 4。\n@Codex-开发 ${instruction}`, candidates, 'product');
    assert.equal(result.kind, 'handoff');
    if (result.kind === 'handoff') assert.equal(result.instruction, instruction);
  }
});

test('ordinary mentions, user-mediated instructions, questions and negation do not initiate a relay', () => {
  for (const text of [
    '我建议 @Codex-开发 看一下。', '@Codex-开发', '@Codex-开发 很擅长排查问题。',
    '请你 @Codex-开发 继续。', '不要 @Codex-开发 继续执行。', '不要交接给 @开发：继续。',
    '@Codex-开发 请继续吗？', '交接给 @开发：可以开始了吗？', '交接给 @开发：不要执行。',
    '交接给 @开发：请不要回复。', '交接给 @开发：继续开发。\n以上只是建议。',
  ]) assert.deepEqual(parseGroupHandoff(text, candidates, 'product'), { kind: 'none' }, text);
});

test('code, quotes, links and example syntax are not instructions', () => {
  for (const text of [
    '```text\n交接给 @开发：请开始开发。', '~~~\n交接给 @开发：请开始开发。',
    '```\n交接给 @开发：请开始开发。\n```', '> 交接给 @开发：请开始开发。',
    '    交接给 @开发：请开始开发。', '\t交接给 @开发：请开始开发。',
    '`交接给 @开发：请开始开发。`', '[交接给 @开发：请开始开发。](https://example.com)',
    '交接给 @开发[详情](https://example.com)：请开始开发。',
    '“交接给 @开发：请开始开发。”', '<!--\n交接给 @开发：请开始开发。',
    '例如：\n交接给 @开发：请开始开发。', '交接格式如下：\n\n交接给 @开发：请开始开发。',
    '可以这样写：\n@Codex-开发 轮到你了。', 'Example:\n@Codex-开发 轮到你了。',
    '- 交接给 @开发：请开始开发。', '1. 交接给 @开发：请开始开发。',
  ]) assert.deepEqual(parseGroupHandoff(text, candidates, 'product'), { kind: 'none' }, text);
});

test('a real final handoff after a closed code example remains actionable', () => {
  const result = parseGroupHandoff('```text\n@Codex-开发 轮到你了。\n```\n\n交接给 @开发：按刚才讨论的需求实现。', candidates, 'product');
  assert.equal(result.kind, 'handoff');
  assert.equal(parseGroupHandoff('输入格式已经确认\n交接给 @开发：按刚才讨论的需求实现。', candidates, 'product').kind, 'handoff');
});

test('unknown, self, multiple, ambiguous and empty handoffs fail closed with actionable reasons', () => {
  for (const [text, expected] of [
    ['交接给 @陌生人：执行。', 'unknown_target'],
    ['交接给 @产品经理：执行。', 'self_target'],
    ['交接给 @开发 @测试：执行。', 'multiple_targets'],
    ['交接给 @开发、测试：执行。', 'multiple_targets'],
    ['交接给 @开发：请开始，@测试 也请一起执行。', 'multiple_targets'],
    ['交接给 @开发：请开发。\n交接给 @测试：请测试。', 'multiple_targets'],
    ['@Codex-开发 轮到你了。\n@测试 轮到你了。', 'multiple_targets'],
    ['交接给 @开发：', 'empty_instruction'], ['@Codex-开发 请', 'empty_instruction'],
  ] as const) {
    const result = parseGroupHandoff(text, candidates, 'product');
    assert.equal(result.kind, 'invalid', text);
    if (result.kind === 'invalid') { assert.equal(result.reason, expected); assert.ok(result.message); }
  }
  const ambiguous = parseGroupHandoff('交接给 @开发：开始。', [...candidates, { id: 'other', name: '开发' }], 'product');
  assert.equal(ambiguous.kind, 'invalid');
  if (ambiguous.kind === 'invalid') assert.equal(ambiguous.reason, 'ambiguous_target');
});

test('names match exactly, aliases for the same id are not ambiguity and task emails are not recipients', () => {
  const people = [...candidates, { id: 'developer', name: '开发', aliases: ['开发人员'] }];
  const result = parseGroupHandoff('交接给 @开发：请检查 user@example.com 的校验规则，不要改代码。', people, 'product');
  assert.equal(result.kind, 'handoff');
  const partial = parseGroupHandoff('交接给 @Codex：开发。', candidates, 'product');
  assert.equal(partial.kind, 'invalid');
});

test('an automated chain is capped at six handoffs; malformed counters cannot bypass it', () => {
  assert.equal(MAX_GROUP_HANDOFFS, 6);
  for (let count = 0; count < 6; count++) assert.equal(canContinueGroupHandoff(count), true);
  for (const count of [6, 7, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) assert.equal(canContinueGroupHandoff(count), false);
});

test('guidance keeps only current recipients and omits self and static Skill instructions', () => {
  const guidance = buildGroupHandoffGuidance(candidates, 'product');
  assert.match(guidance, /开发人员/);
  assert.match(guidance, /测试人员/);
  assert.doesNotMatch(guidance, /产品经理/);
  assert.deepEqual(JSON.parse(guidance.slice(guidance.indexOf('：') + 1)), ['开发人员', '测试人员']);
  assert.doesNotMatch(guidance, /交接给 @|最终回复|最多自动交接|私聊/);
  assert.equal(buildGroupHandoffGuidance([candidates[0]!], 'product'), '');
  assert.equal(buildGroupHandoffGuidance([], 'product'), '');
});

test('repeating the same recipient in separate card-game paragraphs produces only the final handoff', () => {
  const final = '交接给 @开发人员：接我的单张3，如果已经接过就等用户。';
  const text = [
    '我出一张 3。',
    '交接给 @开发人员：我出了单张3，请接牌。',
    '',
    '按产品、开发、你的顺序继续，避免重复出牌。',
    final,
  ].join('\n');
  assert.deepEqual(parseGroupHandoff(text, candidates, 'product'), {
    kind: 'handoff', targetBotId: 'developer', instruction: '接我的单张3，如果已经接过就等用户。', line: final, lineNumber: 5,
  });
});

test('repeated role names, aliases and ids resolving to one bot use the final concrete instruction', () => {
  const text = [
    '交接给 @开发人员：先按方案新增功能。',
    '交接给 @developer：也要补充异常处理。',
    '@Codex-开发 请实现上述功能和异常处理，完成后汇报测试结果。',
  ].join('\n');
  assert.deepEqual(parseGroupHandoff(text, candidates, 'product'), {
    kind: 'handoff', targetBotId: 'developer', instruction: '请实现上述功能和异常处理，完成后汇报测试结果。',
    line: '@Codex-开发 请实现上述功能和异常处理，完成后汇报测试结果。', lineNumber: 3,
  });
});

test('different or unresolvable earlier recipients cannot be hidden by a valid final handoff', () => {
  for (const [earlier, expected] of [
    ['交接给 @测试：先验收。', 'multiple_targets'],
    ['交接给 @陌生人：先检查。', 'unknown_target'],
    ['交接给 @产品经理：继续完善需求。', 'self_target'],
    ['交接给 @开发 @测试：一起做。', 'multiple_targets'],
    ['交接给 @开发：请实现，@测试 请验收。', 'multiple_targets'],
    ['交接给 @开发：', 'empty_instruction'],
  ] as const) {
    const result = parseGroupHandoff(`${earlier}\n\n交接给 @开发人员：按方案开发。`, candidates, 'product');
    assert.equal(result.kind, 'invalid', earlier);
    if (result.kind === 'invalid') assert.equal(result.reason, expected, earlier);
  }
  const ambiguous = parseGroupHandoff('交接给 @开发：先实现。\n交接给 @开发人员：补充测试。', [...candidates, { id: 'another-developer', name: '开发' }], 'product');
  assert.equal(ambiguous.kind, 'invalid');
  if (ambiguous.kind === 'invalid') assert.equal(ambiguous.reason, 'ambiguous_target');
});

test('non-action mentions and protected earlier handoff examples do not count as extra recipients', () => {
  for (const earlier of [
    '交接给 @测试：可以验收了吗？',
    '交接给 @测试：请不要执行。',
    '@测试 请继续吗？',
    '不要交接给 @测试：先验收。',
    '我建议 @测试 稍后验收。',
    '> 交接给 @测试：先验收。',
    '    交接给 @测试：先验收。',
    '[交接给 @测试：先验收。](https://example.com)',
    '```text\n交接给 @测试：先验收。\n```',
    '~~~text\n交接给 @测试：先验收。\n~~~',
    '例如：\n交接给 @测试：先验收。',
  ]) {
    const result = parseGroupHandoff(`${earlier}\n\n实际先完成开发。\n交接给 @开发：按方案开发。`, candidates, 'product');
    assert.equal(result.kind, 'handoff', earlier);
    if (result.kind === 'handoff') assert.equal(result.targetBotId, 'developer', earlier);
  }
});

test('repeated recipients still require the last non-empty line to be an actionable handoff', () => {
  for (const ending of ['以上只是建议。', '交接给 @开发：可以开始了吗？', '交接给 @开发：不要执行。']) {
    const result = parseGroupHandoff(`交接给 @开发：按方案开发。\n${ending}`, candidates, 'product');
    assert.deepEqual(result, { kind: 'none' });
  }
});

test('structured handoff validation rejects routing fields and invalid or oversized payloads', () => {
  assert.deepEqual(validateGroupHandoffRequest({ target: ' 开发人员 ', task: ' 第一行\n第二行？ ' }), {
    target: '开发人员', task: '第一行\n第二行？',
  });
  assert.deepEqual(validateGroupHandoffRequest({ target: '甲'.repeat(100), task: '😀'.repeat(6000) }), {
    target: '甲'.repeat(100), task: '😀'.repeat(6000),
  });
  for (const value of [null, undefined, [], 'developer', 1, {}, { target: 'developer' }, { task: '检查' },
    { target: 1, task: '检查' }, { target: 'developer', task: false },
    { target: ' \t\n', task: '检查' }, { target: 'developer', task: '\n \t' },
    { target: '甲'.repeat(101), task: '检查' }, { target: 'developer', task: '文'.repeat(6001) },
    Object.create({ target: 'developer', task: '检查' }),
  ]) assert.throws(() => validateGroupHandoffRequest(value));
  for (const field of ['chatId', 'threadId', 'turnId', 'actorId', 'botId', 'groupId', 'chainId', 'localOnly', '__proto__']) {
    const value = JSON.parse(`{"target":"developer","task":"检查","${field}":"untrusted"}`);
    assert.throws(() => validateGroupHandoffRequest(value), /only contain target and task/, field);
  }
});

test('structured requests resolve exact names ids and aliases while preserving questions and multiline tasks', () => {
  const task = '请核查下面的问题：\n为什么 user@example.com 校验失败？\n参考 @测试 的公开结论，不要修改代码。';
  for (const target of [' 开发人员 ', 'developer', 'Codex-开发', '开发']) {
    const result = resolveGroupHandoffRequest({ target, task: ` ${task}\n` }, candidates, 'product');
    assert.equal(result.kind, 'handoff', target);
    if (result.kind === 'handoff') {
      assert.equal(result.targetBotId, 'developer');
      assert.equal(result.instruction, task);
    }
  }
  assert.equal(resolveGroupHandoffRequest({ target: 'developer', task: '不要执行代码，只回答问题？' }, candidates, 'product').kind, 'handoff');
});

test('structured recipient lookup fails closed for unknown ambiguous and self targets', () => {
  for (const [target, reason] of [
    ['陌生人', 'unknown_target'], ['Codex', 'unknown_target'], ['developer,qa', 'unknown_target'],
    ['开发 @测试', 'unknown_target'], ['产品经理', 'self_target'], ['product', 'self_target'],
  ] as const) {
    const result = resolveGroupHandoffRequest({ target, task: '检查' }, candidates, 'product');
    assert.equal(result.kind, 'invalid', target);
    if (result.kind === 'invalid') assert.equal(result.reason, reason, target);
  }
  for (const extra of [{ id: 'other', name: '开发' }, { id: 'other', name: 'developer' }, { id: 'other', name: '另一个角色', aliases: ['开发人员'] }]) {
    const target = extra.aliases?.[0] ?? extra.name;
    const result = resolveGroupHandoffRequest({ target, task: '检查' }, [...candidates, extra], 'product');
    assert.equal(result.kind, 'invalid');
    if (result.kind === 'invalid') assert.equal(result.reason, 'ambiguous_target');
  }
  const duplicateAlias = resolveGroupHandoffRequest({ target: '开发', task: '检查' }, [...candidates, { id: 'developer', name: '开发' }], 'product');
  assert.equal(duplicateAlias.kind, 'handoff');
  assert.throws(() => resolveGroupHandoffRequest({ target: 'developer', task: '检查', chatId: 'oc_other' }, candidates, 'product'), /only contain target and task/);
});
