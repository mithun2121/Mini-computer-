(() => {
  const editor = document.getElementById('codeEditor');
  const output = document.getElementById('outputView');
  const explain = document.getElementById('explainView');
  const runStatus = document.getElementById('runStatus');
  const unsavedMark = document.getElementById('unsavedMark');
  const lineInfo = document.getElementById('lineInfo');
  const lineGutter = document.getElementById('lineGutter');
  const apiUrlInput = document.getElementById('apiUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const connectionHint = document.getElementById('connectionHint');
  const languageSelect = document.getElementById('languageSelect');
  const files = {
    'main.js': `// Try editing this example, then press Run.\nconst project = "Mini Computer";\nconsole.log("Hello from " + project + "!");\nconsole.log("2 + 3 =", 2 + 3);\n\nconst features = ["Editor", "Run", "Output", "MCP (planned)"];\nfeatures.forEach((feature, index) => {\n  console.log((index + 1) + ". " + feature);\n});`,
    'notes.md': `# Mini Computer\n\nA compact workspace designed to grow into an interactive ChatGPT app.\n\n## Roadmap\n- [x] Interactive editor and file switching\n- [x] Sandboxed JavaScript demo runner\n- [ ] Real Python execution in isolated cloud containers\n- [ ] MCP server and tool discovery\n- [ ] ChatGPT Apps SDK integration\n- [ ] Authentication, projects, and persistent files\n\nSecurity comes first: never run arbitrary user code in the API process.`
  };
  const original = { ...files };
  let activeFile = 'main.js';

  function renderLines(lines) {
    output.replaceChildren();
    if (!lines.length) lines = [{ text: '(No output)' }];
    for (const line of lines) {
      const node = document.createElement('div');
      node.className = 'output-line' + (line.type === 'error' ? ' error' : '');
      node.textContent = line.text;
      output.append(node);
    }
  }
  function updateLineInfo() {
    const count = Math.max(1, editor.value.split('\n').length);
    lineInfo.textContent = 'Lines: ' + count;
    if (lineGutter) lineGutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  }
  function markDirty() {
    unsavedMark.hidden = editor.value === files[activeFile];
    updateLineInfo();
  }
  function readConnection() {
    return {
      url: (apiUrlInput.value.trim() || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
      key: apiKeyInput.value
    };
  }
  async function connectBackend() {
    const config = readConnection();
    if (!config.key) {
      connectionHint.textContent = 'Enter the development API key. It is kept in this tab only and is not saved to the repository.';
      return;
    }
    connectionHint.textContent = 'Checking backend…';
    try {
      const response = await fetch(config.url + '/health', { method: 'GET' });
      if (!response.ok) throw new Error('Health check returned HTTP ' + response.status);
      const result = await response.json();
      connectionHint.textContent = 'Connected to ' + (result.service || 'execution API') + '. Run requests will send the key to this address.';
      runStatus.textContent = 'Backend connected';
    } catch (error) {
      connectionHint.textContent = 'Connection failed: ' + error.message + '. Confirm the API is running and CORS_ORIGINS includes this page origin.';
      runStatus.textContent = 'Offline';
    }
  }
  async function runOnBackend(code, language, config) {
    runStatus.textContent = 'Running on backend…';
    try {
      const response = await fetch(config.url + '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.key },
        body: JSON.stringify({ language, code })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || ('HTTP ' + response.status));
      const lines = [{ text: result.output || '(No output)', type: result.status === 'error' || result.status === 'timeout' ? 'error' : 'log' }];
      lines.push({ text: 'Status: ' + result.status + ' · ' + result.duration_ms + ' ms' });
      if (result.truncated) lines.push({ text: 'Output was truncated by the server.' });
      renderLines(lines);
      runStatus.textContent = result.status === 'success' ? 'Finished' : result.status;
    } catch (error) {
      renderLines([{ text: 'Backend request failed: ' + error.message, type: 'error' }]);
      runStatus.textContent = 'Request failed';
    }
  }
  function runBrowserJavaScript(source) {
    runStatus.textContent = 'Running in browser sandbox…';
    const lines = [];
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', 'Isolated JavaScript execution frame');
    iframe.style.cssText = 'position:absolute;width:1px;height:1px;left:-10000px;border:0';
    const safeSource = JSON.stringify(source).replace(/</g, '\\u003c');
    iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script>
      const send = (type, args) => parent.postMessage({kind:'mini-computer-console', type, text:args.map(v => { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); } }).join(' ')}, '*');
      console.log = (...args) => send('log', args);
      console.info = (...args) => send('log', args);
      console.warn = (...args) => send('log', ['WARN:', ...args]);
      console.error = (...args) => send('error', args);
      window.onerror = (message, source, line) => { send('error', ['Error: ' + message + ' (line ' + line + ')']); return true; };
      try { (new Function(${safeSource}))(); send('done', []); } catch (error) { send('error', [error.name + ': ' + error.message]); send('done', []); }
    <\/script>`;
    const listener = event => {
      if (event.source !== iframe.contentWindow || event.data?.kind !== 'mini-computer-console') return;
      if (event.data.type === 'done') {
        window.removeEventListener('message', listener);
        iframe.remove();
        runStatus.textContent = 'Finished (browser demo)';
        renderLines(lines);
      } else {
        lines.push({ text: event.data.text, type: event.data.type });
      }
    };
    window.addEventListener('message', listener);
    document.body.append(iframe);
    setTimeout(() => {
      if (iframe.isConnected) {
        window.removeEventListener('message', listener);
        iframe.remove();
        lines.push({ text: 'Execution stopped: time limit reached.', type: 'error' });
        renderLines(lines);
        runStatus.textContent = 'Timed out';
      }
    }, 2000);
  }
  async function runCode() {
    if (!activeFile.endsWith('.js')) {
      renderLines([{ text: 'Select main.js to run code.' }]);
      return;
    }
    files[activeFile] = editor.value;
    markDirty();
    const language = languageSelect.value;
    const config = readConnection();
    if (config.key) {
      await runOnBackend(editor.value, language, config);
      return;
    }
    if (language === 'python') {
      renderLines([{ text: 'Python requires the backend. Enter the local API address and development API key above, then click Connect.', type: 'error' }]);
      runStatus.textContent = 'Backend required';
      return;
    }
    runBrowserJavaScript(editor.value);
  }
  function selectFile(name) {
    files[activeFile] = editor.value;
    activeFile = name;
    editor.value = files[name];
    document.getElementById('activeFileName').textContent = name;
    const isJs = name.endsWith('.js');
    document.getElementById('activeFileIcon').className = 'file-icon ' + (isJs ? 'js' : 'md');
    document.getElementById('activeFileIcon').textContent = isJs ? 'JS' : 'MD';
    languageSelect.value = 'javascript';
    languageSelect.disabled = !isJs;
    document.querySelectorAll('.file-item').forEach(button => button.classList.toggle('active', button.dataset.file === name));
    editor.readOnly = !isJs;
    editor.setAttribute('aria-label', isJs ? 'Code editor' : 'Markdown notes viewer');
    markDirty();
  }
  editor.addEventListener('input', markDirty);
  document.querySelectorAll('.file-item').forEach(button => button.addEventListener('click', () => selectFile(button.dataset.file)));
  document.getElementById('runBtn').addEventListener('click', runCode);
  document.getElementById('connectBtn').addEventListener('click', connectBackend);
  document.getElementById('clearOutputBtn').addEventListener('click', () => { output.replaceChildren(); runStatus.textContent = 'Cleared'; });
  document.getElementById('resetBtn').addEventListener('click', () => {
    Object.assign(files, original);
    selectFile('main.js');
    renderLines([]);
    runStatus.textContent = 'Ready';
  });
  document.querySelectorAll('.output-tab').forEach(button => button.addEventListener('click', () => {
    const isExplain = button.dataset.panel === 'explain';
    document.querySelectorAll('.output-tab').forEach(tab => tab.classList.toggle('active', tab === button));
    output.hidden = isExplain;
    explain.hidden = !isExplain;
  }));
  editor.value = files[activeFile];
  updateLineInfo();
})();