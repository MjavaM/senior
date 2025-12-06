﻿﻿// --------- Config ---------
const API_BASE = localStorage.getItem("ASKUNI_API") || window.location.origin;
const EMAIL_REGEX = /^\d{9}@stu\.uob\.edu\.bh$/i;
const q = (sel) => document.querySelector(sel);

// Navbar controls
const themeSelect = q("#themeSelect");
const bgMode = q("#bgMode");
const bgColorRow = q("#bgColorRow");
const bgColor = q("#bgColor");
const applyBg = q("#applyBg");
const clearBg = q("#clearBg");

// Sidebar / user
const loginBtn = q("#loginBtn");
const logoutBtn = q("#logoutBtn");
const userCard = { avatar: q("#userAvatar"), name: q("#userName"), id: q("#userId") };
const serverStatus = q("#serverStatus");
const modelName = q("#modelName");
const historyList = q("#historyList");
const newChatBtn = q("#newChatBtn");

// Chat
const chatEl = q("#chat");
const emptyEl = q("#emptyState");
const msgInput = q("#messageInput");
const sendBtn = q("#sendBtn");
const fileInput = q("#fileInput");
const micBtn = q("#micBtn");

// Modal
const loginModal = q("#loginModal");
const firstNameEl = q("#firstName");
const lastNameEl = q("#lastName");
const emailEl = q("#email");
const passwordEl = q("#password");
const password2El = q("#password2");
const loginEmailEl = q("#loginEmail");
const loginPasswordEl = q("#loginPassword");
const tabRegister = q("#tabRegister");
const tabLogin = q("#tabLogin");
const cancelAuth = q("#cancelAuth");
const registerFields = q("#registerFields");
const loginFields = q("#loginFields");
const forgotFields = q("#forgotFields");
const authTitle = q("#authTitle");
const authSub = q("#authSub");
const confirmAuth = q("#confirmAuth");

// Forgot-password refs
const forgotLink = q("#forgotLink");
const resetEmailEl = q("#resetEmail");
const resetPassEl = q("#resetPass");
const resetPass2El = q("#resetPass2");
const doResetBtn = q("#doReset");

let state = {
  token: localStorage.getItem("ASKUNI_TOKEN") || null,
  user: JSON.parse(localStorage.getItem("ASKUNI_USER") || "null"),
  sessionId: localStorage.getItem("ASKUNI_SESSION") || null,
  attachments: [],
  mode: "register",
};

function prompt(msg){ addMessage("bot","ℹ️ " + msg); }

// ------------- Markdown (safe subset) -------------
function esc(s = "") { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderMarkdownSafe(md = "") {
  md = String(md || "").replace(/\r\n?/g, "\n");
  const codeStore = [];
  md = md.replace(/```([\s\S]*?)```/g, (_, code) => {
    const i = codeStore.push(esc(code)) - 1;
    return `@@CODE_${i}@@`;
  });
  md = esc(md);
  md = md.replace(/^###\s+(.*)$/gm, "<h4>$1</h4>");
  md = md.replace(/^##\s+(.*)$/gm, "<h3>$1</h3>");
  md = md.replace(/^#\s+(.*)$/gm, "<h2>$1</h2>");
  md = md.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/\*(.+?)\*/g, "<em>$1</em>");
  md = md.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  md = md.replace(/(^|\n)(?:[-*]\s+.+(?:\n[-*]\s+.+)*)/g,(block, lead)=>{
    const items = block.trim().split("\n").map(l=>l.replace(/^[-*]\s+/, "").trim()).map(li=>`<li>${li}</li>`).join("");
    return `${lead}<ul>${items}</ul>`;
  });
  md = md.replace(/(^|\n)(?:\d+\.\s+.+(?:\n\d+\.\s+.+)*)/g,(block, lead)=>{
    const items = block.trim().split("\n").map(l=>l.replace(/^\d+\.\s+/, "").trim()).map(li=>`<li>${li}</li>`).join("");
    return `${lead}<ol>${items}</ol>`;
  });
  md = md.replace(/((?:^.*\|.*\n){2,})/gm,(block)=>{
    const lines = block.trim().split("\n");
    if (!lines.every(l=>l.includes("|"))) return block;
    let rows = lines;
    if (rows[1] && /^\s*\|?\s*:?-{2,}/.test(rows[1])) rows = [rows[0], ...rows.slice(2)];
    const htmlRows = rows.map((line, idx)=>{
      const cells = line.split("|").map(c=>c.trim()).filter(Boolean);
      if (cells.length < 2) return null;
      const tag = idx===0 ? "th":"td";
      return `<tr>${cells.map(c=>`<${tag}>${c}</${tag}>`).join("")}</tr>`;
    }).filter(Boolean).join("");
    return htmlRows ? `<div class="table-wrap"><table>${htmlRows}</table></div>` : block;
  });
  md = md.replace(/\n{2,}/g, "</p><p>");
  md = `<p>${md}</p>`;
  md = md.replace(/@@CODE_(\d+)@@/g,(_,i)=>`<pre><code>${codeStore[Number(i)]}</code></pre>`);
  return md;
}
// -------------------------------------------------

// Theme / background - FIXED: Separate theme from background color
function setTheme(v){
  if (v==="system"){
    const m = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", m?"dark":"light");
  } else {
    document.documentElement.setAttribute("data-theme", v);
  }
  localStorage.setItem("ASKUNI_THEME", v);
}

function updateBgRows(){ 
  const mode = bgMode.value; 
  bgColorRow.style.display = mode==="color" ? "" : "none"; 
}

// FIXED: Background settings that don't interfere with theme
function applyBackgroundSettings(){
  const mode = bgMode.value;
  if (mode==="color"){
    const color = bgColor.value || "#0b0f14";
    // Apply the color directly to the html element's style
    document.documentElement.style.backgroundColor = color;
    document.documentElement.style.backgroundImage = "none";
    localStorage.setItem("ASKUNI_BG_MODE","color");
    localStorage.setItem("ASKUNI_BG_COLOR", color);
  } else {
    // Clear custom background
    document.documentElement.style.backgroundColor = "";
    document.documentElement.style.backgroundImage = "";
    localStorage.setItem("ASKUNI_BG_MODE","none");
    localStorage.removeItem("ASKUNI_BG_COLOR");
  }
  updateBgRows();
}

function clearBackgroundSettings(){ 
  bgMode.value="none"; 
  bgColor.value="#0b0f14"; 
  document.documentElement.style.backgroundColor = "";
  document.documentElement.style.backgroundImage = "";
  localStorage.setItem("ASKUNI_BG_MODE","none");
  localStorage.removeItem("ASKUNI_BG_COLOR");
  updateBgRows(); 
}

themeSelect.addEventListener("change",()=> setTheme(themeSelect.value));
bgMode.addEventListener("change", updateBgRows);
applyBg.addEventListener("click", applyBackgroundSettings);
clearBg.addEventListener("click", clearBackgroundSettings);

// API wrapper
async function api(path, opts={}){
  const headers = Object.assign({ "Content-Type":"application/json" }, opts.headers || {});
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  let json; try{ json = await res.json(); } catch { json = { ok:false, error:"Invalid server response" }; }
  if (!res.ok){ const msg = [json.error || res.statusText, json.detail].filter(Boolean).join(": "); throw new Error(msg || "Request failed"); }
  return json;
}

// Health
async function checkHealth(){
  try{
    const r = await api("/api/health",{ method:"GET", headers:{} });
    serverStatus.textContent = r.status || "online";
    modelName.textContent = r.assistant_id ? `asst: ${String(r.assistant_id).slice(6,12)}…` : "assistant";
  }catch{
    serverStatus.textContent = "offline";
    modelName.textContent = "—";
  }
}

// UI helpers
function addMessage(role, text){
  emptyEl.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;
  const avatar = `<div class="avatar">${role==="user" ? "🙋" : "🤖"}</div>`;
  const inner = role==="bot" ? renderMarkdownSafe(text || "") : esc(text || "");
  wrap.innerHTML = `${avatar}<div class="bubble">${inner}</div>`;
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
}
function addStreamingBubble(){
  emptyEl.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = `message bot`;
  wrap.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">
      <div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span> Thinking…</div>
      <pre class="stream"></pre>
    </div>`;
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;

  const streamPre = wrap.querySelector(".stream");
  let full = "";
  return {
    append(piece){ full += piece; streamPre.textContent = full; chatEl.scrollTop = chatEl.scrollHeight; },
    finalize(){ wrap.querySelector(".bubble").innerHTML = renderMarkdownSafe(full || "(empty)"); chatEl.scrollTop = chatEl.scrollHeight; },
    abort(err){ streamPre.textContent += `\n\n[stream aborted: ${err}]`; }
  };
}
function clearChat(){
  chatEl.innerHTML = `<div class="chat__empty" id="emptyState"></div>`;
}

// User UI
function updateUserUI(){
  const loggedIn = !!(state.user && state.user.email && state.token);
  if (loggedIn){
    const initials = (state.user.first_name?.[0] || state.user.firstName?.[0] || "U") +
                     (state.user.last_name?.[0]  || state.user.lastName?.[0]  || "");
    userCard.avatar.textContent = initials.toUpperCase();
    const fn = state.user.first_name || state.user.firstName || "";
    const ln = state.user.last_name || state.user.lastName || "";
    userCard.name.textContent = `${fn} ${ln}`.trim() || "Student";
    userCard.id.textContent = state.user.email;
    loginBtn.hidden = true; logoutBtn.hidden = false;
  } else {
    userCard.avatar.textContent = "G";
    userCard.name.textContent = "Guest";
    userCard.id.textContent = "Not signed in";
    loginBtn.hidden = false; logoutBtn.hidden = true;
  }
}

// History (only when logged in)
function renderHistory(sessions, targetList = null){
  const target = targetList || historyList;
  target.innerHTML = "";
  
  // Show history section even if empty when logged in
  if (state.token) {
    if (!sessions || sessions.length === 0) {
      const li = document.createElement("li");
      li.className = "history-item";
      li.innerHTML = '<span class="muted" style="padding:8px;display:block;text-align:center">No chat history yet</span>';
      target.appendChild(li);
    } else {
      sessions.forEach((s)=>{
        const li = document.createElement("li"); li.className = "history-item";
        const btn = document.createElement("button"); btn.className = "title"; btn.textContent = s.title || s.session_id; btn.dataset.id = s.session_id;
        if (state.sessionId === s.session_id) btn.classList.add("active");
        btn.addEventListener("click", ()=> {
          openSession(s.session_id);
          // Close mobile menu after selection
          if (window.innerWidth <= 1024) {
            mobileMenuOverlay.classList.remove('active');
            document.body.style.overflow = '';
          }
        });

        const del = document.createElement("button"); del.className="del"; del.title="Delete session"; del.textContent = "🗑️";
        del.addEventListener("click", async (ev)=>{
          ev.stopPropagation();
          if (!confirm("Delete this chat session?")) return;
          try{ await api(`/chats/${s.session_id}`, { method:"DELETE" }); loadHistory(); if (state.sessionId===s.session_id){ state.sessionId=null; localStorage.removeItem("ASKUNI_SESSION"); clearChat(); } }
          catch(e){ alert(e.message || "Failed to delete"); }
        });

        li.appendChild(btn); li.appendChild(del); target.appendChild(li);
      });
    }
  } else {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = '<span class="muted" style="padding:8px;display:block;text-align:center">Sign in to see chat history</span>';
    target.appendChild(li);
  }
}

async function loadHistory(){
  const mobileHistoryList = document.getElementById('mobileHistoryList');
  
  if (!state.token) { 
    historyList.innerHTML = '<li class="history-item"><span class="muted" style="padding:8px;display:block;text-align:center">Sign in to see chat history</span></li>';
    if (mobileHistoryList) {
      mobileHistoryList.innerHTML = '<li class="history-item"><span class="muted" style="padding:8px;display:block;text-align:center">Sign in to see chat history</span></li>';
    }
    return; 
  }
  try{ 
    const r = await api("/chats"); 
    if (r.ok) {
      renderHistory(r.sessions || []);
      // Also render directly to mobile history
      if (mobileHistoryList) {
        renderHistory(r.sessions || [], mobileHistoryList);
      }
    } 
  } catch (e){ 
    console.warn("history error:", e.message); 
    historyList.innerHTML = '<li class="history-item"><span class="muted" style="padding:8px;display:block;text-align:center">Error loading history</span></li>';
    if (mobileHistoryList) {
      mobileHistoryList.innerHTML = '<li class="history-item"><span class="muted" style="padding:8px;display:block;text-align:center">Error loading history</span></li>';
    }
  }
}

async function openSession(sessionId){
  try{
    const r = await api(`/chats/${sessionId}`);
    state.sessionId = sessionId; localStorage.setItem("ASKUNI_SESSION", state.sessionId);
    // Refresh both desktop and mobile history
    await loadHistory();
    clearChat();
    (r.messages || []).forEach(m=> addMessage(m.role==="user" ? "user" : "bot", m.text));
  }catch(e){ addMessage("bot", "❌ Could not open session: " + e.message); }
}

newChatBtn.addEventListener("click", ()=>{ 
  state.sessionId=null; 
  localStorage.removeItem("ASKUNI_SESSION"); 
  clearChat(); 
  if (state.token) loadHistory();
});

// Auth modal modes
function setAuthMode(mode){
  state.mode = mode;
  const isReg = mode === "register";
  const isLogin = mode === "login";
  const isForgot = mode === "forgot";

  registerFields.style.display = isReg ? "" : "none";
  loginFields.style.display = isLogin ? "" : "none";
  forgotFields.style.display = isForgot ? "" : "none";

  authTitle.textContent = isReg ? "Create account" : isForgot ? "Reset your password" : "Sign in";
  authSub.textContent = isReg
    ? "First time? Use your UoB student email (e.g. 202012345@stu.uob.edu.bh)."
    : isForgot ? "Enter your UoB email and new password." : "Welcome back.";

  tabRegister.classList.toggle("primary", isReg);
  tabLogin.classList.toggle("primary", isLogin);
}

tabRegister.addEventListener("click", ()=> setAuthMode("register"));
tabLogin.addEventListener("click", ()=> setAuthMode("login"));
loginBtn.addEventListener("click", ()=>{ setAuthMode("register"); loginModal.showModal(); });
cancelAuth.addEventListener("click", ()=> loginModal.close());
logoutBtn.addEventListener("click", ()=>{
  state.user=null; state.token=null; state.sessionId=null;
  localStorage.removeItem("ASKUNI_USER"); localStorage.removeItem("ASKUNI_TOKEN"); localStorage.removeItem("ASKUNI_SESSION");
  updateUserUI(); 
  loadHistory(); // This will show "Sign in to see chat history"
  clearChat();
});

confirmAuth.addEventListener("click", async (e)=>{
  e.preventDefault();
  try{
    if (state.mode==="register"){
      const firstName = firstNameEl.value.trim();
      const lastName = lastNameEl.value.trim();
      const email = emailEl.value.trim();
      const password = passwordEl.value;
      const password2 = password2El.value;
      if (!EMAIL_REGEX.test(email)) return alert("Use your UoB email (e.g. 202012345@stu.uob.edu.bh).");
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return alert("Password must be at least 8 characters and include letters and numbers.");
      if (password !== password2) return alert("Passwords do not match.");
      const r = await api("/auth/register",{ method:"POST", body: JSON.stringify({ firstName,lastName,email,password }) });
      if (!r.ok) throw new Error(r.error || "Register failed");
      state.user = r.user; state.token = r.token;
    } else if (state.mode==="login"){
      const email = loginEmailEl.value.trim();
      const password = loginPasswordEl.value;
      if (!EMAIL_REGEX.test(email)) return alert("Invalid UoB email.");
      if (!password) return alert("Enter your password.");
      const r = await api("/auth/login",{ method:"POST", body: JSON.stringify({ email,password }) });
      if (!r.ok) throw new Error(r.error || "Login failed");
      state.user = r.user; state.token = r.token;
    } else {
      // forgot mode uses dedicated button below
      return;
    }
    localStorage.setItem("ASKUNI_USER", JSON.stringify(state.user));
    localStorage.setItem("ASKUNI_TOKEN", state.token);
    updateUserUI(); 
    await loadHistory(); 
    loginModal.close(); 
    addMessage("bot","✅ Signed in.");
  }catch(err){ alert(err.message || "Authentication error."); }
});

if (forgotLink) forgotLink.addEventListener("click", ()=> setAuthMode("forgot"));

if (doResetBtn) doResetBtn.addEventListener("click", async ()=>{
  const email = (resetEmailEl.value || "").trim();
  const p1 = resetPassEl.value || "";
  const p2 = resetPass2El.value || "";
  if (!EMAIL_REGEX.test(email)) { alert("Enter your UoB email."); return; }
  if (p1 !== p2) { alert("Passwords do not match."); return; }
  if (!(p1.length >= 8 && /[A-Za-z]/.test(p1) && /\d/.test(p1))) { 
    alert("Password must be ≥8 and include letters & numbers."); 
    return; 
  }
  try{
    await api("/auth/reset",{ method:"POST", body: JSON.stringify({ email, newPassword:p1 }) });
    alert("Password updated. Please sign in.");
    setAuthMode("login"); 
    loginEmailEl.value=email; 
    loginPasswordEl.value="";
  }catch(e){ alert(e.message || "Reset failed."); }
});

// Upload
fileInput.addEventListener("change", async ()=>{
  if (!fileInput.files?.length) return;
  const file = fileInput.files[0];
  const form = new FormData(); form.append("file", file);
  addMessage("bot", "📎 Uploading attachment…");
  try{
    const res = await fetch(`${API_BASE}/upload`, { method:"POST", body: form, headers: state.token ? { "Authorization":"Bearer " + state.token } : {} });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Upload failed");
    state.attachments.push(json.attachment);
    addMessage("bot", `✅ Attached: ${file.name}`);
  }catch(e){ addMessage("bot", "❌ Upload failed: " + e.message); }
  finally{ fileInput.value=""; }
});

// Send (STREAM – guest allowed)
async function sendMessageStreaming(textOverride=null, opts={alreadyEchoed:false}){
  const inputText = (textOverride ?? msgInput.value).trim();
  if (!inputText && !state.attachments.length) return;
  if (!opts.alreadyEchoed) addMessage("user", inputText || "📎 (attachments only)");
  msgInput.value = "";

  const bubble = addStreamingBubble();
  try{
    const res = await fetch(`${API_BASE}/message/stream`,{
      method:"POST",
      headers: { "Content-Type":"application/json", ...(state.token ? { "Authorization":"Bearer "+state.token } : {}) },
      body: JSON.stringify({ message:inputText, attachments: state.attachments, sessionId: state.sessionId })
    });

    if (!res.ok || !res.body){
      // fallback
      const r = await api("/message",{ method:"POST", body: JSON.stringify({ message:inputText, attachments:state.attachments, sessionId:state.sessionId }) });
      if (r.ok){
        state.sessionId = r.sessionId || state.sessionId; localStorage.setItem("ASKUNI_SESSION", state.sessionId);
        bubble.append(r.message); bubble.finalize(); state.attachments = []; await loadHistory();
      } else { bubble.abort(r.error || "Assistant error"); }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const processLines = (chunk)=>{
      buf += chunk;
      const parts = buf.split("\n\n"); buf = parts.pop() || "";
      for (const block of parts){
        const line = block.trim(); if (!line) continue;
        const evm = line.match(/^event:\s*(\w+)\s*[\r\n]+data:(.*)$/s);
        if (!evm) continue;
        const type = evm[1]; const data = evm[2].trim();
        try{
          const payload = JSON.parse(data);
          if (type==="delta" && payload.t) bubble.append(payload.t);
          else if (type==="final"){
            state.sessionId = payload.sessionId || state.sessionId; localStorage.setItem("ASKUNI_SESSION", state.sessionId);
            bubble.finalize(); state.attachments=[]; loadHistory();
          } else if (type==="error"){ bubble.abort(payload.error || "stream error"); }
        }catch{}
      }
    };

    for(;;){
      const { value, done } = await reader.read();
      if (done) break;
      processLines(decoder.decode(value,{stream:true}));
    }
  }catch(err){ bubble.abort(err.message || "stream failed"); }
}

sendBtn.addEventListener("click", ()=> sendMessageStreaming());
msgInput.addEventListener("keydown", (e)=>{ if ((e.ctrlKey || e.metaKey) && e.key==="Enter") sendMessageStreaming(); });

// Mic — simplified, click-to-toggle, with Arabic auto-detect hint
let mediaStream=null, recorder=null, chunks=[], isRecording=false, autoStopTimer=null;

function langHint(){
  const nav = (navigator.language || navigator.languages?.[0] || "").toLowerCase();
  return nav.startsWith("ar") ? "ar" : "auto";
}

async function startMic(){
  if (isRecording) return; // guard
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    recorder = new MediaRecorder(mediaStream,{ mimeType:"audio/webm" });
    chunks=[];
    recorder.ondataavailable=(e)=>{ if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onMicStop;
    isRecording = true; micBtn.classList.add("recording");
    addMessage("bot","🎤 Recording… click the mic again to stop.");
    recorder.start();
    autoStopTimer = setTimeout(()=>{ if (isRecording) stopMic(); }, 60000);
  }catch{
    addMessage("bot","⚠️ Microphone permission denied or not available.");
  }
}

function stopMic(){ 
  try{ if (recorder && recorder.state!=="inactive") recorder.stop(); } finally { /* onMicStop will clean up */ }
}

async function onMicStop(){
  try{
    const blob = new Blob(chunks,{ type:"audio/webm" });
    if (!blob.size){ addMessage("bot","⚠️ No audio captured."); return; }
    const form = new FormData(); form.append("audio", blob, "speech.webm");
    addMessage("bot","🎙️ Transcribing…");
    const headers = { ...(state.token ? { "Authorization":"Bearer "+state.token } : {}), "X-Lang": langHint() };
    const res = await fetch(`${API_BASE}/stt`,{ method:"POST", headers, body: form });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "STT failed");
    const text = (json.text || "").trim();
    if (text){ await sendMessageStreaming(text,{alreadyEchoed:false}); } else { addMessage("bot","⚠️ No speech detected."); }
  }catch(err){ addMessage("bot","❌ STT failed: " + (err.message || err)); }
  finally{
    if (mediaStream) mediaStream.getTracks().forEach(t=>t.stop());
    mediaStream=null; isRecording=false; clearTimeout(autoStopTimer); micBtn.classList.remove("recording");
  }
}

micBtn.addEventListener("click", ()=>{ isRecording ? stopMic() : startMic(); });

// Hamburger menu functionality
const burgerMenu = document.getElementById('burgerMenu');
const closeMenu = document.getElementById('closeMenu');
const mobileMenuOverlay = document.getElementById('mobileMenuOverlay');

// Toggle menu with hamburger icon animation
burgerMenu.addEventListener('click', () => {
  mobileMenuOverlay.classList.add('active');
  burgerMenu.classList.add('active');
  document.body.style.overflow = 'hidden';
});

closeMenu.addEventListener('click', () => {
  mobileMenuOverlay.classList.remove('active');
  burgerMenu.classList.remove('active');
  document.body.style.overflow = '';
});

// Close menu when clicking on overlay (outside menu)
mobileMenuOverlay.addEventListener('click', (e) => {
  if (e.target === mobileMenuOverlay) {
    mobileMenuOverlay.classList.remove('active');
    burgerMenu.classList.remove('active');
    document.body.style.overflow = '';
  }
});

// Close menu with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mobileMenuOverlay.classList.contains('active')) {
    mobileMenuOverlay.classList.remove('active');
    burgerMenu.classList.remove('active');
    document.body.style.overflow = '';
  }
});

// Function to sync user data between desktop sidebar and mobile menu
function syncMobileMenuUserData() {
  // Sync user info
  const desktopAvatar = document.getElementById('userAvatar');
  const mobileAvatar = document.getElementById('mobileUserAvatar');
  if (desktopAvatar && mobileAvatar) {
    mobileAvatar.textContent = desktopAvatar.textContent;
  }
  
  const desktopName = document.getElementById('userName');
  const mobileName = document.getElementById('mobileUserName');
  if (desktopName && mobileName) {
    mobileName.textContent = desktopName.textContent;
  }
  
  const desktopId = document.getElementById('userId');
  const mobileId = document.getElementById('mobileUserId');
  if (desktopId && mobileId) {
    mobileId.textContent = desktopId.textContent;
  }
  
  // Sync login/logout buttons
  const desktopLoginBtn = document.getElementById('loginBtn');
  const mobileLoginBtn = document.getElementById('mobileLoginBtn');
  const desktopLogoutBtn = document.getElementById('logoutBtn');
  const mobileLogoutBtn = document.getElementById('mobileLogoutBtn');
  
  if (desktopLoginBtn && mobileLoginBtn) {
    mobileLoginBtn.hidden = desktopLoginBtn.hidden;
  }
  if (desktopLogoutBtn && mobileLogoutBtn) {
    mobileLogoutBtn.hidden = desktopLogoutBtn.hidden;
  }
  
  // Sync server status
  const desktopStatus = document.getElementById('serverStatus');
  const mobileStatus = document.getElementById('mobileServerStatus');
  if (desktopStatus && mobileStatus) {
    mobileStatus.textContent = desktopStatus.textContent;
  }
  
  const desktopModel = document.getElementById('modelName');
  const mobileModel = document.getElementById('mobileModelName');
  if (desktopModel && mobileModel) {
    mobileModel.textContent = desktopModel.textContent;
  }
}

// Run sync when window loads and when user data updates
window.addEventListener('load', () => {
  syncMobileMenuUserData();
  loadHistory(); // This will load history for both desktop and mobile
});

// Set up event listeners for mobile menu buttons
document.getElementById('mobileLoginBtn')?.addEventListener('click', () => {
  document.getElementById('loginBtn')?.click();
  mobileMenuOverlay.classList.remove('active');
  burgerMenu.classList.remove('active');
  document.body.style.overflow = '';
});

document.getElementById('mobileLogoutBtn')?.addEventListener('click', () => {
  document.getElementById('logoutBtn')?.click();
  mobileMenuOverlay.classList.remove('active');
  burgerMenu.classList.remove('active');
  document.body.style.overflow = '';
});

document.getElementById('mobileNewChatBtn')?.addEventListener('click', () => {
  document.getElementById('newChatBtn')?.click();
  mobileMenuOverlay.classList.remove('active');
  burgerMenu.classList.remove('active');
  document.body.style.overflow = '';
});

// Set up quick links in mobile menu
const mobileLinks = document.querySelectorAll('.mobile-menu-content .quicklinks a');
mobileLinks.forEach(link => {
  link.addEventListener('click', () => {
    mobileMenuOverlay.classList.remove('active');
    burgerMenu.classList.remove('active');
    document.body.style.overflow = '';
  });
});

// Update user UI also updates mobile menu
const originalUpdateUserUI = updateUserUI;
updateUserUI = function() {
  originalUpdateUserUI();
  syncMobileMenuUserData();
};

// Init - FIXED: Apply saved background color
(function init(){
  const savedTheme = localStorage.getItem("ASKUNI_THEME") || "light"; 
  setTheme(savedTheme); 
  themeSelect.value = savedTheme;
  
  const mode = localStorage.getItem("ASKUNI_BG_MODE") || "none"; 
  bgMode.value = mode;
  
  if (mode==="color") {
    bgColor.value = localStorage.getItem("ASKUNI_BG_COLOR") || "#0b0f14";
    // Apply the saved background color
    document.documentElement.style.backgroundColor = bgColor.value;
    document.documentElement.style.backgroundImage = "none";
  }
  
  updateBgRows();

  updateUserUI(); 
  checkHealth();
  loadHistory(); // Always load history to show appropriate message
  
  if (state.token){ 
    api("/auth/me").then(loadHistory).catch(()=>{}); 
  }
})();