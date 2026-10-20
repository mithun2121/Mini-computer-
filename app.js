(() => {
  const editor = document.getElementById('codeEditor');
  const output = document.getElementById('outputView');
  const explain = document.getElementById('explainView');
  const runStatus = document.getElementById('runStatus');
  const unsavedMark = document.getElementById('unsavedMark');
  const lineInfo = document.getElementById('lineInfo');
  const files = {
    'main.js': `// Try editing this example, then press Run.\nconst project = "Mini Computer";\nconsole.log("Hello from " + project + "!");\nconsole.log("2 + 3 =", 2 + 3);\n\nconst features = ["Editor", "Run", "Output", "MCP (planned)"];\nfeatures.forEach((feature, index) => {\n  console.log((index + 1) + ". " + feature);\n});`,
    'notes.md': `# Mini Computer\n\nA compact workspace designed to grow into an interactive ChatGPT app.\n\n## Roadmap\n- [x] Interactive editor and file switching\n- [x] Sandboxed JavaScript demo runner\n- [ ] Real Python execution in isolated cloud containers\n- [ ] MCP server and tool discovery\n- [ ] ChatGPT Apps SDK integration\n- [ ] Authentication, projects, and persistent files\n\nSecurity comes first: never run arbitrary user code in the API process.`
  };
  let activeFile = 'main.js';
  const original = { ...files };

  function renderLines(lines) {
    output.replaceChildren();
    if (!lines.length) {
      const msg = document.createElement('div');
      msg.className = 'output-line';
      msg.textContent = '(No output)';
      output.append(msg);
      return;
    }
    for (const line of lines) {
      const node = document.createElement('div');
      node.className = 'output-line' + (line.type === 'error' ? ' error' : '');
      node.textContent = line.text;
      output.append(node);
    }
  }
  function updateLineInfo() {
    lineInfo.textContent = 'Lines: ' + Math.max(1, editor.value.split('\n').length);
  }
  function markDirty() {
    unsavedMark.hidden = editor.value === files[activeFile];
    updateLineInfo();
  }
  function selectFile(name) {
    files[activeFile] = editor.value;
    activeFile = name;
    editor.value = files[name];
    document.getElementById('activeFileName').textContent = name;
    const isJs = name.endsWith('.js');
    document.getElementById('activeFileIcon').className = 'file-icon ' + (isJs ? 'js' : 'md');
    document.getElementById('activeFileIcon').textContent = isJs ? 'JS' : 'MD';
    document.getElementById('languageLabel').textContent = isJs ? 'JavaScript' : 'Markdown';
    document.querySelectorAll('.file-item').forEach(button => button.classList.toggle('active', button.dataset.file === name));
    editor.readOnly = !isJs;
    editor.setAttribute('aria-label', isJs ? 'JavaScript code editor' : 'Markdown notes viewer');
    markDirty();
  }
  function runCode() {
    if (!activeFile.endsWith('.js')) {
      renderLines([{text:'Select main.js to run JavaScript.'}]);
      return;
    }
    files[activeFile] = editor.value;
    runStatus.textContent = 'Running…';
    const lines = [];
    const source = editor.value;
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
      window.onerror = (message, source, line, column) => { send('error', ['Error: ' + message + ' (line ' + line + ')']); return true; };
      try { (new Function(${safeSource}))(); send('done', ['Execution finished.']); } catch (error) { send('error', [error.name + ': ' + error.message]); send('done', []); }
    <\/script>`;
    const listener = event => {
      if (event.source !== iframe.contentWindow || event.data?.kind !== 'mini-computer-console') return;
      if (event.data.type === 'done') {
        window.removeEventListener('message', listener);
        iframe.remove();
        runStatus.textContent = 'Finished';
        if (!lines.length) lines.push({text:'(No output)'});
        renderLines(lines);
      } else {
        lines.push({text:event.data.text, type:event.data.type});
      }
    };
    window.addEventListener('message', listener);
    document.body.append(iframe);
    setTimeout(() => {
      if (iframe.isConnected) {
        window.removeEventListener('message', listener);
        iframe.remove();
        lines.push({text:'Execution stopped: time limit reached.',type:'error'});
        renderLines(lines);
        runStatus.textContent = 'Timed out';
      }
    }, 2000);
  }
  editor.addEventListener('input', markDirty);
  document.querySelectorAll('.file-item').forEach(button => button.addEventListener('click', () => selectFile(button.dataset.file)));
  document.getElementById('runBtn').addEventListener('click', runCode);
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