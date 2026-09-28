import assert from 'node:assert/strict';
import path from 'node:path';

// Destructive/production targets are not accepted: this probe is pinned to the
// previously created disposable connection-test thread and example workspace.
export async function probeDesktopTurns({ rpc, report, cwd, inspectUiOnly = false }) {
  const threadId = '01a0d2f7-4065-7ec1-93f3-8c44e98d7a2f';
  const marker = `DESKTOP${Date.now()}`;
  let activeTurnId;
  const checks = report.conversation = { threadId, cwd, marker, startedAt: new Date().toISOString() };
  async function evaluate(expression) {
    const response = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 15000);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  async function appRequest(method, params) {
    const response = await evaluate(`(async () => {
      const id=crypto.randomUUID();
      return await new Promise(resolve => {
        let timer;
        const done=result => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(result); };
        const receive=event => { const value=event.data; if(value?.type==='mcp-response' && value.hostId==='local' && value.message?.id===id) done(value.message); };
        window.addEventListener('message',receive);
        timer=setTimeout(()=>done({error:{message:'Desktop RPC timeout'}}),12000);
        Promise.resolve(window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request:{id,method:${JSON.stringify(method)},params:${JSON.stringify(params)}},timeoutMs:10000})).catch(error=>done({error:{message:String(error)}}));
      });
    })()`);
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  }
  async function uiState() {
    return evaluate(`({ markerVisible: document.body.innerText.includes(${JSON.stringify(marker)}), stopButtons: [...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText).filter(t=>/^(stop|停止|中断)/i.test(t||'')).slice(0,6) })`);
  }
  async function start(prompt) {
    const result = await appRequest('turn/start', {
      threadId, input: [{ type: 'text', text: prompt, text_elements: [] }],
      approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, effort: 'low',
    });
    activeTurnId = result.turn.id;
    return activeTurnId;
  }
  async function waitForTurn(turnId) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const result = await appRequest('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'full' });
      const turn = result.data.find(item => item.id === turnId);
      if (turn && turn.status !== 'inProgress') { activeTurnId = undefined; return turn; }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    throw new Error('Dedicated test turn did not finish within two minutes');
  }
  const answer = turn => (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').map(item => item.text).join('\n').trim();
  try {
    const before = await appRequest('thread/read', { threadId, includeTurns: false });
    assert.equal(before.thread.id, threadId);
    assert.equal(path.resolve(before.thread.cwd).toLowerCase(), path.resolve(cwd).toLowerCase(), 'Refuse to write outside the dedicated example workspace');
    assert.notEqual(before.thread.status?.type, 'active', 'Refuse to interrupt a pre-existing active test turn');
    checks.existingThreadVerified = true;
    checks.threadLinks = await evaluate(`([...document.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href').includes(${JSON.stringify(threadId)})).map(a=>({href:a.getAttribute('href'),label:a.innerText.slice(0,120)})))`);
    // This installed version's existing UI event bus handles normal route
    // changes (settings, forks, etc.). Never spoof window ownership or roles.
    checks.navigation = await evaluate(`(async () => {
      const moduleUrl=new URL('./assets/app-shared-4d3eb8fed85c.js',document.baseURI).href;
      const appModule=await import(moduleUrl);
      if(typeof appModule.G3?.dispatchHostMessage!=='function') return {found:false,reason:'UI navigation bus unavailable'};
      const deadline=Date.now()+10000;
      while(!appModule.G3.handlers?.get('navigate-to-route')?.size && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,200));
      if(!appModule.G3.handlers?.get('navigate-to-route')?.size) return {found:false,reason:'UI navigation handler not ready'};
      appModule.G3.dispatchHostMessage({type:'navigate-to-route',path:'/local/'+${JSON.stringify(threadId)}});
      return {found:true,method:'existing-ui-event-bus',moduleUrl};
    })()`);
    if (!checks.navigation.found) throw new Error('Cannot load the dedicated thread through the installed UI event bus');
    await new Promise(resolve => setTimeout(resolve, 6000));
    checks.uiBefore = await evaluate(`({ title: document.title, location: location.href, mainText: document.querySelector('main')?.innerText.slice(0,1200), bodyText: document.body.innerText.slice(0,1800), buttons: [...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')||b.innerText).filter(Boolean).slice(-15) })`);
    if (inspectUiOnly) { checks.readOnlyUiInspection = true; return; }
    await appRequest('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    const recalled = await waitForTurn(await start('这是专用连接验证，不要使用工具。最早一开始记住、以 FC 开头的测试编号是什么？只回复编号。'));
    checks.recall = { turnId: recalled.id, status: recalled.status, answer: answer(recalled) };
    assert.equal(recalled.status, 'completed');
    assert.equal(answer(recalled), 'FC731');
    const steeringTurn = await start('这是控制接口验证。请等待 30 秒，再只回复 WAIT_DONE。可以使用计时工具，但不要读写文件、访问网络或执行其他任务。');
    checks.busyUi = await uiState();
    const steered = await appRequest('turn/steer', {
      threadId, expectedTurnId: steeringTurn,
      input: [{ type: 'text', text: `取消等待；只回复 ${marker}。不要使用其他工具。`, text_elements: [] }],
    });
    checks.steer = { requestedTurnId: steeringTurn, returnedTurnId: steered.turnId };
    assert.equal(steered.turnId, steeringTurn);
    const finished = await waitForTurn(steeringTurn);
    checks.steer.status = finished.status;
    checks.steer.answer = answer(finished);
    assert.equal(finished.status, 'completed');
    assert.equal(answer(finished), marker);
    await new Promise(resolve => setTimeout(resolve, 1000));
    checks.completedUi = await uiState();
    const stopTurn = await start('这是停止接口验证。请等待 45 秒，然后只回复 WAIT_DONE。可以使用计时工具，不要读写文件或访问网络。');
    await appRequest('turn/interrupt', { threadId, turnId: stopTurn });
    const stopped = await waitForTurn(stopTurn);
    checks.interrupt = { turnId: stopped.id, status: stopped.status };
    assert.equal(stopped.status, 'interrupted');
    checks.finalUi = await uiState();
    checks.backendControlPassed = true;
    checks.uiMarkerVisible = checks.completedUi.markerVisible;
    checks.finishedAt = new Date().toISOString();
    console.log(JSON.stringify({ stage: 'dedicated-thread-controls', checks }));
    if (!checks.uiMarkerVisible) throw new Error('Backend control passed, but desktop UI did not display the test marker');
  } finally {
    if (activeTurnId) await appRequest('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {});
  }
}
