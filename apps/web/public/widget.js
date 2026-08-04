(function() {
  const scriptTag = document.currentScript || document.querySelector('script[src*="widget.js"]');
  const apiKey = scriptTag?.getAttribute('data-api-key') || '';
  const orgId = scriptTag?.getAttribute('data-org-id') || '';
  const apiUrl = window.ACE_WIDGET_API_URL || 'http://localhost:4000';

  let config = {
    organizationName: 'ACE Widget',
    welcomeMessage: 'Hi there! How can I help you today?',
    primaryColor: '#3b82f6',
    secondaryColor: '#1e40af',
    position: 'bottom-right',
    enableVoiceCall: true,
    enableChat: true,
    logoUrl: ''
  };

  let sessionId = localStorage.getItem('ace_widget_session_id');
  if (!sessionId) {
    sessionId = 'sess_' + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('ace_widget_session_id', sessionId);
  }

  const contactDataStr = localStorage.getItem('ace_widget_contact');
  let contactData = contactDataStr ? JSON.parse(contactDataStr) : null;

  async function fetchConfig() {
    try {
      const qs = apiKey ? `apiKey=${apiKey}` : `orgId=${orgId}`;
      const res = await fetch(`${apiUrl}/api/widget/config?${qs}`);
      if (res.ok) {
        const data = await res.json();
        config = { ...config, ...data };
      }
    } catch (e) {
      console.error('Failed to fetch widget config', e);
    }
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.innerHTML = `
      .ace-widget-launcher {
        position: fixed;
        ${config.position === 'bottom-left' ? 'left: 20px;' : 'right: 20px;'}
        bottom: 20px;
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: ${config.primaryColor};
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 9999;
        transition: transform 0.2s ease;
      }
      .ace-widget-launcher:hover {
        transform: scale(1.05);
      }
      .ace-widget-launcher svg {
        width: 30px;
        height: 30px;
        fill: currentColor;
      }
      .ace-widget-launcher .pulse {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        border-radius: 50%;
        animation: ace-pulse 2s infinite;
        box-shadow: 0 0 0 0 ${config.primaryColor};
      }
      @keyframes ace-pulse {
        0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
        70% { transform: scale(1); box-shadow: 0 0 0 15px rgba(59, 130, 246, 0); }
        100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
      }

      .ace-widget-modal {
        position: fixed;
        ${config.position === 'bottom-left' ? 'left: 20px;' : 'right: 20px;'}
        bottom: 90px;
        width: 380px;
        height: 520px;
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.3);
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.1);
        z-index: 9999;
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .ace-widget-modal.open {
        display: flex;
        animation: ace-slide-up 0.3s ease;
      }
      @keyframes ace-slide-up {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .ace-widget-header {
        background: ${config.primaryColor};
        color: #fff;
        padding: 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-top-left-radius: 16px;
        border-top-right-radius: 16px;
      }
      .ace-widget-header-info {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .ace-widget-header-logo {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #fff;
        background-image: url('${config.logoUrl}');
        background-size: cover;
        background-position: center;
      }
      .ace-widget-header-title {
        font-weight: 600;
        font-size: 16px;
        line-height: 1.2;
      }
      .ace-widget-header-status {
        font-size: 12px;
        opacity: 0.8;
      }
      .ace-widget-header-actions {
        display: flex;
        gap: 8px;
      }
      .ace-widget-header-btn {
        background: transparent;
        border: none;
        color: #fff;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
      }
      .ace-widget-header-btn:hover {
        background: rgba(255,255,255,0.2);
      }

      .ace-widget-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        background: rgba(250, 250, 250, 0.5);
      }

      .ace-widget-message {
        max-width: 80%;
        padding: 10px 14px;
        border-radius: 16px;
        font-size: 14px;
        line-height: 1.4;
      }
      .ace-widget-message.ai {
        background: #f1f5f9;
        color: #1e293b;
        align-self: flex-start;
        border-bottom-left-radius: 4px;
      }
      .ace-widget-message.customer {
        background: ${config.primaryColor};
        color: #fff;
        align-self: flex-end;
        border-bottom-right-radius: 4px;
      }

      .ace-widget-form {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .ace-widget-form input {
        width: 100%;
        padding: 10px;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        outline: none;
        box-sizing: border-box;
      }
      .ace-widget-form button {
        background: ${config.primaryColor};
        color: #fff;
        border: none;
        padding: 12px;
        border-radius: 8px;
        font-weight: 600;
        cursor: pointer;
      }

      .ace-widget-footer {
        padding: 12px;
        background: #fff;
        border-top: 1px solid #f1f5f9;
        display: flex;
        gap: 8px;
      }
      .ace-widget-footer textarea {
        flex: 1;
        border: 1px solid #e2e8f0;
        border-radius: 20px;
        padding: 8px 16px;
        resize: none;
        outline: none;
        height: 20px;
        font-family: inherit;
        font-size: 14px;
      }
      .ace-widget-footer button {
        background: ${config.primaryColor};
        color: #fff;
        border: none;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      
      .ace-widget-typing {
        display: flex;
        gap: 4px;
        padding: 4px 8px;
      }
      .ace-widget-typing span {
        width: 6px;
        height: 6px;
        background: #94a3b8;
        border-radius: 50%;
        animation: ace-typing 1.4s infinite ease-in-out;
      }
      .ace-widget-typing span:nth-child(1) { animation-delay: -0.32s; }
      .ace-widget-typing span:nth-child(2) { animation-delay: -0.16s; }
      @keyframes ace-typing {
        0%, 80%, 100% { transform: scale(0); }
        40% { transform: scale(1); }
      }

      /* Voice call */
      .ace-voice-panel {
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        flex: 1;
        background: #fff;
        padding: 20px;
        text-align: center;
      }
      .ace-voice-panel.active {
        display: flex;
      }
      .ace-voice-waves {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 60px;
        margin: 20px 0;
      }
      .ace-voice-waves div {
        width: 8px;
        background: ${config.primaryColor};
        border-radius: 4px;
        animation: ace-eq 1s infinite ease-in-out;
      }
      .ace-voice-waves div:nth-child(2) { animation-delay: 0.2s; height: 100%; }
      .ace-voice-waves div:nth-child(3) { animation-delay: 0.4s; height: 60%; }
      .ace-voice-waves div:nth-child(4) { animation-delay: 0.6s; height: 80%; }
      .ace-voice-waves div:nth-child(5) { animation-delay: 0.8s; height: 40%; }
      @keyframes ace-eq {
        0%, 100% { height: 20%; }
        50% { height: 100%; }
      }
    `;
    document.head.appendChild(style);
  }

  function renderHTML() {
    const container = document.createElement('div');
    container.id = 'ace-widget-container';
    container.innerHTML = `
      <div class="ace-widget-launcher" id="ace-widget-launcher">
        <div class="pulse"></div>
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
      </div>
      <div class="ace-widget-modal" id="ace-widget-modal">
        <div class="ace-widget-header">
          <div class="ace-widget-header-info">
            <div class="ace-widget-header-logo"></div>
            <div>
              <div class="ace-widget-header-title">${config.organizationName}</div>
              <div class="ace-widget-header-status">AI Assistant Online</div>
            </div>
          </div>
          <div class="ace-widget-header-actions">
            ${config.enableVoiceCall ? '<button class="ace-widget-header-btn" id="ace-voice-toggle" title="Start Voice Call">📞</button>' : ''}
            <button class="ace-widget-header-btn" id="ace-widget-close" title="Close">✖</button>
          </div>
        </div>
        
        <!-- Voice Panel -->
        <div class="ace-voice-panel" id="ace-voice-panel">
          <h3 style="margin-bottom:8px; font-weight:700;">Voice Support</h3>
          <p style="font-size:13px; color:#475569; margin-bottom:16px;">Call our AI Voice Assistant or request a direct phone callback.</p>
          <a id="ace-voice-call-link" href="tel:${config.phone || '+23417008000'}" style="display:inline-block; padding:10px 20px; background:${config.primaryColor}; color:#fff; font-weight:600; text-decoration:none; border-radius:8px; margin-bottom:12px;">📞 Call ${config.phone || '+234 1 700 8000'}</a>
          <button style="margin-top:12px; padding:8px 16px; background:#e2e8f0; color:#334155; border:none; border-radius:8px; cursor:pointer; font-weight:500;" id="ace-voice-end">Back to Chat</button>
        </div>

        <div class="ace-widget-body" id="ace-widget-body">
          <!-- Chat content or Lead Form -->
        </div>
        <div class="ace-widget-footer" id="ace-widget-footer">
          <textarea id="ace-widget-input" placeholder="Type your message..." rows="1"></textarea>
          <button id="ace-widget-send"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
        </div>
      </div>
    `;
    document.body.appendChild(container);
  }

  function appendMessage(text, sender) {
    const body = document.getElementById('ace-widget-body');
    const msg = document.createElement('div');
    msg.className = \`ace-widget-message \${sender}\`;
    msg.textContent = text;
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
  }

  function showTyping() {
    const body = document.getElementById('ace-widget-body');
    const msg = document.createElement('div');
    msg.className = 'ace-widget-message ai';
    msg.id = 'ace-typing-indicator';
    msg.innerHTML = '<div class="ace-widget-typing"><span></span><span></span><span></span></div>';
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
  }

  function hideTyping() {
    const ind = document.getElementById('ace-typing-indicator');
    if (ind) ind.remove();
  }

  async function loadHistory() {
    if (!contactData) return;
    try {
      const qs = apiKey ? \`apiKey=\${apiKey}&sessionId=\${sessionId}\` : \`orgId=\${orgId}&sessionId=\${sessionId}\`;
      const res = await fetch(\`\${apiUrl}/api/widget/history?\${qs}\`);
      if (res.ok) {
        const history = await res.json();
        const body = document.getElementById('ace-widget-body');
        body.innerHTML = '';
        if (history.length === 0) {
          appendMessage(config.welcomeMessage, 'ai');
        } else {
          history.forEach(m => {
            appendMessage(m.content, m.sender === 'CUSTOMER' ? 'customer' : 'ai');
          });
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  function renderLeadForm() {
    const body = document.getElementById('ace-widget-body');
    body.innerHTML = \`
      <div style="margin-bottom:16px; font-size:14px; color:#333;">Please introduce yourself to start chatting:</div>
      <div class="ace-widget-form">
        <input type="text" id="ace-form-name" placeholder="Full Name" />
        <input type="email" id="ace-form-email" placeholder="Email Address" />
        <input type="text" id="ace-form-phone" placeholder="Phone Number" />
        <button id="ace-form-submit">Start Chat</button>
      </div>
    \`;
    document.getElementById('ace-widget-footer').style.display = 'none';

    document.getElementById('ace-form-submit').addEventListener('click', () => {
      const name = document.getElementById('ace-form-name').value;
      const email = document.getElementById('ace-form-email').value;
      const phone = document.getElementById('ace-form-phone').value;
      if (name || email || phone) {
        contactData = { name, email, phone };
        localStorage.setItem('ace_widget_contact', JSON.stringify(contactData));
        document.getElementById('ace-widget-footer').style.display = 'flex';
        body.innerHTML = '';
        appendMessage(config.welcomeMessage, 'ai');
      }
    });
  }

  async function sendMessage() {
    const input = document.getElementById('ace-widget-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    appendMessage(text, 'customer');
    showTyping();

    try {
      const res = await fetch(\`\${apiUrl}/api/widget/chat\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          orgId,
          sessionId,
          message: text,
          customerName: contactData?.name,
          customerEmail: contactData?.email,
          customerPhone: contactData?.phone
        })
      });
      const data = await res.json();
      hideTyping();
      if (data.reply) {
        appendMessage(data.reply, 'ai');
      }
    } catch (e) {
      hideTyping();
      appendMessage('Sorry, I encountered an error. Please try again later.', 'ai');
    }
  }

  function setupInteractions() {
    const launcher = document.getElementById('ace-widget-launcher');
    const modal = document.getElementById('ace-widget-modal');
    const closeBtn = document.getElementById('ace-widget-close');
    
    launcher.addEventListener('click', () => {
      modal.classList.toggle('open');
      if (modal.classList.contains('open')) {
        if (!contactData) {
          renderLeadForm();
        } else {
          document.getElementById('ace-widget-footer').style.display = 'flex';
          loadHistory();
        }
      }
    });

    closeBtn.addEventListener('click', () => {
      modal.classList.remove('open');
    });

    const sendBtn = document.getElementById('ace-widget-send');
    const input = document.getElementById('ace-widget-input');
    
    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    const voiceToggle = document.getElementById('ace-voice-toggle');
    const voicePanel = document.getElementById('ace-voice-panel');
    const body = document.getElementById('ace-widget-body');
    const footer = document.getElementById('ace-widget-footer');
    const voiceEnd = document.getElementById('ace-voice-end');

    if (voiceToggle) {
      voiceToggle.addEventListener('click', () => {
        voicePanel.classList.add('active');
        body.style.display = 'none';
        footer.style.display = 'none';
      });
    }

    if (voiceEnd) {
      voiceEnd.addEventListener('click', () => {
        voicePanel.classList.remove('active');
        body.style.display = 'flex';
        if (contactData) footer.style.display = 'flex';
      });
    }
  }

  async function init() {
    await fetchConfig();
    injectStyles();
    renderHTML();
    setupInteractions();
  }

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
