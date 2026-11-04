// BuildX product identity stays separate from the host's Codex login. This
// component never receives or stores provider tokens; the local service owns
// its HttpOnly session cookie and all authorization decisions.
function createBuildxAccountPanel(env) {
  const {document, fetch, sessionStorage, crypto, window, setTimeout, clearTimeout,
    AbortController, CustomEvent, TextEncoder, timeoutMs = 12000} = env;
  const get = id => document.getElementById(id);
  const panel = get('account-panel');
  if (!panel) return null;
  let client;
  try { client = sessionStorage.getItem('revit-codex-client') || crypto.randomUUID(); sessionStorage.setItem('revit-codex-client', client); }
  catch { client = crypto.randomUUID(); }
  let account = null, working = false, source = false, busy = false, generation = 0, workspaceKind = null, modelStatusSignature = null;
  const fields = ['account-email', 'account-password'];
  const actions = ['account-sign-in', 'account-sign-up', 'account-renew', 'account-sign-out', 'account-refresh'];
  function notice(message = '', failed = false) {
    get('account-notice').textContent = message;
    get('account-notice').className = 'account-notice' + (failed ? ' error' : '');
    get('account-notice').hidden = !message;
  }
  function render() {
    panel.hidden = source;
    const available = !source && account?.configured === true;
    const signedIn = available && account.signedIn;
    const retained = available && account.retainedSession && !signedIn;
    const hasSession = signedIn || retained;
    get('account-summary').textContent = !account ? '待检查' : !available ? '未配置' : signedIn ? '已登录' : retained ? '待核验' : '未登录';
    get('account-state').textContent = !account ? '账号状态未确认，请刷新。' : !available
      ? account.required ? '账号后端配置未完成，当前不能开始对话。' : '账号后端尚未配置，当前为本地研究模式。'
      : signedIn ? '已登录：' + (account.user.email || '已验证用户') : retained
        ? '本机仍保留登录，但当前未通过核验。可刷新核验，或清除本机登录后再登录。'
        : account.required ? '请先登录 BuildX，再开始对话。' : '可登录 BuildX；本地 Codex 登录由主面板单独显示。';
    get('account-fields').hidden = hasSession;
    for (const id of fields) get(id).disabled = working || busy || !available || hasSession;
    get('account-sign-in').hidden = hasSession;
    get('account-sign-up').hidden = hasSession;
    get('account-renew').hidden = !hasSession;
    get('account-sign-out').hidden = !hasSession;
    get('account-sign-out').textContent = retained ? '清除本机登录' : '退出 BuildX';
    for (const id of actions) get(id).disabled = working || source || (id !== 'account-refresh' && (busy || !available));
    get('account-sign-up').textContent = workspaceKind === 'model' ? '邀请码注册' : '注册';
    get('account-sign-up').disabled = workspaceKind === 'model' ? working : get('account-sign-up').disabled || workspaceKind === null;
    get('account-renew').disabled = get('account-renew').disabled || !hasSession;
    // Other account surfaces consume these parsed presentation facts instead of
    // keeping a second identity from the chat's independently refreshed state.
    panel.buildxDisplay = Object.freeze({signedIn:Boolean(signedIn),retained:Boolean(retained),
      email:signedIn ? account.user.email : null,summary:get('account-summary').textContent,
      canSignOut:Boolean(hasSession && !get('account-sign-out').disabled)});
    panel.dispatchEvent?.(new CustomEvent('buildx-account-display',{detail:panel.buildxDisplay}));
  }
  function parseAccount(value) {
    if (!value || typeof value.configured !== 'boolean' || typeof value.required !== 'boolean' || typeof value.signedIn !== 'boolean') throw new Error('invalid_account');
    if (workspaceKind === 'customer-chat' && value.required !== true) throw new Error('invalid_customer_account');
    if (value.signedIn && (!value.configured || !value.user || typeof value.user.id !== 'string' || !value.user.id || value.user.id.length > 128 ||
        (value.user.email !== null && (typeof value.user.email !== 'string' || !value.user.email || value.user.email.length > 320)))) throw new Error('invalid_account');
    if (value.retainedSession !== undefined && typeof value.retainedSession !== 'boolean') throw new Error('invalid_account');
    if (value.expiresAt !== null && value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt < 0)) throw new Error('invalid_account');
    return {configured:value.configured, required:value.required, signedIn:value.signedIn,
      retainedSession:value.retainedSession === true,
      user:value.signedIn ? {id:value.user.id,email:value.user.email} : null, expiresAt:value.expiresAt ?? null};
  }
  async function request(route, options, owner) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('account_timeout')); }, timeoutMs); });
    try {
      const response = await Promise.race([fetch(route, {cache:'no-store',credentials:'same-origin',redirect:'error',...options,signal:controller.signal}),timeout]);
      if (owner !== generation) throw new Error('stale_account_request');
      const data = await Promise.race([response.json(),timeout]);
      if (owner !== generation) throw new Error('stale_account_request');
      if (!response.ok) {
        const error = new Error('account_request_failed');
        // Only the status class is used for display, never arbitrary provider
        // messages which could echo submitted credentials or response bodies.
        error.status = response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function preflight(owner) {
    const data = await request('/api/status', undefined, owner);
    const kind = data.workspace?.kind;
    if (!['model','source-development','customer-chat'].includes(kind) || workspaceKind === 'customer-chat' && kind !== workspaceKind) throw new Error('unknown_workspace');
    workspaceKind = kind;
    source = kind === 'source-development';
    busy = data.busy !== false;
    if (source) { account = null; render(); return null; }
    panel.hidden = false;
    if (typeof data.csrf !== 'string' || !data.csrf || data.csrf.length > 200) throw new Error('missing_csrf');
    return data;
  }
  function changed() { window?.dispatchEvent(new CustomEvent('buildx-account-changed')); }
  async function operate(action, initialRefresh = false) {
    if (working) return;
    working = true;
    const owner = ++generation;
    const credentialsAction = action === 'sign-in' || action === 'sign-up';
    const email = credentialsAction ? get('account-email').value.trim() : '';
    const password = credentialsAction ? get('account-password').value : '';
    // Do not retain a password after any submission, including preflight or
    // request failure. Email remains available for a deliberate retry.
    get('account-password').value = '';
    notice(); render();
    try {
      const state = await preflight(owner);
      if (!state) return;
      if (action === 'refresh') {
        account = parseAccount(await request('/api/account/status', undefined, owner));
        if (busy) notice('对话或上下文读取正在进行，暂不能切换账号。');
        return;
      }
      if (busy) { notice('对话或上下文读取正在进行，请结束后再操作账号。'); return; }
      // Renewal consumes the same fresh account verification as the preflight
      // CSRF/busy snapshot. Other account flows retain their existing reads.
      account = parseAccount(action === 'refresh-session' ? state.account
        : await request('/api/account/status', undefined, owner));
      if (!account.configured) { notice('账号后端尚未配置。请先完成本地配置，再连接 BuildX 专用项目。'); return; }
      if (action === 'refresh-session' && !account.signedIn && !account.retainedSession) {
        notice('本机没有可续期的登录，请重新登录。'); return;
      }
      if (account.retainedSession && !account.signedIn && action !== 'sign-out' && action !== 'refresh-session') {
        notice('请先刷新核验，或清除本机保留的登录，再登录或注册。'); return;
      }
      if (credentialsAction && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || new TextEncoder().encode(email).length > 320 ||
          password.length < (action === 'sign-up' ? 6 : 1) || new TextEncoder().encode(password).length > 1024)) {
        notice(action === 'sign-up' ? '请输入有效邮箱和至少 6 个字符的密码，密码最多 1024 字节；项目可能要求更强密码。'
          : '请输入有效邮箱和 BuildX 密码，密码最多 1024 字节。',true); return;
      }
      const input = credentialsAction ? {client,email,password} : {client};
      const result = await request('/api/account/' + action, {method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify(input)},owner);
      account = parseAccount(result.account ?? result);
      notice(action === 'sign-up' && result.verificationRequired
        ? '注册请求已受理，请先完成邮箱验证，再回来登录。'
        : action === 'sign-out' ? '已退出 BuildX。本机 Codex 登录没有被注销。'
        : action === 'refresh-session' ? account.signedIn ? 'BuildX 登录已续期。当前对话保留；Codex 登录未更改。' : '续期结果尚未核验，请刷新状态或重新登录。'
        : account.signedIn ? 'BuildX 已登录。Codex 连接状态请查看主面板。' : '请求已返回，请刷新账号状态。');
      if (action === 'sign-in' || action === 'sign-out' || (action === 'sign-up' && account.signedIn)) changed();
    } catch (error) {
      if (owner !== generation) return;
      // A failed status read cannot leave an old account represented as current.
      account = null;
      notice(error.message === 'account_timeout' ? '账号服务响应超时，请刷新状态后核对结果，勿重复提交。'
        : error.status === 409 ? '服务仍有任务或账号操作正在进行，请稍后刷新状态。'
        : error.status === 401 || error.status === 403 ? '账号请求未通过验证，请核对登录信息并刷新状态。'
        : '账号请求未完成，请刷新状态后再试。',true);
    } finally {
      if (owner === generation) {
        working = false; render();
        // Status refresh is distinct from changing identity: the main chat
        // rechecks readiness without discarding the existing conversation.
        if ((action === 'refresh' && !initialRefresh || action === 'refresh-session') && !source)
          window?.dispatchEvent(new CustomEvent('buildx-account-refreshed'));
      }
    }
  }
  for (const [id, action] of [['account-sign-in','sign-in'],['account-sign-up','sign-up'],['account-renew','refresh-session'],['account-sign-out','sign-out'],['account-refresh','refresh']])
    get(id).addEventListener('click', () => {
      if (action === 'sign-up' && workspaceKind === 'model') {
        if (get(id).disabled) return;
        get('account-password').value = '';
        // Open synchronously in the click so embedded browsers retain the user gesture.
        window?.open('/register.html','_blank','noopener,noreferrer');
        return;
      }
      if (action === 'sign-up' && workspaceKind === null) return;
      void operate(action);
    });
  for (const id of fields) get(id).addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
  window?.addEventListener('buildx-model-view',event=>{
    if(workspaceKind!=='model'||event.detail?.enabled!==true||!event.detail.account)return;
    let next;
    try{next=parseAccount(event.detail.account);}catch{next=null;}
    const signature=JSON.stringify(next);
    // Repeated UI projections are not fresh account observations. In particular
    // they must not undo a failed independent verification with the old user.
    if(signature===modelStatusSignature)return;
    modelStatusSignature=signature;
    const identityChanged=account&&(account.signedIn!==next?.signedIn||account.retainedSession!==next?.retainedSession||account.user?.id!==next?.user?.id);
    if(working&&!identityChanged)return;
    if(identityChanged||!next){generation++;working=false;get('account-password').value='';notice();}
    account=next;busy=event.detail.busy!==false;render();
  });
  window?.addEventListener('pagehide',()=>{generation++;working=false;get('account-password').value='';render();});
  render();
  void operate('refresh',true);
  return {refresh:()=>operate('refresh')};
}

if (typeof document !== 'undefined' && document.getElementById('account-panel'))
  createBuildxAccountPanel({document,fetch,sessionStorage,crypto,window,setTimeout,clearTimeout,AbortController,CustomEvent,TextEncoder});
