// script.js — works on localhost + Render automatically (auto API base + fallback)

// Auto-detect API endpoint:
// - Same-origin when the API serves the page (Render or node server on :3000)
// - http://localhost:3000 when opened via Live Server/Vite (5500/5173/etc) or file://
// - Override anytime: localStorage.setItem('ASKUNI_API','https://your-api.onrender.com')
const DEFAULT_LOCAL_API = "http://localhost:3000";
const API_BASE = (() => {
  const override = (localStorage.getItem("ASKUNI_API") || "").trim();
  if (override) return override;

  // If file:// or typical dev ports, use local API
  const proto = location.protocol;
  const host = location.host || "";
  if (proto === "file:") return DEFAULT_LOCAL_API;
  if (/:(5500|5173|5174|3001|8080|1234|4200|8000)$/.test(host)) return DEFAULT_LOCAL_API;

  // Otherwise same-origin (works on Render or when node serves index.html)
  return "";
})();

const EMAIL_REGEX = /^\d{9}@stu\.uob\.edu\.bh$/i;
const q = (sel) => document.querySelector(sel);

// Topbar
const themeSelect = q("#themeSelect");
const bgMode = q("#bgMode");
const bgColorRow = q("#bgColorRow");
const bgUrlRow = q("#bgUrlRow");
const bgColor = q("#bgColor");
const bgUrl = q("#bgUrl");
const applyBg = q("#applyBg");
const clearBg = q("#clearBg");

// Sidebar
const loginBtn = q("#loginBtn");
const logoutBtn = q("#logoutBtn");
const userCard = { avatar: q("#userAvatar"), name: q("#userName"), id: q("#userId") };
const serverStatus = q("#serverStatus");
const modelName = q("#modelName");
const historyList = q("#historyList");
const newChatBtn = q("#newChatBtn");

// Main
const chatEl = q("#chat");
const emptyEl = q("#emptyState"); // may be null
const msgInput = q("#messageInput");
const sendBtn = q("#sendBtn");
const fileInput = q("#fileInput");
const micBtn = q("#micBtn");

// Auth modal
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
const registerFields = q("#registerFields");
const loginFields = q("#loginFields");
const authTitle = q("#authTitle");
const authSub = q("#authSub");
const confirmAuth = q("#confirmAuth");

// State
let state = {
  token: localStorage.getItem("ASKUNI_TOKEN") || null,
  user: JSON.parse(localStorage.getItem("ASKUNI_USER") || "null"),
  sessionId: localStorage.getItem("ASKUNI_SESSION") || null,
  attachments: [],
  mode: "register",
};

// Modal helpers (works even if <dialog> unsupported)
function openModal() { if (loginModal?.showModal) loginModal.showModal(); else { loginModal.setAttribute("open",""); loginModal.style.display="block"; } }
function closeModal(){ if (loginModal?.close) loginModal.close(); loginModal.removeAttribute("open"); loginModal.style.display="none"; }

// Only hint login if a real token expired (don’t nag guests)
const AUTO_OPEN_LOGIN_ON_401 = false;
function promptLogin(reason="Please sign in to continue.") {
  addMessage("bot", "🔐 " + reason + " Click the Login button.");
  try { loginBtn.classList.add("pulse"); setTimeout(()=>loginBtn.classList.remove("pulse"), 4000); } catch {}
}

/* -------- Markdown (safe subset) -------- */
function esc(s=""){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function renderMarkdownSafe(md=""){
  md = String(md||"").replace(/\r\n?/g,"\n");
  const codeStore=[];
  md = md.replace(/```([\s\S]*?)```/g,(_,c)=>`@@CODE_${codeStore.push(esc(c))-1}@@`);
  md = esc(md);
  md = md.replace(/^###\s+(.*)$/gm,"<h4>$1</h4>")
         .replace(/^##\s+(.*)$/gm,"<h3>$1</h3>")
         .replace(/^#\s+(.*)$/gm,"<h2>$1</h2>")
         .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
         .replace(/\*(.+?)\*/g,"<em>$1</em>")
         .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  md = md.replace(/(^|\n)(?:[-*]\s+.+(?:\n[-*]\s+.+)*)/g,(b,l)=>`${l}<ul>${b.trim().split("\n").map(x=>`<li>${x.replace(/^[-*]\s+/,"").trim()}</li>`).join("")}</ul>`);
  md = md.replace(/(^|\n)(?:\d+\.\s+.+(?:\n\d+\.\s+.+)*)/g,(b,l)=>`${l}<ol>${b.trim().split("\n").map(x=>`<li>${x.replace(/^\d+\.\s+/,"").trim()}</li>`).join("")}</ol>`);
  md = md.replace(/((?:^.*\|.*\n){2,})/gm,(block)=>{
    const lines = block.trim().split("\n"); if(!lines.every(l=>l.includes("|"))) return block;
    let rows=lines; if(rows[1]&&/^\s*\|?\s*:?-{2,}/.test(rows[1])) rows=[rows[0],...rows.slice(2)];
    const html = rows.map((line,i)=>{const cells=line.split("|").map(c=>c.trim()).filter(Boolean); if(cells.length<2) return null; const tag=i? "td":"th"; return `<tr>${cells.map(c=>`<${tag}>${c}</${tag}>`).join("")}</tr>`;}).filter(Boolean).join("");
    return html? `<div class="table-wrap"><table>${html}</table></div>`:block;
  });
  md = `<p>${md.replace(/\n{2,}/g,"</p><p>")}</p>`;
  return md.replace(/@@CODE_(\d+)@@/g,(_,i)=>`<pre><code>${codeStore[+i]}</code></pre>`);
}

/* -------- Theme & background -------- */
function setTheme(v){document.documentElement.setAttribute("data-theme",v);localStorage.setItem("ASKUNI_THEME",v);}
function updateBgRows(){const m=bgMode.value; bgColorRow.style.display=m==="color"?"":"none"; bgUrlRow.style.display=m==="image"?"":"none";}
function applyBackgroundSettings(){
  const m=bgMode.value;
  if(m==="color"){
    const c=bgColor.value||"#0b0f14";
    document.documentElement.style.setProperty("--bg",c);
    document.documentElement.style.setProperty("--bg-image","none");
    document.body.style.removeProperty("background-image");
    localStorage.setItem("ASKUNI_BG_MODE","color");
    localStorage.setItem("ASKUNI_BG_COLOR",c);
    localStorage.removeItem("ASKUNI_BG_IMAGE");
  }else if(m==="image"){
    let url=(bgUrl.value||"").trim();
    if(!url){alert("Paste a direct image URL or use /assets/bg.jpg"); return;}
    if(location.protocol==="https:" && url.startsWith("http://")){alert("Use https:// image URLs on https sites."); return;}
    const sep=url.includes("?")?"&":"?"; url=`${url}${sep}v=${Date.now()}`; // cache-bust
    document.documentElement.style.setProperty("--bg-image",`url("${url}")`);
    document.body.style.backgroundImage=`url("${url}")`;
    localStorage.setItem("ASKUNI_BG_MODE","image");
    localStorage.setItem("ASKUNI_BG_IMAGE",url);
    localStorage.removeItem("ASKUNI_BG_COLOR");
  }else{
    document.documentElement.style.setProperty("--bg-image","none");
    document.body.style.removeProperty("background-image");
    document.documentElement.style.removeProperty("--bg");
    localStorage.setItem("ASKUNI_BG_MODE","none");
    localStorage.removeItem("ASKUNI_BG_COLOR"); localStorage.removeItem("ASKUNI_BG_IMAGE");
  }
  updateBgRows();
}
function clearBackgroundSettings(){bgMode.value="none"; bgUrl.value=""; applyBackgroundSettings();}
themeSelect.addEventListener("change",()=>setTheme(themeSelect.value));
bgMode.addEventListener("change",updateBgRows);
applyBg.addEventListener("click",applyBackgroundSettings);
clearBg.addEventListener("click",clearBackgroundSettings);

/* -------- API helper with fallback -------- */
async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (state.token) headers["Authorization"] = "Bearer " + state.token;

  const candidates = API_BASE ? [API_BASE] : ["", DEFAULT_LOCAL_API];
  let lastErr;

  for (const base of candidates) {
    try {
      const res = await fetch(`${base}${path}`, { ...opts, headers });
      let json; try { json = await res.json(); } catch { json = { ok:false, error:"Invalid server response" }; }

      if (res.status === 401) {
        if (state.token && !opts.silent401) {
          state.user=null; state.token=null; state.sessionId=null;
          localStorage.removeItem("ASKUNI_USER"); localStorage.removeItem("ASKUNI_TOKEN"); localStorage.removeItem("ASKUNI_SESSION");
          updateUserUI();
          const msg = json.error || "Session expired. Please sign in again.";
          if (AUTO_OPEN_LOGIN_ON_401) openModal(); else promptLogin(msg);
        }
        const err = new Error(json.error || "Unauthorized"); err.code = 401; throw err;
      }
      if (!res.ok) { const msg=[json.error||res.statusText,json.detail].filter(Boolean).join(": "); throw new Error(msg||"Request failed"); }

      return json;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Network error");
}

/* -------- Health -------- */
async function checkHealth(){
  try{
    const r = await api("/api/health",{ method:"GET", headers:{} });
    serverStatus.textContent = r.status || "online";
    modelName.textContent = r.assistant_id ? `asst: ${r.assistant_id.slice(6,12)}…` : "assistant";
  }catch{ serverStatus.textContent="offline"; modelName.textContent="—"; }
}

/* -------- UI helpers -------- */
function addMessage(role,text){
  if (emptyEl) emptyEl.style.display="none";
  const wrap=document.createElement("div");
  wrap.className=`message ${role}`;
  const avatar=`<div class="avatar">${role==="user"?"🙋":"🤖"}</div>`;
  const inner= role==="bot"? renderMarkdownSafe(text||""): esc(text||"");
  wrap.innerHTML=`${avatar}<div class="bubble">${inner}</div>`;
  chatEl.appendChild(wrap); chatEl.scrollTop=chatEl.scrollHeight;
}
function addStreamingBubble(){
  if (emptyEl) emptyEl.style.display="none";
  const wrap=document.createElement("div");
  wrap.className=`message bot`;
  wrap.innerHTML=`
    <div class="avatar">🤖</div>
    <div class="bubble">
      <div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span> Thinking…</div>
      <pre class="stream"></pre>
    </div>`;
  chatEl.appendChild(wrap); chatEl.scrollTop=chatEl.scrollHeight;

  const streamPre=wrap.querySelector(".stream"); let full="";
  return {
    append(piece){ full+=piece; streamPre.textContent=full; chatEl.scrollTop=chatEl.scrollHeight; },
    finalize(){ wrap.querySelector(".bubble").innerHTML=renderMarkdownSafe(full||"(empty)"); chatEl.scrollTop=chatEl.scrollHeight; },
    abort(err){ streamPre.textContent+=`\n\n[stream aborted: ${err}]`; }
  };
}
function clearChat(){ if (chatEl) chatEl.innerHTML=""; }
function updateUserUI(){
  const loggedIn=!!(state.user&&state.user.email&&state.token);
  if (loggedIn){
    const initials=(state.user.first_name?.[0]||state.user.firstName?.[0]||"U")+(state.user.last_name?.[0]||state.user.lastName?.[0]||"");
    userCard.avatar.textContent=initials.toUpperCase();
    const fn=state.user.first_name||state.user.firstName||"", ln=state.user.last_name||state.user.lastName||"";
    userCard.name.textContent=`${fn} ${ln}`.trim()||"Student"; userCard.id.textContent=state.user.email;
    loginBtn.hidden=true; logoutBtn.hidden=false;
  }else{
    userCard.avatar.textContent="G"; userCard.name.textContent="Guest"; userCard.id.textContent="Not signed in";
    loginBtn.hidden=false; logoutBtn.hidden=true;
  }
  // Guest mode: keep composer usable
  msgInput.disabled=false; sendBtn.disabled=false; fileInput.disabled=false; micBtn.disabled=false;
}

/* -------- History (only when logged in) -------- */
function renderHistory(sessions){
  historyList.innerHTML=""; sessions.forEach((s)=>{ const li=document.createElement("li"); const btn=document.createElement("button"); btn.textContent=s.title||s.session_id; btn.dataset.id=s.session_id; if(state.sessionId===s.session_id) btn.classList.add("active"); btn.addEventListener("click",()=>openSession(s.session_id)); li.appendChild(btn); historyList.appendChild(li); });
}
async function loadHistory(){
  if(!state.token){ historyList.innerHTML=""; return; }
  try{ const r=await api("/chats",{ silent401:true }); if(r.ok) renderHistory(r.sessions||[]); }catch(e){ console.warn("history error:",e.message); }
}
async function openSession(sessionId){
  try{
    const r=await api(`/chats/${sessionId}`,{ silent401:true });
    state.sessionId=sessionId; localStorage.setItem("ASKUNI_SESSION",state.sessionId);
    renderHistory(await api("/chats",{ silent401:true }).then(j=>j.sessions||[]));
    clearChat(); (r.messages||[]).forEach(m=>addMessage(m.role==="user"?"user":"bot",m.text));
  }catch(e){ addMessage("bot","❌ Could not open session: "+e.message); }
}
newChatBtn.addEventListener("click",()=>{ state.sessionId=null; localStorage.removeItem("ASKUNI_SESSION"); clearChat(); });

/* -------- Auth -------- */
function setAuthMode(mode){
  state.mode=mode; const isReg=mode==="register";
  registerFields.style.display=isReg?"":"none"; loginFields.style.display=isReg?"none":"";
  authTitle.textContent=isReg?"Create account":"Sign in";
  authSub.textContent=isReg? "First time? Use your UoB email (e.g. 202012345@stu.uob.edu.bh)."
                           : "Welcome back. Sign in with your UoB email and password.";
  tabRegister.classList.toggle("primary",isReg); tabLogin.classList.toggle("primary",!isReg);
}
tabRegister.addEventListener("click",()=>setAuthMode("register"));
tabLogin.addEventListener("click",()=>setAuthMode("login"));
loginBtn.addEventListener("click",()=>{ setAuthMode("register"); openModal(); });
logoutBtn.addEventListener("click",()=>{
  state.user=null; state.token=null; state.sessionId=null;
  localStorage.removeItem("ASKUNI_USER"); localStorage.removeItem("ASKUNI_TOKEN"); localStorage.removeItem("ASKUNI_SESSION");
  updateUserUI(); renderHistory([]); clearChat();
});
document.querySelector("#cancelAuth").addEventListener("click",()=>closeModal());

confirmAuth.addEventListener("click",async(e)=>{
  e.preventDefault();
  try{
    if(state.mode==="register"){
      const firstName=firstNameEl.value.trim(), lastName=lastNameEl.value.trim(), email=emailEl.value.trim();
      const password=passwordEl.value, password2=password2El.value;
      if(!EMAIL_REGEX.test(email)) return alert("Use your UoB email (e.g. 202012345@stu.uob.edu.bh).");
      if(password.length<8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return alert("Password must be at least 8 characters and include letters and numbers.");
      if(password!==password2) return alert("Passwords do not match.");
      const r=await api("/auth/register",{ method:"POST", body:JSON.stringify({ firstName,lastName,email,password }) });
      if(!r.ok) throw new Error(r.error||"Register failed"); state.user=r.user; state.token=r.token;
    }else{
      const email=loginEmailEl.value.trim(), password=loginPasswordEl.value;
      if(!EMAIL_REGEX.test(email)) return alert("Invalid UoB email.");
      if(!password) return alert("Enter your password.");
      const r=await api("/auth/login",{ method:"POST", body:JSON.stringify({ email,password }) });
      if(!r.ok) throw new Error(r.error||"Login failed"); state.user=r.user; state.token=r.token;
    }
    localStorage.setItem("ASKUNI_USER",JSON.stringify(state.user));
    localStorage.setItem("ASKUNI_TOKEN",state.token);
    updateUserUI(); await loadHistory(); closeModal(); addMessage("bot","✅ Signed in.");
  }catch(err){ alert(err.message||"Authentication error."); }
});

/* -------- Upload (guest enabled) -------- */
fileInput.addEventListener("change",async()=>{
  if(!fileInput.files?.length) return;
  const file=fileInput.files[0]; const form=new FormData(); form.append("file",file);
  addMessage("bot","📎 Uploading attachment…");
  try{
    const candidates = API_BASE ? [API_BASE] : ["", DEFAULT_LOCAL_API];
    let ok=false, json=null, lastErr=null;
    for(const base of candidates){
      try{
        const res=await fetch(`${base}/upload`,{ method:"POST", headers:(state.token?{ "Authorization":"Bearer "+state.token }:{}), body:form });
        const ct=res.headers.get("content-type")||"";
        json = ct.includes("application/json") ? await res.json() : { ok:false, error:`Bad content-type: ${ct}` };
        if(json.ok){ ok=true; break; }
      }catch(e){ lastErr=e; }
    }
    if(!ok) throw new Error((json&&json.error)||lastErr?.message||"Upload failed");
    state.attachments.push(json.attachment);
    addMessage("bot",`✅ Attached: ${file.name}`);
  }catch(e){ addMessage("bot","❌ Upload failed: "+e.message); }
  finally{ fileInput.value=""; }
});

/* -------- Send with LIVE STREAM -------- */
async function sendMessageStreaming(textOverride=null, opts={ alreadyEchoed:false }){
  const inputText=(textOverride??msgInput.value).trim();
  if(!inputText && !state.attachments.length) return;
  if(!opts.alreadyEchoed) addMessage("user", inputText||"📎 (attachments only)");
  msgInput.value="";

  const bubble=addStreamingBubble();

  try{
    const candidates = API_BASE ? [API_BASE] : ["", DEFAULT_LOCAL_API];
    let started=false;

    for(const base of candidates){
      try{
        const res=await fetch(`${base}/message/stream`,{
          method:"POST",
          headers:{ "Content-Type":"application/json", ...(state.token?{ "Authorization":"Bearer "+state.token }: {}) },
          body:JSON.stringify({ message:inputText, attachments:state.attachments, sessionId:state.sessionId })
        });

        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader=res.body.getReader(); const decoder=new TextDecoder();
        let buf=""; started=true;

        const processLines=(chunk)=>{
          buf+=chunk; const parts=buf.split("\n\n"); buf=parts.pop()||"";
          for(const block of parts){
            const line=block.trim(); if(!line) continue;
            const m=line.match(/^event:\s*([a-zA-Z]+)\s*[\r\n]+data:(.*)$/s); if(!m) continue;
            const type=m[1]; const data=m[2].trim();
            try{
              const p=JSON.parse(data);
              const token=p.t??p.token??p.value??p.delta;
              if((type==="delta"||type==="message") && token) bubble.append(token);
              else if(type==="final"||type==="done"){
                state.sessionId=p.sessionId||state.sessionId; localStorage.setItem("ASKUNI_SESSION",state.sessionId);
                bubble.finalize(); state.attachments=[]; loadHistory();
              }else if(type==="error"){ bubble.abort(p.error||"stream error"); }
            }catch{}
          }
        };

        for(;;){ const { value, done }=await reader.read(); if(done) break; processLines(decoder.decode(value,{stream:true})); }
        if (started) return; // success for this base
      }catch{ /* try next base */ }
    }

    if (!started){
      // Fallback to non-stream call across candidates
      let resp=null, lastErr=null;
      for(const base of candidates){
        try{
          resp = await fetch(`${base}/message`,{
            method:"POST",
            headers:{ "Content-Type":"application/json", ...(state.token?{ "Authorization":"Bearer "+state.token }: {}) },
            body:JSON.stringify({ message:inputText, attachments:state.attachments, sessionId:state.sessionId })
          });
          const j = await resp.json();
          if (j.ok){
            state.sessionId = j.sessionId || state.sessionId;
            localStorage.setItem("ASKUNI_SESSION", state.sessionId);
            bubble.append(j.message); bubble.finalize(); state.attachments=[]; await loadHistory(); return;
          } else { lastErr = new Error(j.error||"Assistant error"); }
        }catch(e){ lastErr=e; }
      }
      throw lastErr || new Error("Assistant error");
    }
  }catch(err){ bubble.abort(err.message||"stream failed"); }
}
sendBtn.addEventListener("click",()=>sendMessageStreaming());
msgInput.addEventListener("keydown",(e)=>{ if((e.ctrlKey||e.metaKey)&&e.key==="Enter") sendMessageStreaming(); });

/* -------- Mic (guest) -------- */
let mediaStream=null, recorder=null, chunks=[], isRecording=false, autoStopTimer=null;
async function startMic(){
  try{
    mediaStream=await navigator.mediaDevices.getUserMedia({ audio:true });
    recorder=new MediaRecorder(mediaStream,{ mimeType:"audio/webm" });
    chunks=[]; recorder.ondataavailable=(e)=>{ if(e.data.size) chunks.push(e.data); };
    recorder.onstop=onMicStop;
    isRecording=true; micBtn.classList.add("recording");
    addMessage("bot","🎤 Recording… click the mic again to stop."); recorder.start();
    autoStopTimer=setTimeout(()=>{ if(isRecording) stopMic(); },60000);
  }catch{ alert("Microphone permission denied or not available."); }
}
function stopMic(){ if(recorder && recorder.state!=="inactive") recorder.stop(); }
async function onMicStop(){
  try{
    const blob=new Blob(chunks,{ type:"audio/webm" });
    if(!blob.size){ addMessage("bot","⚠️ No audio captured."); return; }
    const form=new FormData(); form.append("audio", blob, "speech.webm");
    addMessage("bot","🎙️ Transcribing…");

    const candidates = API_BASE ? [API_BASE] : ["", DEFAULT_LOCAL_API];
    let ok=false, json=null, lastErr=null;
    for(const base of candidates){
      try{
        const res=await fetch(`${base}/stt`,{ method:"POST", headers:(state.token?{ "Authorization":"Bearer "+state.token }: {}), body:form });
        const ct=res.headers.get("content-type")||"";
        json = ct.includes("application/json") ? await res.json() : { ok:false, error:`Bad content-type: ${ct}` };
        if(json.ok){ ok=true; break; }
      }catch(e){ lastErr=e; }
    }
    if(!ok) throw new Error((json&&json.error)||lastErr?.message||"STT failed");
    const text=(json.text||"").trim();
    if(text){ await sendMessageStreaming(text,{ alreadyEchoed:false }); } else { addMessage("bot","⚠️ No speech detected."); }
  }catch(err){ addMessage("bot","❌ STT failed: "+err.message); }
  finally{
    if(mediaStream) mediaStream.getTracks().forEach(t=>t.stop());
    mediaStream=null; isRecording=false; clearTimeout(autoStopTimer); micBtn.classList.remove("recording");
  }
}
micBtn.addEventListener("click",()=>{ isRecording? stopMic(): startMic(); });
micBtn.addEventListener("mousedown",startMic);
micBtn.addEventListener("mouseup",stopMic);
micBtn.addEventListener("mouseleave",stopMic);
micBtn.addEventListener("touchstart",(e)=>{ e.preventDefault(); startMic(); });
micBtn.addEventListener("touchend",(e)=>{ e.preventDefault(); stopMic(); });

/* -------- Init -------- */
(function init(){
  const savedTheme=localStorage.getItem("ASKUNI_THEME")||"light";
  setTheme(savedTheme); themeSelect.value=savedTheme;

  const mode=localStorage.getItem("ASKUNI_BG_MODE")||"none";
  bgMode.value=mode;
  if(mode==="color") bgColor.value=localStorage.getItem("ASKUNI_BG_COLOR")||"#0b0f14";
  if(mode==="image") bgUrl.value=localStorage.getItem("ASKUNI_BG_IMAGE")||"";
  applyBackgroundSettings();

  clearChat(); updateUserUI(); checkHealth();
  if(state.token){ api("/auth/me").then(loadHistory).catch(()=>promptLogin("Session expired.")); }
})();
