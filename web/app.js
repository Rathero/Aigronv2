/* =========================================================================
   AIGRONS — frontend ONLINE (habla con la API del backend).
   - El estado vive en el servidor (auth, colección, equipo, combate, tienda).
   - El sprite pixel-art se dibuja de forma DETERMINISTA desde template_id/art_seed
     (motor compartido engine.js); si la plantilla trae image_url (arte IA), se
     muestra esa imagen con fallback al sprite procedural.
   - El combate usa el MISMO motor seeded que el servidor: se reproduce la
     animación con el `seed` de /battle/find, se registran las decisiones y el
     servidor recalcula para conceder recompensas (anti-trampa).
   ========================================================================= */
const E = window.ENGINE;
const { ABILITIES, mulberry32, genTemplate, COMBAT_ENERGY_MAX, TURNS_MAX } = E;

/* Renderer de sprites COMPARTIDO con la landing (web/sprite.js): una criatura
   se ve idéntica en la app y en la página de marketing por construcción. */
const { spriteSeed, buildSprite, colorFor } = window.SPRITE;

const _spriteCache={};
function drawAigron(canvas,tpl,px,prismId){
  // POC estilo "completo": render suave (blobs con glow) del MISMO sprite
  // determinista en vez de cuadrados. Inerte sin ?poc=full.
  if(window.POC&&window.POC.smooth){ window.POC.drawSmooth(canvas,tpl,px,prismId,buildSprite,colorFor); return; }
  px=px||8; const N=16;
  canvas.width=N*px; canvas.height=N*px;
  const ctx=canvas.getContext("2d"); ctx.imageSmoothingEnabled=false;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const key=tpl.id||("s"+spriteSeed(tpl));
  const g=_spriteCache[key]||(_spriteCache[key]=buildSprite(tpl));
  // Prismática: paleta alternativa determinista por instancia (cosmético).
  const prism=prismId&&ENGINE.isPrismatic(prismId);
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){
    let c=colorFor(g[y][x],tpl); if(!c)continue;
    if(prism) c=ENGINE.prismaticShift(c,prismId);
    ctx.fillStyle=c; ctx.fillRect(x*px,y*px,px,px);
  }
}
// Silueta: el MISMO sprite determinista pintado en un solo tono oscuro. Para el
// álbum (criaturas aún no poseídas): se intuye la forma sin desvelarla.
function drawSilhouette(canvas,t,px){
  px=px||6; const N=16;
  canvas.width=N*px; canvas.height=N*px;
  const ctx=canvas.getContext("2d"); ctx.imageSmoothingEnabled=false;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const key=t.id||("s"+spriteSeed(t));
  const g=_spriteCache[key]||(_spriteCache[key]=buildSprite(t));
  ctx.fillStyle="#15122e";
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){ if(colorFor(g[y][x],t)) ctx.fillRect(x*px,y*px,px,px); }
}
function drawEgg(canvas,px){
  px=px||8;const N=16;canvas.width=N*px;canvas.height=N*px;
  const ctx=canvas.getContext("2d");ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,N*px,N*px);
  for(let y=2;y<15;y++){const w=Math.round(Math.sin(Math.PI*(y-1)/15)*6);
    for(let x=8-w;x<=7+w;x++){ctx.fillStyle=(y<6?"#7df0ff":"#1fb6c9");ctx.fillRect(x*px,y*px,px,px);}}
  ctx.fillStyle="#08060f";
  [[7,6],[8,6],[7,7],[8,8],[7,9],[7,11]].forEach(([x,y])=>ctx.fillRect(x*px,y*px,px,px));
}

/* ---------------- Caché de plantillas ---------------- */
const TPL={};
function registerTpl(t){ if(t&&t.id){ TPL[t.id]=Object.assign(TPL[t.id]||{},t); } return t; }
function tpl(id){ return TPL[id]||(TPL[id]=genTemplate(id)); }
// Plantilla SINTÉTICA de una forma EVOLUCIONADA: misma criatura base con nombre
// evolucionado y sprite procedural derivado (evoArtSeed). Vive en la caché bajo
// "<id>__evoN" para no pisar el arte del base; si llega arte IA de la variante,
// se le asigna a esta entrada (refreshCollection / registerUnitArt).
function evoTpl(baseId,stage){
  if(!stage) return tpl(baseId);
  const key=baseId+'__evo'+stage;
  if(!TPL[key]){ const b=tpl(baseId);
    TPL[key]=Object.assign({},b,{id:key,name:ENGINE.evoName(b.name,baseId,stage),
      art_seed:ENGINE.evoArtSeed(baseId,stage),image_url:null,image_thumb_url:null}); }
  return TPL[key];
}
// Registra el arte IA de unidades de combate que llegan del servidor (rival de
// PvP): sus plantillas pueden no estar en mi caché (lote de otro día, fusión) y
// sin esto se dibujaban con el sprite procedural en vez de su imagen real.
// Si la unidad va EVOLUCIONADA, su arte es el de la variante: se registra bajo
// la clave evo para no contaminar el arte del aigron base.
function registerUnitArt(list){ (list||[]).forEach(s=>{ if(s&&s.tplId&&s.image_url){
  const stage=ENGINE.evoStageAt(s.tplId,s.level||1);
  if(stage>0){ evoTpl(s.tplId,stage).image_url=s.image_url; }
  else TPL[s.tplId]=Object.assign(TPL[s.tplId]||genTemplate(s.tplId),{image_url:s.image_url,image_thumb_url:s.image_thumb_url||null});
}});}
// Plantilla para PINTAR una unidad de combate (forma evolucionada si procede).
function combatTpl(u){ const st=ENGINE.evoStageAt(u.tplId,u.level||1); return st?evoTpl(u.tplId,st):tpl(u.tplId); }
/* HTML del arte: imagen IA si existe, si no canvas procedural.
   instId opcional -> variante cosmética (áurea/prismática) si toca y la feature
   está on. La clase de variante va en el PROPIO elemento (canvas o img) para que
   el brillo se vea también sobre el arte IA, no solo sobre el sprite procedural. */
function artTag(t,px,instId){
  const variant=(FEATURES.prismatic&&instId)?ENGINE.variantOf(instId):null;
  const vCls=variant==='aurea'?' aig-aurea':(variant==='prismatica'?' aig-prism':'');
  if(t&&t.image_url) return `<img class="aigimg${vCls}" src="${t.image_url}" alt="${esc(t.name||'')}">`;
  // El canvas prismático rota la paleta (data-prism); el áureo se tiñe por CSS.
  const prism=(variant==='prismatica')?` data-prism="${instId}"`:'';
  return `<canvas class="aig${vCls}" data-aig="${t.id}" data-px="${px}"${prism}></canvas>`;
}
/* tipos de una plantilla (1 o 2) */
function tplTypes(t){ return (t&&t.types&&t.types.length)?t.types:[t&&t.type].filter(Boolean); }
function typesLabel(t){ return tplTypes(t).join(" / "); }
function typePills(t){ return tplTypes(t).map(ty=>`<span class="type-pill">${ty}</span>`).join(" "); }

/* ---------------- Capa de API ---------------- */
const API_BASE = (location.protocol==='file:') ? (localStorage.getItem('aigrons_api')||'http://localhost:3000') : '';
let TOKEN = localStorage.getItem('aigrons_token')||'';
function deviceId(){
  let d=localStorage.getItem('aigrons_device');
  if(!d){ d='dev-'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem('aigrons_device',d); }
  return d;
}
async function api(path, opts={}){
  const headers={'content-type':'application/json'};
  if(TOKEN) headers.authorization='Bearer '+TOKEN;
  let res;
  try{
    res = await fetch(API_BASE+path, {method:opts.method||'GET', headers, body:opts.body?JSON.stringify(opts.body):undefined});
  }catch(e){ throw {status:0, network:true}; }
  if(res.status===401){ TOKEN=''; localStorage.removeItem('aigrons_token'); throw {status:401}; }
  let data={}; try{ data=await res.json(); }catch(e){}
  if(!res.ok) throw {status:res.status, data};
  return data;
}
async function login(){
  let name=localStorage.getItem('aigrons_name');
  if(!name){ name='Jugador'+Math.floor(Math.random()*9000+1000); localStorage.setItem('aigrons_name',name); }
  const r=await api('/auth/login',{method:'POST',body:{provider:'dev',subject:deviceId(),displayName:name}});
  TOKEN=r.token; localStorage.setItem('aigrons_token',TOKEN); return r.user;
}

/* ---------------- Estado (cache del servidor) ---------------- */
const S={user:null,daily:null,collection:[],team:[]};
// Flags de funcionalidad (las 7 mecánicas). Se cargan del servidor en el boot;
// por defecto todas on para que el primer render no esconda nada por error.
const FEATURES={puzzle:true,echoes:true,worldboss:true,nemesis:true,prismatic:true,oracle:true,arena:true};
async function loadFeatures(){ try{ const f=await api('/features'); Object.assign(FEATURES,f); }catch(e){} }
async function refreshMe(){ S.user=await api('/me'); }
async function refreshDaily(){ S.daily=await api('/daily'); (S.daily.highlights||[]).forEach(registerTpl); }
async function refreshCollection(){ const c=await api('/collection'); c.forEach(x=>{ registerTpl(x.template);
  // Forma evolucionada: registra su plantilla sintética y, si el arte IA de la
  // variante ya está generado (perezoso), engánchalo.
  if(x.evo){ const e=evoTpl(x.template.id,x.evo.stage); if(x.evo.image_url) e.image_url=x.evo.image_url; }
}); S.collection=c; }
async function refreshTeam(){ const t=await api('/team'); S.team=[t.slot1,t.slot2,t.slot3].filter(Boolean); }
function instById(id){ return S.collection.find(c=>c.instance_id===id); }

/* ====================== UI: helpers ====================== */
const $=s=>document.querySelector(s);
// Escape HTML para texto controlado por OTROS usuarios (nombres en rankings,
// banners de PvP...). El servidor sanea al escribir; esto es la segunda capa.
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------------- SFX (chiptune sintetizado, sin assets) + háptica ----------
   WebAudio genera los pitidos 8-bit al vuelo (encaja con el pixel-art y pesa 0).
   El contexto se crea perezosamente en el primer gesto (política de autoplay).
   Mute persistente en localStorage (toggle en el menú ≡). */
const SFX=(()=>{
  let ctx=null, muted=localStorage.getItem('aigrons_mute')==='1';
  function ac(){ if(!ctx){ try{ctx=new (window.AudioContext||window.webkitAudioContext)();}catch(e){} }
    if(ctx&&ctx.state==='suspended') ctx.resume().catch(()=>{});
    return ctx; }
  function tone(f,dur,type,vol,slide,at){
    const c=ac(); if(!c||muted)return;
    const t0=c.currentTime+(at||0);
    const o=c.createOscillator(),g=c.createGain();
    o.type=type||'square'; o.frequency.setValueAtTime(f,t0);
    if(slide) o.frequency.exponentialRampToValueAtTime(Math.max(30,f+slide),t0+dur);
    g.gain.setValueAtTime(vol||.04,t0);
    g.gain.exponentialRampToValueAtTime(.0001,t0+dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0+dur+.02);
  }
  const fx={
    click:()=>tone(520,.04,'square',.018),
    hit:()=>tone(200,.09,'square',.05,-90),
    crit:()=>{tone(150,.1,'sawtooth',.06,-60);tone(990,.06,'square',.04,0,.03);},
    ability:()=>tone(420,.14,'sawtooth',.035,260),
    heal:()=>{tone(523,.08,'triangle',.04);tone(784,.1,'triangle',.04,0,.07);},
    poison:()=>tone(160,.12,'triangle',.04,-40),
    claim:()=>{[523,659,784,1047].forEach((f,i)=>tone(f,.1,'square',.04,0,i*.08));},
    win:()=>{[523,659,784,1047,1319].forEach((f,i)=>tone(f,.12,'square',.045,0,i*.09));},
    lose:()=>{[392,330,262,196].forEach((f,i)=>tone(f,.16,'triangle',.05,0,i*.12));},
  };
  return {
    play:(k)=>{ try{ fx[k]&&fx[k](); }catch(e){} },
    toggle:()=>{ muted=!muted; localStorage.setItem('aigrons_mute',muted?'1':'0'); return muted; },
    muted:()=>muted,
  };
})();
function buzz(ms){ if(navigator.vibrate){ try{navigator.vibrate(ms);}catch(e){} } }

/* ---------------- MÚSICA (chiptune procedural adaptativa, sin assets) --------
   Un secuenciador WebAudio teje una banda sonora 8-bit al vuelo: bajo + arpegio
   sobre una progresión menor pentatónica (suena bien y "a juego" con el pixel).
   Dos escenas: 'menu' (tranquila) y 'battle' (más rápida, con percusión) — la
   música se INTENSIFICA al combatir. Pesa 0 (no hay ficheros), arranca en el
   primer gesto del usuario (política de autoplay) y tiene toggle propio en ≡.
   On por defecto; se recuerda en localStorage ('aigrons_music'). */
const MUSIC=(()=>{
  let ctx=null, master=null, on=localStorage.getItem('aigrons_music')!=='0', scene='menu', timer=null, step=0, playing=false;
  const BASE=220; // La3
  const SCALE=[0,3,5,7,10,12,15,17]; // menor pentatónica (semitonos), dos octavas
  const hz=(semi)=>BASE*Math.pow(2,semi/12);
  // Progresión de "acordes" (índice raíz en la escala) por escena.
  const PROG={ menu:[0,5,3,4], battle:[0,0,5,3] };
  function ac(){
    if(!ctx){ try{ ctx=new (window.AudioContext||window.webkitAudioContext)(); master=ctx.createGain(); master.gain.value=0; master.connect(ctx.destination); }catch(e){ return null; } }
    if(ctx&&ctx.state==='suspended') ctx.resume().catch(()=>{});
    return ctx;
  }
  function voice(f,t,dur,type,vol){
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type=type; o.frequency.setValueAtTime(f,t);
    g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vol,t+.01); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t+dur+.03);
  }
  function perc(t,dur,vol){ // percusión de ruido para la escena de combate
    const len=Math.floor(ctx.sampleRate*dur), b=ctx.createBuffer(1,len,ctx.sampleRate), d=b.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2);
    const s=ctx.createBufferSource(); s.buffer=b; const g=ctx.createGain(); g.gain.value=vol;
    s.connect(g); g.connect(master); s.start(t);
  }
  function tick(){
    const c=ac(); if(!c){ return; }
    const t=c.currentTime+.06, isB=scene==='battle', prog=PROG[scene];
    const root=prog[Math.floor(step/8)%prog.length], s=step%8;
    if(s%2===0) voice(hz(SCALE[root]-12), t, isB?.22:.34, 'triangle', .11);                 // bajo
    const arp=[root,root+2,root+4,root+2][s%4];
    voice(hz(SCALE[arp%SCALE.length]), t, isB?.12:.2, 'square', isB?.05:.045);               // arpegio
    if(isB){ if(s%4===0)perc(t,.06,.06); if(s%2===1)perc(t,.03,.03);
      if(s===6) voice(hz(SCALE[(root+4)%SCALE.length]+12), t, .14, 'square', .045); }          // adorno
    step++;
  }
  function loop(){ tick(); timer=setTimeout(loop, scene==='battle'?125:165); }
  function start(){
    if(!on||playing) return; const c=ac(); if(!c) return; playing=true;
    master.gain.cancelScheduledValues(c.currentTime);
    master.gain.setValueAtTime(0,c.currentTime); master.gain.linearRampToValueAtTime(.4, c.currentTime+1.6);
    loop();
  }
  function stop(){ playing=false; if(timer){clearTimeout(timer);timer=null;}
    if(master&&ctx){ master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0, ctx.currentTime+.4); } }
  return {
    start, enabled:()=>on,
    setScene:(s)=>{ if(scene===s||(s!=='menu'&&s!=='battle'))return; scene=s; step=0; },
    toggle:()=>{ on=!on; localStorage.setItem('aigrons_music', on?'1':'0'); if(on){ playing=false; start(); } else stop(); return on; },
  };
})();

/* Beacon de ERRORES: los fallos de los jugadores dejan de ser invisibles.
   Máximo 3 por sesión (el servidor además limita por IP). */
let _errSent=0;
function beaconError(msg,src){
  if(_errSent>=3)return; _errSent++;
  try{ fetch((typeof API_BASE!=='undefined'?API_BASE:'')+'/client-errors',{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({msg:String(msg).slice(0,300),src:String(src||'').slice(0,200)})}).catch(()=>{});
  }catch(e){}
}
window.addEventListener('error',e=>beaconError(e.message,(e.filename||'')+':'+(e.lineno||'')));
window.addEventListener('unhandledrejection',e=>beaconError('promise: '+((e.reason&&e.reason.message)||e.reason),''));

function refreshChips(){
  if(!S.user)return;
  $("#c-coins").textContent=S.user.coins;
  $("#c-dust").textContent=S.user.dust;
  $("#c-gems").textContent=S.user.gems;
  $("#c-ene").textContent=S.user.energy+"/"+S.user.energyMax;
}
/* -------- cuentas atrás (energía y próximo lote), tick de 1 s -------- */
function fmtMMSS(ms){ms=Math.max(0,ms);const m=Math.floor(ms/60000),s=Math.floor(ms%60000/1000);return m+":"+String(s).padStart(2,"0");}
function fmtHMS(ms){ms=Math.max(0,ms);const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000);
  return h>0?`${h}h ${String(m).padStart(2,"0")}m`:(m>0?`${m}m ${String(s).padStart(2,"0")}s`:`${s}s`);}
let _eneSyncing=false;
function tickCountdowns(){
  const et=$("#c-ene-t");
  if(et){
    if(S.user&&S.user.energyNextAt&&S.user.energy<S.user.energyMax){
      const ms=new Date(S.user.energyNextAt)-Date.now();
      et.textContent="·"+fmtMMSS(ms);
      if(ms<=0&&!_eneSyncing){ // llegó la ⚡: resincroniza con el servidor
        _eneSyncing=true;
        refreshMe().then(()=>{refreshChips();}).catch(()=>{}).finally(()=>{_eneSyncing=false;});
      }
    } else et.textContent="";
  }
  const nb=$("#next-batch");
  if(nb&&S.daily){
    const t=S.daily.nextBatchAt?new Date(S.daily.nextBatchAt):(()=>{const n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate()+1);})();
    nb.textContent=fmtHMS(t-Date.now());
  }
  // botón de PvP deshabilitado por energía: cuenta atrás a la próxima ⚡
  const pw=$("#pvp-wait");
  if(pw&&S.user&&S.user.energyNextAt){
    const ms=new Date(S.user.energyNextAt)-Date.now();
    pw.textContent=fmtMMSS(ms);
    // ya hay energía: reactiva el botón (solo si INICIO está visible)
    if(ms<=0&&S.user.energy>=1&&$("#s-home").classList.contains('active')) renderHome();
  }
}
setInterval(()=>{ tickCountdowns(); tickExpedition(); },1000);
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),1600);}
function openOverlay(html){$("#modal").innerHTML=html;$("#overlay").classList.add("show");renderCanvases($("#modal"));}
function closeOverlay(){$("#overlay").classList.remove("show");}
$("#overlay").addEventListener("click",e=>{if(e.target.id==="overlay")closeOverlay();});
function renderCanvases(root){
  root.querySelectorAll("canvas[data-aig]").forEach(c=>{if(c._done)return;drawAigron(c,tpl(c.dataset.aig),parseInt(c.dataset.px||"8"),c.dataset.prism);c._done=1;});
  root.querySelectorAll("canvas[data-sil]").forEach(c=>{if(c._done)return;drawSilhouette(c,tpl(c.dataset.sil),parseInt(c.dataset.px||"6"));c._done=1;});
  root.querySelectorAll("canvas[data-egg]").forEach(c=>{if(c._done)return;drawEgg(c,parseInt(c.dataset.px||"8"));c._done=1;});
}
// Versión CORTA (para el planificador de combate).
function abilityShort(id){const a=ABILITIES[id];return {
  dmg:`Daño ×${a.mult} a 1`+(a.ignoreDef?` (ignora DEF)`:"")+(a.crit?", crítico":"")+(a.selfHp?`, −HP propio`:""),
  aoe:`Daño ×${a.mult} a todos`, buffDef:`+${a.amt*100}% DEF ${a.team?"equipo":"propia"} ${a.turns}t`,
  buffAtk:`+${a.amt*100}% ATK`+(a.defDown?`, −${a.defDown*100}% DEF`:""), critDown:`−${a.amt*100}% crítico rival ${a.turns}t`,
  mark:`Marca: +${a.amt*100}% daño recibido ${a.turns}t`, heal:`Cura ${a.amt*100}% propia`,
  healTeam:`Cura ${a.amt*100}% al equipo`, double:`2 ataques`,
  dot:`Veneno: ${Math.round(a.amt*100)}% vida/turno ${a.turns}t`, stun:`Aturde ${a.turns}t`,
  shield:`Escudo ${a.amt*100}% ${a.team?"equipo":"propio"}`, drain:`Daño ×${a.mult}, cura ${a.drain*100}%`,
  defBreak:`Rompe DEF: −${a.amt*100}% DEF rival ${a.turns}t`, slow:`Ralentiza: −${a.amt*100}% SPD ${a.turns}t`,
  haste:`Acelera: +${a.amt*100}% SPD ${a.team?"equipo":"propio"} ${a.turns}t`, taunt:`Provoca ${a.turns}t (te apuntan)`,
  cleanse:`Limpia estados ${a.team?"al equipo":"propios"}`, immunity:`Inmunidad a debuffs ${a.team?"equipo":"propia"} ${a.turns}t`}[a.kind];}
// Categoría rápida.
function abilityKind(id){const a=ABILITIES[id];return {dmg:"Daño",aoe:"Daño en área",buffDef:"Defensa",buffAtk:"Mejora",critDown:"Debilita",mark:"Debilita",heal:"Cura",healTeam:"Cura equipo",double:"Daño",dot:"Veneno",stun:"Control",shield:"Escudo",drain:"Drenar",defBreak:"Romper DEF",slow:"Control",haste:"Apoyo",taunt:"Tanque",cleanse:"Apoyo",immunity:"Apoyo"}[a.kind];}
// Versión CLARA y explicada (para el detalle del aigrón).
function abilityEffect(id){const a=ABILITIES[id];return {
  dmg:`Golpe fuerte a un enemigo: hace ${a.mult}× tu ataque`+(a.ignoreDef?`, ignorando el ${a.ignoreDef*100}% de su defensa`:"")+(a.crit?", siempre crítico":"")+(a.selfHp?`. Pierdes el ${a.selfHp*100}% de tu vida`:""),
  aoe:`Daña a los TRES enemigos a la vez (${a.mult}× tu ataque cada uno)`,
  buffDef:`Sube +${a.amt*100}% la defensa ${a.team?"de todo tu equipo":"de esta criatura"} durante ${a.turns} turnos: aguanta mucho más.`,
  buffAtk:`Sube +${a.amt*100}% tu ataque para el resto del combate`+(a.defDown?` (a cambio de −${a.defDown*100}% de defensa)`:"")+`. Para pegar más cada turno.`,
  critDown:`Reduce un ${a.amt*100}% la probabilidad de crítico de un enemigo durante ${a.turns} turnos.`,
  mark:`Marca a un enemigo: durante ${a.turns} turnos recibirá un +${a.amt*100}% de daño de TODOS los golpes. Úsala y luego concéntrate en ese enemigo para rematarlo.`,
  heal:`Se cura el ${a.amt*100}% de su vida máxima.`,
  healTeam:`Cura el ${a.amt*100}% de vida a TODO tu equipo.`,
  double:`Actúa dos veces este turno: hace dos ataques en lugar de uno.`,
  dot:`Envenena a un enemigo: pierde el ${Math.round(a.amt*100)}% de su vida máxima cada turno durante ${a.turns} turnos (ignora defensa).`,
  stun:`Aturde a un enemigo: se salta su próxima acción (${a.turns} turno${a.turns>1?'s':''}).`,
  shield:`Da un escudo que absorbe daño (${a.amt*100}% de la vida máxima) ${a.team?"a todo tu equipo":"a esta criatura"} antes de tocar el HP.`,
  drain:`Daña a un enemigo (${a.mult}× tu ataque) y te curas el ${a.drain*100}% del daño hecho.`,
  defBreak:`Rompe la defensa de un enemigo: −${a.amt*100}% DEF durante ${a.turns} turnos. Combínalo con golpes fuertes para reventarlo.`,
  slow:`Ralentiza a un enemigo: −${a.amt*100}% de velocidad ${a.turns} turnos (actúa más tarde y es más fácil de criticar).`,
  haste:`Acelera ${a.team?"a todo tu equipo":"a esta criatura"}: +${a.amt*100}% de velocidad ${a.turns} turnos (actuáis antes).`,
  taunt:`Provoca: durante ${a.turns} turnos los enemigos se ven OBLIGADos a atacarte`+(a.amt?` (+${a.amt*100}% DEF mientras dura)`:"")+`. Protege a tu equipo.`,
  cleanse:`Limpia TODOS los estados negativos (veneno, marca, lentitud, romper-DEF…) ${a.team?"de todo tu equipo":"de esta criatura"}.`,
  immunity:`Concede INMUNIDAD a debuffs ${a.team?"a todo tu equipo":"a esta criatura"} durante ${a.turns} turnos: bloquea veneno, aturde, marca, etc.`}[a.kind];}
function cardHTML(inst,extra){const t=inst.template;
  // Variante cosmética: áurea (premio gordo) o prismática. Badge + clase de brillo.
  const variant=FEATURES.prismatic?(inst.variant||ENGINE.variantOf(inst.instance_id)):null;
  const vCls=variant==='aurea'?'aurea':(variant==='prismatica'?'prismatic':'');
  const vBadge=variant==='aurea'?'<div class="shiny-badge">✨</div>':(variant==='prismatica'?'<div class="prism-badge">✦</div>':'');
  // Forma EVOLUCIONADA: sprite/arte y nombre de la etapa actual (no del base).
  // Sin evolución pero con arte áureo generado: úsalo en lugar del arte base.
  let dispT=t;
  if(inst.evo) dispT=evoTpl(t.id,inst.evo.stage);
  else if(inst.shiny_image_url) dispT=Object.assign({},t,{image_url:inst.shiny_image_url});
  return `<div class="card r-${t.rarity} ${inst.frame?'frame-'+inst.frame:''} ${vCls}" data-iid="${inst.instance_id}">
  <div class="lv">L${inst.level}</div>${inst.favorite?'<div class="fav">★</div>':''}${vBadge}${extra||""}
  ${artTag(dispT,6,inst.instance_id)}
  <div class="nm">${esc(dispT.name)}</div><div class="ty rar-txt ${t.rarity}">${typesLabel(t)}</div></div>`;}
function statBars(o,level){
  // Tope teórico por stat = (tope rareza máxima LEGENDARIA) x (arquetipo máx ~1.3),
  // escalado al MISMO nivel que el valor mostrado -> el nivel se cancela y la barra
  // refleja la FORMA del aigron (rareza + arquetipo), no su nivel. Así nunca se
  // llenan todas: ni el legendario perfecto sube unas sin bajar otras.
  const f=1+0.04*((level||1)-1);
  const base={hp:1680,atkP:250,atkS:250,defP:163,defS:163,spd:169};
  const max={};for(const k in base)max[k]=base[k]*f;
  const row=(l,v,k,c)=>`<div class="stat"><span class="lab">${l}</span><span class="bar"><i class="fill" style="width:${Math.min(100,v/max[k]*100)}%;background:${c}"></i></span><span class="val">${v}</span></div>`;
  // back-compat por si llegan stats antiguas {atk,def}
  const atkP=o.atkP!=null?o.atkP:o.atk, atkS=o.atkS!=null?o.atkS:o.atk, defP=o.defP!=null?o.defP:o.def, defS=o.defS!=null?o.defS:o.def;
  return row("HP",o.hp,"hp","var(--green)")
    +row("A.Fís",atkP,"atkP","var(--gold)")
    +row("A.Esp",atkS,"atkS","var(--magenta)")
    +row("D.Fís",defP,"defP","var(--rar)")
    +row("D.Esp",defS,"defS","var(--epi)")
    +row("SPD",o.spd,"spd","var(--cyan)");}

/* ====================== HOME ====================== */
function dungeonHomeCard(dg){
  if(!dg||dg.status==='none'){
    return `<div class="panel" style="border-color:var(--epi)"><div class="row" style="justify-content:space-between;align-items:center">
      <b style="font-size:14px">🗺️ Mazmorra del día</b><span class="dim" style="font-size:11px">roguelike</span></div>
      <div class="dim mt8" style="font-size:12px">8 nodos, reliquias, permadeath. Mismo mapa para todos. ¿Hasta dónde llegas hoy?</div>
      <button class="btn sm mag mt8" style="width:100%" data-act="goDungeon">ENTRAR</button></div>`;
  }
  const at=`nodo ${Math.min(dg.depth+1,dg.totalDepth)}/${dg.totalDepth}`;
  if(dg.status==='active'){
    const nR=dg.relics.length;
    const relicTxt=nR===0?'sin reliquias':nR===1?'1 reliquia':`${nR} reliquias`;
    const pips=Array.from({length:dg.totalDepth},(_,i)=>
      `<span class="dg-pip ${i<dg.depth?'done':''} ${i===dg.depth?'cur':''} ${i===dg.totalDepth-1?'boss':''}"></span>`).join('');
    return `<div class="panel glow-cyan"><div class="row" style="justify-content:space-between;align-items:center">
      <b style="font-size:14px">🗺️ Mazmorra · ${at}</b><span class="dim" style="font-size:12px">botín: <b style="color:var(--gold)">${dg.coins}</b>🪙</span></div>
      <div class="dg-pips-row">${pips}</div>
      <div class="dim mt8" style="font-size:12px">Run en marcha · ${relicTxt}.</div>
      <button class="btn sm ghost cyan mt8" style="width:100%" data-act="goDungeon">CONTINUAR ▶</button></div>`;
  }
  return `<div class="panel"><div class="row" style="justify-content:space-between;align-items:center">
      <b style="font-size:14px">🗺️ Mazmorra</b><span class="dim" style="font-size:12px">${dg.status==='cleared'?'🏆 completada':'☠️ terminada'}</span></div>
      <div class="dim mt8" style="font-size:12px">Llegaste al ${at}. Mapa nuevo mañana.</div>
      <button class="btn sm ghost mt8" style="width:100%" data-act="goDungeon">VER RANKING</button></div>`;
}
// Barra de progreso hacia la siguiente liga (umbrales de engine.computeLeague).
const LEAGUE_STEPS=[["BRONCE",0],["PLATA",100],["ORO",250],["PLATINO",450],["DIAMANTE",700]];
function leagueBarHTML(){
  const lp=S.user.leaguePoints;
  const i=LEAGUE_STEPS.findIndex(([name])=>name===S.user.league);
  const next=LEAGUE_STEPS[i+1];
  if(!next) return `<div class="league-wrap"><span class="lg-now">🏅 ${S.user.league}</span>
    <div class="league-bar"><i style="width:100%"></i></div><span class="lg-next">${lp} pts · liga máxima</span></div>`;
  const from=LEAGUE_STEPS[i][1];
  const pct=Math.max(0,Math.min(100,Math.round((lp-from)/(next[1]-from)*100)));
  return `<div class="league-wrap"><span class="lg-now">🏅 ${S.user.league}</span>
    <div class="league-bar"><i style="width:${pct}%"></i></div>
    <span class="lg-next">${lp}/${next[1]} → ${next[0]}</span></div>`;
}
/* Revelado progresivo de módulos de la home (feedback: demasiada información
   de golpe). Cada módulo aparece al alcanzar las victorias indicadas, con un
   aviso de desbloqueo la primera vez. */
const UNLOCKS={oracle:1,dungeon:1,weekly:3,modes:3};
function unlocked(key){ return (S.user&&S.user.totalWins||0)>=UNLOCKS[key]; }
function announceUnlocks(){
  const seen=JSON.parse(localStorage.getItem('aigrons_unlocked')||'{}');
  const names={oracle:'🔮 El Oráculo',dungeon:'🗺️ La Mazmorra',weekly:'📅 Misiones semanales',modes:'🧩 Modos de juego'};
  let changed=false;
  Object.keys(UNLOCKS).forEach(k=>{ if(unlocked(k)&&!seen[k]){ seen[k]=1; changed=true; toast('🎉 Desbloqueado: '+names[k]); SFX.play('claim'); } });
  if(changed) localStorage.setItem('aigrons_unlocked',JSON.stringify(seen));
}
async function renderHome(){
  refreshChips();
  announceUnlocks();
  const claimed=S.daily&&S.daily.claimed;
  let dg=null; if(unlocked('dungeon')){ try{ dg=await api('/dungeon'); }catch(e){} }
  let exp=null; try{ exp=await api('/expedition'); }catch(e){}
  // Reclamado: banda compacta con cuenta atrás (anticipación) en vez de un
  // panel grande "sin nada que hacer" ocupando el espacio premium.
  const dailyCard=claimed?
    `<div class="panel">
       <div class="daily-compact">
         <span>🎁 Huevo de mañana en <b id="next-batch">--</b></span>
         <span>🔥 Racha: <b style="color:var(--gold)">${S.user.streak}</b> día${S.user.streak===1?'':'s'}</span>
       </div>
     </div>`:
    `<div class="daily panel glow-cyan"><div class="halo"></div>
       <div class="tc"><b style="font-size:14px;color:var(--cyan)">AIGRÓN DEL DÍA</b></div>
       <canvas class="egg" data-egg="1" data-px="8"></canvas>
       <div class="subtle tc mb8">Abre tu huevo gratis: una criatura del álbum de este mes.</div>
       <button class="btn mag" data-act="doClaim">ABRIR — GRATIS</button>
     </div>`;
  const missions=(S.user.missions)||[];
  const weeklyM=unlocked('weekly')?((S.user.weeklyMissions)||[]):[];
  const labels={claim:"Reclama tu aigrón",win:"Gana 3 combates",ability:"Usa 5 habilidades"};
  const mrow=(m)=>{const pct=Math.min(100,Math.round(m.progress/m.goal*100));
    return `<div class="mis ${m.done?'done':''}">
     <div class="mrow">
       <span>${m.done?"✅":"▫️"} ${m.label||labels[m.key]||m.key} <span class="dim">(${m.progress}/${m.goal})</span></span>
       ${m.done&&!m.claimed?`<button class="btn sm gold pulse" style="padding:4px 8px" data-act="claimMission" data-arg="${m.key}">+${m.reward}🪙</button>`
          :`<span style="color:var(--gold)">${m.claimed?'✔':'+'+m.reward+'🪙'}</span>`}
     </div>
     <div class="mis-bar"><i style="width:${pct}%"></i></div></div>`;};
  // Aviso push (suave, una vez): tras reclamar, ofrece el recordatorio diario.
  const canAskPush=claimed&&!localStorage.getItem('aigrons_push_asked')&&('Notification' in window)&&Notification.permission==='default'&&('serviceWorker' in navigator);
  const pushLine=canAskPush?`<div class="panel" style="padding:8px 10px;font-size:12px;display:flex;align-items:center;gap:8px">
     <span style="flex:1">🔔 ¿Te avisamos del huevo de mañana?</span>
     <button class="btn sm" style="padding:4px 8px" data-act="pushEnable">SÍ</button>
     <button class="btn sm ghost" style="padding:4px 8px" data-act="pushSkip">NO</button></div>`:'';
  // Banner de EVENTO del día (sábado temático / domingo legendario).
  const ev=unlocked('oracle')&&S.daily&&S.daily.event;
  const evBanner=ev?`<div class="panel" style="padding:8px 10px;border-color:var(--gold);font-size:13px">${ev.emoji||'⚡'} <b style="color:var(--gold)">EVENTO:</b> ${ev.name}${ev.kind==='legendary'?' — legendarias extra en el destacado':''}</div>`:'';
  $("#s-home").innerHTML=`
    <h2 class="title" data-act="openProfile" style="cursor:pointer">${esc((S.user.displayName||'INICIO').toUpperCase())} <small class="dim" style="font-size:10px">👤 perfil</small></h2>
    ${leagueBarHTML()}
    ${evBanner}
    ${pushLine}
    ${dailyCard}
    ${expeditionHomeCard(exp)}
    ${recapHomeCard()}
    ${albumHomeCard()}
    ${uniqueHomeCard()}
    ${oracleCard()}
    ${teamCombatHTML()}
    ${modesGrid()}
    <div class="panel"><b style="font-size:14px">Misiones diarias</b>
      ${missions.map(mrow).join("")}
      ${weeklyM.length?`<div style="border-top:1px solid var(--line);margin-top:8px;padding-top:6px"><b style="font-size:13px">Semanales</b> <span class="dim" style="font-size:10px">se reinician el lunes</span>${weeklyM.map(mrow).join("")}</div>`:''}
    </div>
    ${unlocked('dungeon')?dungeonHomeCard(dg):''}`;
  renderCanvases($("#s-home"));
  tickCountdowns(); tickExpedition();
  maybeExpeditionIntro(exp);
  loadOracle();
  loadAlbumMini();
  if(FEATURES.worldboss&&unlocked('modes')) api('/worldboss').then(b=>{const e=$("#boss-mini");if(e)e.innerHTML=b.defeated?'🏆 ¡derrotado!':`HP ${b.pct}% · ${b.top.length} héroes`;}).catch(()=>{});
  $("#s-home").querySelectorAll(".card").forEach(c=>c.onclick=()=>openDetail(c.dataset.iid));
}
// ----------------------- ÁLBUM mensual (vista de temporada) ------------------
// El catálogo coleccionable es MENSUAL: este card abre el álbum del mes con
// todas las criaturas (poseídas a color, el resto como silueta) y el progreso.
function albumHomeCard(){
  const lbl=(S.daily&&S.daily.season&&S.daily.season.label)||'este mes';
  return `<div class="panel album-card" data-act="openAlbum" style="cursor:pointer;border-color:var(--cyan)">
    <div class="mrow"><span>📖 <b style="color:var(--cyan)">Álbum de ${esc(lbl)}</b></span><span class="dim" id="album-mini">…</span></div>
    <div class="mis-bar"><i id="album-bar" style="width:0%"></i></div>
    <div class="dim" style="font-size:11px;margin-top:4px">Colecciónalas todas este mes · cambia el mes que viene</div>
  </div>`;
}
async function loadAlbumMini(){
  const el=$("#album-mini"); if(!el)return;
  try{ const s=await api('/season'); S.season=s;
    el.innerHTML=`${s.owned}/${s.total}${s.complete?' 🏆':''}`;
    const bar=$("#album-bar"); if(bar) bar.style.width=Math.round(s.owned/s.total*100)+'%';
  }catch(e){ el.textContent=''; }
}
// Criatura ÚNICA del día (pieza exclusiva/FOMO): card en home.
function uniqueHomeCard(){
  const u=S.daily&&S.daily.unique; if(!u)return '';
  const tag=u.owned?'<span class="dim">ya es tuya ✔</span>':`<span style="color:var(--gold)">cázala hoy</span>`;
  return `<div class="panel" data-act="openUnique" style="cursor:pointer;border-color:var(--epi)">
    <div class="mrow"><span>✨ <b style="color:var(--epi)">Criatura única del día</b></span>${tag}</div>
    <div class="dim" style="font-size:11px;margin-top:2px">Una sola, exclusiva de hoy. Mañana cambia.</div>
  </div>`;
}
async function openAlbum(){
  openOverlay(`<div class="center"><div class="dim">Cargando álbum…</div></div>`);
  let s; try{ s=await api('/season'); S.season=s; }catch(e){ toast('No se pudo cargar el álbum'); closeOverlay(); return; }
  const RAR_ORD={LEGENDARIA:0,EPICA:1,RARA:2,COMUN:3};
  const entries=s.entries.slice().sort((a,b)=>(RAR_ORD[a.rarity]-RAR_ORD[b.rarity])||(a.owned===b.owned?0:a.owned?-1:1));
  const cells=entries.map(e=>{
    if(e.owned){ registerTpl(e); return `<div class="alb-cell owned ${e.rarity}${e.highlight?' hl':''}" title="${esc(e.name)}">
      ${e.image_url?`<img class="aigimg" src="${e.image_url}" alt="">`:`<canvas data-aig="${e.id}" data-px="5"></canvas>`}
      <span class="alb-name">${esc(e.name)}</span></div>`; }
    return `<div class="alb-cell ${e.rarity}${e.highlight?' hl':''}" title="???">
      <canvas data-sil="${e.id}" data-px="5"></canvas><span class="alb-name dim">???</span></div>`;
  }).join('');
  const reward=s.complete&&!s.rewardClaimed
    ? `<button class="btn gold mb8" data-act="claimAlbum">🏆 ¡ÁLBUM COMPLETO! Reclama +${s.reward.coins}🪙 +${s.reward.gems}💎</button>`
    : (s.rewardClaimed?`<div class="dim mb8" style="font-size:12px">🏆 Recompensa del álbum ya reclamada</div>`:'');
  const story=ENGINE.seasonStory&&ENGINE.seasonStory(s.season.key);
  const storyBanner=story?`<div class="season-chapter"><div class="sc-h">Capítulo ${story.chapter}/${story.of} · <b>${esc(story.title)}</b></div><div class="sc-x">${esc(story.text)}</div></div>`:'';
  // Fichas de álbum (botín idle): canjéalas por una criatura que te falta.
  const TOK_COST=3, toks=(S.user&&S.user.albumTokens)||0;
  const tokenRow=(!s.complete)?`<div class="panel" style="padding:8px 10px;border-color:var(--epi);display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:13px;flex:1">🎟️ Fichas de álbum: <b style="color:var(--epi)">${toks}</b> <span class="dim" style="font-size:11px">(de la expedición)</span></span>
      <button class="btn sm ${toks>=TOK_COST?'mag':''}" style="width:auto" data-act="tokenClaim" ${toks>=TOK_COST?'':'disabled'}>CANJEAR ${TOK_COST}🎟️</button>
    </div>`:'';
  openOverlay(`<div class="album-modal">
    <div class="mrow" style="margin-bottom:8px"><b style="font-size:16px;color:var(--cyan)">Álbum de ${esc(s.season.label)}</b>
      <span class="dim">${s.owned}/${s.total}</span></div>
    ${storyBanner}
    <div class="mis-bar" style="margin-bottom:10px"><i style="width:${Math.round(s.owned/s.total*100)}%"></i></div>
    ${reward}
    ${tokenRow}
    <div class="dim" style="font-size:11px;margin-bottom:8px">⭐ marco = destacada hoy (más probable en el huevo y la tienda)</div>
    <div class="alb-grid">${cells}</div>
    <button class="btn ghost cyan mt8" data-act="openCodex">📜 CÓDICE DEL MUNDO</button>
    <button class="btn ghost mt8" data-act="close">CERRAR</button>
  </div>`);
  renderCanvases($("#overlay"));
}
async function claimAlbum(){
  try{ const r=await api('/season/claim',{method:'POST'}); S.user=Object.assign(S.user||{},r.user); refreshChips();
    SFX.play('claim'); if(window.POC&&window.POC.confetti)window.POC.confetti();
    toast(`🏆 +${r.reward.coins}🪙 +${r.reward.gems}💎`); openAlbum(); }
  catch(e){ toast('No se pudo reclamar'); }
}
// Canje de fichas de álbum -> criatura del álbum que te falta (reveal).
async function tokenClaim(){
  try{
    const r=await api('/album/token-claim',{method:'POST'});
    if(r.user){ S.user=Object.assign(S.user||{},r.user); refreshChips(); }
    const t=registerTpl(r.instance.template);
    await refreshCollection();
    SFX.play('claim'); buzz([30,40,30,40,80]); if(window.POC&&window.POC.confetti)window.POC.confetti();
    openOverlay(`<div class="center reveal" style="position:relative"><div class="rays"></div>
      <div style="position:relative;z-index:2">
        <div style="font-family:var(--pixel);font-size:11px;color:var(--epi);margin-bottom:8px">🎟️ FICHA CANJEADA</div>
        ${artTag(t,11)}
        <div style="font-size:20px;font-weight:700;margin-top:6px">${esc(t.name)}</div>
        <div class="mb8">${typePills(t)} <span class="rar-txt ${t.rarity}" style="font-weight:700">${t.rarity}</span></div>
        <div class="dim" style="font-size:12px;margin-bottom:10px">¡Nueva para tu álbum!</div>
        <button class="btn" data-act="openAlbum">SEGUIR</button>
      </div></div>`);
    renderCanvases($("#overlay"));
  }catch(e){ const er=e.data&&e.data.error;
    toast(er==='insufficient'?'Te faltan fichas (consíguelas en la expedición)':er==='album_complete'?'¡Ya tienes el álbum completo!':'No se pudo canjear'); }
}
async function openUnique(){
  openOverlay(`<div class="center"><div class="dim">Cargando…</div></div>`);
  let d; try{ d=await api('/daily/unique'); }catch(e){ toast('No disponible'); closeOverlay(); return; }
  const t=registerTpl(d.creature);
  const btn=d.owned
    ? `<div style="color:var(--gold);font-weight:700;margin-bottom:8px">✔ Ya es tuya</div>`
    : `<button class="btn gold mb8" data-act="claimUnique">CAZAR — ${d.cost}🪙</button>`;
  openOverlay(`<div class="center reveal" style="position:relative">
    <div class="rays"></div>
    <div style="position:relative;z-index:2">
      <div style="font-family:var(--pixel);font-size:11px;color:var(--epi);margin-bottom:8px">✨ ÚNICA DEL DÍA</div>
      ${artTag(t,11)}
      <div style="font-size:20px;font-weight:700;margin-top:6px">${esc(t.name)}</div>
      <div class="mb8">${typePills(t)} <span class="rar-txt ${t.rarity}" style="font-weight:700">${t.rarity}</span></div>
      <div class="dim" style="font-size:13px;margin-bottom:10px">"${esc(t.lore)}"</div>
      <div style="text-align:left;max-width:220px;margin:0 auto 12px">${statBars(t.base_stats)}</div>
      <div class="dim" style="font-size:11px;margin-bottom:8px">Exclusiva de hoy. Mañana llega otra distinta.</div>
      ${btn}
      <button class="btn ghost" data-act="close">CERRAR</button>
    </div></div>`);
  renderCanvases($("#overlay"));
}
async function claimUnique(){
  try{ const r=await api('/daily/unique/claim',{method:'POST'}); S.user=Object.assign(S.user||{},r.user);
    await refreshCollection(); refreshChips(); SFX.play('claim'); buzz([30,40,30,40,80]);
    if(window.POC&&window.POC.confetti)window.POC.confetti();
    toast('✨ ¡Es tuya!'); await refreshDaily(); closeOverlay(); if($("#s-home").classList.contains('active'))renderHome(); }
  catch(e){ toast(e.data&&e.data.error==='insufficient'?'No tienes monedas suficientes':'No se pudo cazar'); }
}
// Profecía del Oráculo (lote de mañana). Se carga async tras el primer render.
function oracleCard(){
  if(!FEATURES.oracle||!unlocked('oracle')) return '';
  return `<div class="panel" id="oracle-card" style="border-color:var(--epi);padding:9px 11px;font-size:12px">
    🔮 <b style="color:var(--epi)">El Oráculo</b> <span class="dim" id="oracle-text">consulta los astros…</span></div>`;
}
async function loadOracle(){
  if(!FEATURES.oracle)return; const el=$("#oracle-text"); if(!el)return;
  try{ const o=await api('/oracle'); el.innerHTML=`«${esc(o.text)}»`; }catch(e){ el.textContent='el futuro es incierto.'; }
}
// Rejilla de MODOS de juego innovadores (puzzle, jefe mundial, némesis, arena).
function modesGrid(){
  if(!unlocked('modes')) return '';
  const tiles=[];
  if(FEATURES.puzzle) tiles.push(`<div class="mode-tile" data-act="openPuzzle"><span class="mi">🧩</span><b>Puzzle Diario</b><span class="dim">mín. turnos · igual para todos</span></div>`);
  if(FEATURES.worldboss) tiles.push(`<div class="mode-tile" data-act="openBoss"><span class="mi">🐉</span><b>Jefe Mundial</b><span class="dim" id="boss-mini">raid cooperativa</span></div>`);
  if(FEATURES.nemesis) tiles.push(`<div class="mode-tile" data-act="openNemesis"><span class="mi">😈</span><b>Tu Némesis</b><span class="dim" id="nem-mini">rival recurrente</span></div>`);
  if(FEATURES.arena) tiles.push(`<div class="mode-tile" data-act="openArena"><span class="mi">⚔️</span><b>Arena Sellada</b><span class="dim">draft · sin colección</span></div>`);
  if(!tiles.length) return '';
  return `<div class="modes">${tiles.join('')}</div>`;
}
// Bloque "Tu equipo" + botón de combate PvP (en INICIO).
function teamPower(team){
  // Índice simple de fuerza: suma de stats escalados (HP ponderado a /10).
  return Math.round(team.reduce((a,i)=>{const s=i.template.stats;
    return a+(s?s.hp/10+s.atkP+s.atkS+s.defP+s.defS+s.spd:0);},0));
}
// Sinergia de un conjunto de INSTANCIAS (mapea a {type} y llama al motor).
function teamSynergyOf(instances){
  const units=(instances||[]).map(i=>({type:i.template&&(i.template.type||(i.template.types&&i.template.types[0]))}));
  return ENGINE.teamSynergy(units);
}
// Chip visible de la sinergia activa (o pista si aún no hay equipo de 2+).
function synergyChip(syn){
  if(!syn) return `<span class="syn-chip none">Sinergia: equipo de 2+ aigrons</span>`;
  return `<span class="syn-chip s-${syn.key}" title="${esc(syn.desc)}">✦ ${esc(syn.label)} <span class="syn-d">${esc(syn.desc)}</span></span>`;
}
function teamCombatHTML(){
  const team=S.team.map(instById).filter(Boolean);
  const power=teamPower(team);
  // Sin energía: el botón explica CUÁNDO podrás volver a luchar (cuenta atrás
  // viva vía tickCountdowns) en vez de un disabled mudo.
  const noEnergy=S.user.energy<1;
  const btnLabel=noEnergy?`SIN ENERGÍA — ⚡ en <span id="pvp-wait">--:--</span>`:'⚔️ COMBATE PvP EN VIVO — ⚡1';
  return `<div class="panel"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="font-size:14px">Tu equipo</b>
      ${power?`<span class="dim" style="font-size:12px">PODER <b style="color:var(--cyan)">${power}</b></span>`:''}
      <button class="btn sm ghost" data-act="editTeam">EDITAR</button></div>
      <div class="grid team-grid">${team.length?team.map(i=>cardHTML(i)).join(""):'<div class="grid-hint" data-act="editTeam">＋ Elige 3 aigrons de tu colección</div>'}</div>
    </div>
    <button class="btn mag mb8" data-act="prepBattle" ${(team.length<1||noEnergy)?'disabled':''}>${btnLabel}</button>`;
}
async function doClaim(){
  try{
    const r=await api('/daily/claim',{method:'POST'});
    const t=registerTpl(r.instance.template);
    await Promise.all([refreshMe(),refreshDaily(),refreshCollection()]);
    refreshChips();
    SFX.play('claim'); buzz([30,40,30,40,80]); if(window.POC&&window.POC.confetti)window.POC.confetti();
    const iid=r.instance.instance_id;
    const variant=FEATURES.prismatic?ENGINE.variantOf(iid):null;
    const pot=(ENGINE.ivFor(iid)||{}).potential||0;
    if(variant==='aurea'){ SFX.play('claim'); buzz([60,30,60,30,120]); if(window.POC&&window.POC.confetti){window.POC.confetti();setTimeout(window.POC.confetti,300);} }
    const vBanner=variant==='aurea'?`<div style="color:var(--gold);font-family:var(--pixel);font-size:11px;margin-bottom:6px">✨ ¡ÁUREA! ✨ <span class="dim" style="font-family:var(--ui)">1 de 400</span></div>`
      :(variant==='prismatica'?`<div style="color:var(--epi);font-weight:700;font-size:13px;margin-bottom:6px">✦ ¡PRISMÁTICA! <span class="dim" style="font-size:10px">1 de 100</span></div>`:'');
    const rays=(t.rarity==="EPICA"||t.rarity==="LEGENDARIA"||r.first||variant)?'<div class="rays"></div>':'';
    // Primer reclamo de la cuenta: es TU ESTRELLA (nv5, protegida) y 2 crías se
    // unen al equipo — el momento del huevo vuelve a ser el clímax (feedback).
    const firstTxt=r.first?`<div style="color:var(--gold);font-size:13px;font-weight:700;margin-bottom:4px">⭐ ¡Tu estrella! Nv.${r.instance.level} · protegida</div>
        <div class="dim" style="font-size:12px;margin-bottom:8px">Dos crías de nivel 1 se han unido a tu equipo:${(r.companions||[]).map(c=>' '+esc(c.template.name)).join(' ·')}</div>`:'';
    openOverlay(`<div class="center reveal" style="position:relative">${rays}
      <div style="position:relative;z-index:2">
        <div style="font-family:var(--pixel);font-size:11px;color:var(--cyan);margin-bottom:8px">${r.first?'¡TU PRIMER AIGRÓN!':'¡HA NACIDO!'}</div>
        ${vBanner}
        <span class="art-wrap ${variant==='aurea'?'aurea':variant==='prismatica'?'prismatic':''}">${artTag(t,11,iid)}</span>
        <div style="font-size:20px;font-weight:700;margin-top:6px">${esc(t.name)}</div>
        <div class="mb8">${typePills(t)} <span class="rar-txt ${t.rarity}" style="font-weight:700">${t.rarity}</span>
          <span class="dim" style="font-size:11px"> · Potencial <b style="color:${pot>=75?'var(--green)':pot>=45?'var(--gold)':'var(--cyan)'}">${pot}%</b></span></div>
        ${firstTxt}
        ${r.duplicate?`<div style="color:var(--cyan);font-size:12px;font-weight:700;margin-bottom:6px">🔁 Repetida del álbum · +${r.dust||0}✨ polvo</div>`:''}
        <div class="dim" style="font-size:13px;margin-bottom:10px">"${esc(t.lore)}"</div>
        <div style="text-align:left;max-width:220px;margin:0 auto 12px">${statBars(ENGINE.applyIV(t.base_stats,iid))}</div>
        ${!localStorage.getItem('aigrons_first_fight_done')?'<button class="btn mag mb8" data-act="firstFight">⚔️ ¡TU PRIMER COMBATE!</button>':''}
        <button class="btn" data-act="toCollection">A LA COLECCIÓN</button>
        <button class="btn ghost cyan mt8" data-act="shareAig" data-arg="${t.id}">📤 COMPARTIR</button>
      </div></div>`);
  }catch(e){ toast(e.data&&e.data.error==='already_claimed'?'Ya reclamaste hoy':'No se pudo reclamar'); }
}
// ---------------------- Web Push (recordatorio diario) -----------------------
function b64ToU8(b64){const p='='.repeat((4-b64.length%4)%4);const s=atob((b64+p).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(s,c=>c.charCodeAt(0));}
async function pushEnable(){
  localStorage.setItem('aigrons_push_asked','1');
  try{
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){renderHome();return;}
    const k=await api('/push/key');
    if(!k.enabled||!k.key){toast('Notificaciones no disponibles');renderHome();return;}
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToU8(k.key)});
    await api('/push/subscribe',{method:'POST',body:{subscription:sub.toJSON()}});
    toast('🔔 Te avisaremos cada día');
  }catch(e){ toast('No se pudo activar'); }
  renderHome();
}

// ------------------ Onboarding: primer combate guiado ------------------------
// Tras el PRIMER reclamo, CTA directa a un combate (el bot del matchmaking
// garantiza rival aunque no haya nadie): time-to-first-wow < 1 minuto.
async function firstFight(){
  localStorage.setItem('aigrons_first_fight_done','1');
  closeOverlay();
  try{
    if(!S.team.length){
      const slots=S.collection.slice(0,3).map(i=>i.instance_id);
      const r=await api('/team',{method:'PUT',body:{slots}});
      S.team=r.slots;
    }
    startLivePvp(S.team[0],'NEUTRAL');
  }catch(e){ toast('No se pudo preparar el equipo'); go('home'); }
}

// Compartir el aigrón (viralidad): compone una tarjeta PNG (sprite + nombre +
// rareza + fecha) y usa Web Share si está disponible; si no, descarga.
const RARITY_COLOR={COMUN:'#8b86b8',RARA:'#43b6ff',EPICA:'#c061ff',LEGENDARIA:'#ffd23f'};
// Carga opcional de un asset del pack UI (resuelve null si no existe: fallback).
function loadUiArt(src){
  return new Promise(res=>{
    const img=new Image();
    img.onload=()=>res(img); img.onerror=()=>res(null);
    setTimeout(()=>res(null),1500); // sin red lenta bloqueando el share
    img.src=src;
  });
}
async function shareAig(tplId){
  const t=tpl(tplId); if(!t)return;
  const c=document.createElement('canvas'); c.width=480; c.height=600;
  const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#0a0818'; g.fillRect(0,0,480,600);
  // Plantilla del pack de arte IA si existe; si no, el diseño plano de siempre.
  const bg=await loadUiArt('/art/ui/share-bg.png');
  if(bg) g.drawImage(bg,0,0,480,600);
  g.strokeStyle='#3a3270'; g.lineWidth=6; if(!bg)g.strokeRect(10,10,460,580);
  g.fillStyle='#34f5e4'; g.font='bold 26px monospace'; g.textAlign='center';
  g.fillText('AIGRONS',240,52);
  const sc=document.createElement('canvas'); drawAigron(sc,t,8); // sprite procedural (sin CORS)
  g.drawImage(sc,(480-352)/2,84,352,352);
  g.fillStyle='#e8e4ff'; g.font='bold 30px monospace'; g.fillText(t.name,240,486);
  g.fillStyle=RARITY_COLOR[t.rarity]||'#8b86b8'; g.font='bold 20px monospace';
  g.fillText(`${t.rarity} · ${typesLabel(t)}`,240,518);
  g.fillStyle='#aaa2dc'; g.font='16px monospace';
  g.fillText(`Álbum de ${(S.daily&&S.daily.season&&S.daily.season.label)||''} · aigrons.app`,240,556);
  c.toBlob(async(b)=>{
    if(!b){toast('No se pudo crear la imagen');return;}
    const file=new File([b],'aigron-'+(t.name||'hoy')+'.png',{type:'image/png'});
    try{
      if(navigator.canShare&&navigator.canShare({files:[file]})){
        await navigator.share({files:[file],title:t.name,text:`Mi aigrón de hoy: ${t.name} (${t.rarity}) 🥚 #AIGRONS`});
        return;
      }
    }catch(e){ if(e&&e.name==='AbortError')return; }
    const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=file.name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    toast('Imagen guardada 📸');
  });
}
async function claimMission(key){
  try{ const r=await api('/missions/claim',{method:'POST',body:{key}});
    await refreshMe(); refreshChips(); renderHome(); toast('+'+r.reward+'🪙'); SFX.play('claim'); }
  catch(e){ toast('Aún no completada'); }
}

/* ============== MECÁNICAS INNOVADORAS (UI cliente) ============== */
// -- PUZZLE DIARIO: equipo y enemigos fijos, gana en MENOS turnos --------------
async function openPuzzle(){
  let p; try{ p=await api('/puzzle'); }catch(e){ toast('Puzzle no disponible'); return; }
  const best=p.best?`Tu récord: <b style="color:var(--gold)">${p.best.turns} turnos</b> (${p.best.hpLeft} HP)`:'Sin resolver aún';
  const rk=(p.ranking&&p.ranking.rows||[]).slice(0,5).map(r=>`<div class="rank-row ${r.me?'me':''}" style="padding:4px 6px;font-size:12px"><span class="pos">${r.pos}</span><span class="nm">${esc(r.name)}</span><span style="color:var(--gold)">${r.turns}t</span></div>`).join('')||'<div class="dim" style="font-size:12px;padding:6px">Sé el primero en resolverlo.</div>';
  openOverlay(`<div class="center">
    <div style="font-family:var(--pixel);font-size:13px;color:var(--cyan);margin-bottom:6px">🧩 PUZZLE DIARIO</div>
    <div class="dim mb8" style="font-size:13px">El MISMO reto para todo el mundo hoy. Gana en el mínimo de turnos.<br>${best}</div>
    <div class="dim" style="font-size:11px;margin-bottom:8px">Tu equipo (fijo) vs enemigos (fijos) · nivel ${p.level}</div>
    <button class="btn mag" data-act="puzzlePlay">▶ JUGAR EL PUZZLE</button>
    <div class="mt8" style="text-align:left"><b style="font-size:12px">🏆 Mejores de hoy</b>${rk}</div>
    <button class="btn sm ghost mt8" data-act="close">CERRAR</button></div>`);
  PUZZLE=p;
}
let PUZZLE=null;
function puzzlePlay(){
  if(!PUZZLE)return; const p=PUZZLE; closeOverlay();
  startLocalCombat({team:p.team,enemy:p.enemy,seed:p.seed,mode:'puzzle',title:'PUZZLE',
    onResolve:(decisions)=>{
      api('/puzzle/solve',{method:'POST',body:{decisions}}).then(r=>{
        CB=null;
        SFX.play(r.solved?'win':'lose');
        const rk=(r.ranking&&r.ranking.me)?`Posición: <b style="color:var(--cyan)">#${r.ranking.me.pos}</b>`:'';
        openOverlay(`<div class="center">
          <div style="font-family:var(--pixel);font-size:15px;color:${r.solved?'var(--gold)':'var(--ink-dim)'};margin-bottom:8px">${r.solved?'¡RESUELTO!':'NO LO LOGRASTE'}</div>
          <div style="font-size:40px">${r.solved?'🧩':'💀'}</div>
          ${r.solved?`<div class="mt8">En <b style="color:var(--cyan)">${r.turns} turnos</b> · ${r.hpLeft} HP restante<br>${rk}</div>
            <div class="panel mt8" style="font-size:12px">Comparte: <b>AIGRONS Puzzle — ${r.turns} turnos 🧩</b></div>
            <button class="btn mt8" data-act="puzzleShare" data-arg="${r.turns}">📤 COMPARTIR</button>`:'<div class="dim mt8" style="font-size:13px">Cambia el orden de tus habilidades e inténtalo otra vez.</div>'}
          <button class="btn ghost mt8" data-act="goHome">VOLVER</button></div>`);
      }).catch(()=>{ toast('Error al validar'); CB=null; go('home'); });
    }});
}
function puzzleShare(turns){
  const txt=`AIGRONS Puzzle Diario — resuelto en ${turns} turnos 🧩 ¿puedes hacerlo mejor?`;
  if(navigator.share){ navigator.share({text:txt}).catch(()=>{}); }
  else { navigator.clipboard&&navigator.clipboard.writeText(txt); toast('Copiado al portapapeles'); }
}

// -- JEFE MUNDIAL: raid cooperativa con HP global ------------------------------
async function openBoss(){
  let b; try{ b=await api('/worldboss'); }catch(e){ toast('Jefe no disponible'); return; }
  BOSS=b;
  const top=(b.top||[]).slice(0,5).map(x=>`<div class="rank-row ${x.me?'me':''}" style="padding:4px 6px;font-size:12px"><span class="pos">${x.pos}</span><span class="nm">${esc(x.name)}${x.guildTag?` <span style="color:var(--gold);font-size:10px">[${esc(x.guildTag)}]</span>`:''}</span><span style="color:var(--magenta)">${fmtBig(x.damage)}</span></div>`).join('')||'<div class="dim" style="font-size:12px;padding:6px">Nadie le ha pegado aún. ¡Sé el primero!</div>';
  // Clasificación por CONSTELACIÓN (gremios que más daño hacen juntos).
  const topG=(b.topGuilds||[]).slice(0,5).map(x=>`<div class="rank-row ${x.mine?'me':''}" style="padding:4px 6px;font-size:12px"><span class="pos">${x.pos}</span><span class="nm">${esc(x.name)} <span style="color:var(--gold);font-size:10px">[${esc(x.tag)}]</span> <span class="dim" style="font-size:10px">·${x.contributors}</span></span><span style="color:var(--cyan)">${fmtBig(x.damage)}</span></div>`).join('')||'<div class="dim" style="font-size:12px;padding:6px">Ninguna constelación ha pegado aún.</div>';
  const myG=b.myGuild?`<div class="dim" style="font-size:11px;margin-top:2px">Tu constelación: <b style="color:var(--cyan)">${fmtBig(b.myGuild.damage)}</b>${b.myGuild.rank?` · #${b.myGuild.rank}`:''}</div>`:'';
  // Arte IA del jefe si el job semanal lo generó; emoji 🐉 si no (fallback).
  const bossArt=b.image?`<img src="${b.image}" alt="${esc(b.name)}" class="boss-art">`:'<div style="font-size:54px;line-height:1.1">🐉</div>';
  openOverlay(`<div class="center">
    ${bossArt}
    <div style="font-family:var(--pixel);font-size:13px;color:var(--red);margin:6px 0 4px">${esc(b.name)}</div>
    <div class="dim" style="font-size:11px">Jefe Mundial · tipo ${b.type} · toda la comunidad colabora</div>
    <div class="boss-hp"><i style="width:${b.pct}%"></i><span>${fmtBig(b.hpLeft)} / ${fmtBig(b.hpMax)} HP</span></div>
    ${b.defeated?'<div style="color:var(--gold);font-weight:700">🏆 ¡La comunidad lo derrotó!</div>':`<button class="btn mag" data-act="bossFight">⚔️ GOLPEAR — ⚡1</button>`}
    <div class="dim mt8" style="font-size:11px">Tu daño total: <b style="color:var(--magenta)">${fmtBig(b.myDamage)}</b> (${b.myHits} golpes)</div>
    <div class="mt8" style="text-align:left"><b style="font-size:12px">🏆 Top héroes</b>${top}</div>
    <div class="mt8" style="text-align:left"><b style="font-size:12px">🌌 Top constelaciones</b>${myG}${topG}</div>
    <button class="btn sm ghost mt8" data-act="close">CERRAR</button></div>`);
}
let BOSS=null;
function bossFight(){
  // El encuentro (tu equipo + avatares del jefe + seed) viene del SERVIDOR en
  // GET /worldboss: el cliente anima EXACTAMENTE lo que el servidor validará.
  if(!BOSS||!BOSS.encounter){ toast('Jefe no disponible'); return; }
  const enc=BOSS.encounter;
  if(!enc.team.length){ toast('Necesitas equipo'); return; }
  closeOverlay();
  startLocalCombat({team:enc.team,enemy:enc.enemy,seed:enc.seed,mode:'boss',title:'JEFE MUNDIAL',
    onResolve:(decisions)=>{
      api('/worldboss/hit',{method:'POST',body:{decisions}}).then(r=>{
        CB=null; refreshMe().then(refreshChips);
        SFX.play('crit'); buzz(60);
        openOverlay(`<div class="center">
          <div style="font-family:var(--pixel);font-size:14px;color:var(--magenta);margin-bottom:8px">💥 ¡GOLPE!</div>
          <div style="font-size:40px">🐉</div>
          <div class="mt8">Daño infligido: <b style="color:var(--magenta)">${fmtBig(r.dmg||0)}</b></div>
          ${r.justDefeated?'<div style="color:var(--gold);font-weight:700;margin-top:6px">🏆 ¡LO HAS REMATADO! Recompensa para toda la comunidad.</div>':`<div class="boss-hp mt8"><i style="width:${r.boss.pct}%"></i><span>${r.boss.pct}%</span></div>`}
          <button class="btn mt8" data-act="openBoss">SEGUIR</button>
          <button class="btn ghost mt8" data-act="goHome">VOLVER</button></div>`);
      }).catch(e=>{ toast(e.status===402?'Sin energía ⚡':'Error'); CB=null; go('home'); });
    }});
}

// -- NÉMESIS: rival recurrente ------------------------------------------------
async function openNemesis(){
  let n; try{ n=await api('/nemesis'); }catch(e){ toast('Némesis no disponible'); return; }
  registerUnitArt(n.enemy);
  const enemyCards=n.enemy.map(u=>`<div class="card" style="border-color:var(--red)">${artTag(tpl(u.tplId),5)}<div class="nm">${esc(u.name)}</div><div class="ty dim">Nv${u.level}</div></div>`).join('');
  openOverlay(`<div class="center">
    <div style="font-family:var(--pixel);font-size:14px;color:var(--red);margin-bottom:4px">😈 ${esc(n.name)}</div>
    <div class="dim" style="font-size:11px">Tu némesis · nivel ${n.level} (tier ${n.tier})</div>
    <div class="dim mb8" style="font-size:12px">Te ha ganado <b style="color:var(--red)">${n.winsVsMe}</b> · la has vencido <b style="color:var(--green)">${n.myWins}</b><br>Eligió su equipo para <b>contrarrestar el tuyo</b>.</div>
    <div class="grid" style="margin-bottom:10px">${enemyCards}</div>
    <button class="btn mag" data-act="nemesisFight">⚔️ ENFRENTARLA — ⚡1</button>
    <button class="btn sm ghost mt8" data-act="close">CERRAR</button></div>`);
  renderCanvases($("#modal"));
  NEM=n;
}
let NEM=null;
function nemesisFight(){
  if(!NEM)return; closeOverlay();
  // Equipo + enemigo + seed vienen del servidor (GET /nemesis): la animación
  // coincide 1:1 con la validación del POST (mismo encuentro determinista).
  if(!NEM.team||!NEM.team.length){ toast('Necesitas equipo'); return; }
  startLocalCombat({team:NEM.team,enemy:NEM.enemy,seed:NEM.seed,mode:'nemesis',title:'NÉMESIS',
    onResolve:(decisions)=>{
      api('/nemesis/fight',{method:'POST',body:{decisions}}).then(r=>{
        CB=null; refreshMe().then(refreshChips);
        SFX.play(r.win?'win':'lose'); buzz(r.win?[40,60,80]:60);
        openOverlay(`<div class="center">
          <div style="font-family:var(--pixel);font-size:15px;color:${r.win?'var(--gold)':'var(--red)'};margin-bottom:8px">${r.win?'¡NÉMESIS DERROTADA!':'TE HA VENCIDO'}</div>
          <div style="font-size:40px">${r.win?'🏅':'😈'}</div>
          <div class="mt8">${r.win?`Huye herida… volverá más fuerte (tier ${r.nemesis.newTier}). <br>🪙 +${r.coins}`:'Entrena y vuelve a por ella.'}</div>
          ${r.win?'<div class="dim mt8" style="font-size:11px">🏅 Logro: cazador de némesis</div>':''}
          <button class="btn mt8" data-act="goHome">VOLVER</button></div>`);
      }).catch(e=>{ toast(e.status===402?'Sin energía ⚡':e.status===400?'Equipo vacío':'Error'); CB=null; go('home'); });
    }});
}

// -- ARENA SELLADA: draft de 3 de 6 del lote, sin tu colección -----------------
let arenaDraft=null, arenaPicks=[];
async function openArena(){
  let d; try{ d=await api('/arena/draft'); }catch(e){ toast('Arena no disponible'); return; }
  arenaDraft=d; arenaPicks=[];
  renderArenaDraft();
}
function renderArenaDraft(){
  const cands=arenaDraft.candidates.map((c,i)=>{const sel=arenaPicks.includes(i);
    registerTpl(c);
    return `<div class="card r-${c.rarity}" data-act="arenaPick" data-arg="${i}" style="${sel?'outline:3px solid var(--cyan);outline-offset:-3px':''}">
      ${sel?`<div class="badge">${arenaPicks.indexOf(i)+1}</div>`:''}${artTag(c,5)}
      <div class="nm">${esc(c.name)}</div><div class="ty rar-txt ${c.rarity}">${c.rarity}</div></div>`;}).join('');
  openOverlay(`<div>
    <div class="center mb8"><b style="font-size:14px">⚔️ ARENA SELLADA</b>
      <div class="dim" style="font-size:11px">Elige 3 de 6 del destacado de hoy. Sin tu colección: habilidad pura. (${arenaPicks.length}/3)</div></div>
    <div class="grid">${cands}</div>
    <button class="btn mag mt8" style="width:100%" data-act="arenaStart" ${arenaPicks.length===3?'':'disabled'}>⚔️ BUSCAR RIVAL</button>
    <button class="btn sm ghost mt8" style="width:100%" data-act="close">CANCELAR</button></div>`);
  renderCanvases($("#modal"));
}
function arenaPick(i){ i=+i; const k=arenaPicks.indexOf(i);
  if(k>=0)arenaPicks.splice(k,1); else if(arenaPicks.length<3)arenaPicks.push(i); else{toast('Ya tienes 3');return;}
  renderArenaDraft();
}
function arenaStart(){
  if(arenaPicks.length!==3)return;
  const ids=arenaPicks.map(i=>arenaDraft.candidates[i].id);
  closeOverlay();
  // Reusa el PvP en vivo con modo arena: el servidor monta el equipo desde estos ids.
  startLivePvp(null,'NEUTRAL',null,{arena:ids});
}

const fmtBig=(n)=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n|0);

/* ====================== PERFIL + LOGROS + REPLAYS ====================== */
async function openProfile(){
  let p,ach;
  try{ [p,ach]=await Promise.all([api('/profile'),api('/achievements')]); }catch(e){ toast('No se pudo cargar el perfil'); return; }
  const winrate=p.totalWins+p.totalLosses>0?Math.round(p.totalWins/(p.totalWins+p.totalLosses)*100):0;
  const stat=(l,v)=>`<div style="flex:1;min-width:90px;text-align:center;padding:6px 2px;border:1px solid var(--line);background:#0a0818"><div style="font-family:var(--pixel);font-size:13px;color:var(--cyan)">${v}</div><div class="dim" style="font-size:10px">${l}</div></div>`;
  const weeks=(p.weeks||[]).map(w=>`<div class="rank-row" style="padding:4px 6px;font-size:12px"><span class="nm">Semana ${w.week_start.slice(5,10)}</span><span class="rar-txt" style="color:var(--gold)">${w.league}</span><span style="color:var(--cyan);margin-left:8px">${w.points} pts</span></div>`).join('')||'<div class="dim" style="font-size:12px;padding:6px">Aún sin semanas cerradas.</div>';
  const recent=(p.recent||[]).map(b=>`<div class="rank-row" style="padding:4px 6px;font-size:12px">
     <span>${b.result==='WIN'?'🏆':'💀'}</span><span class="nm">${b.pvp?('vs '+esc(b.oppName||'rival')):'PvE'}</span>
     ${b.hasReplay?`<button class="btn sm ghost" style="padding:2px 8px;font-size:11px" data-act="watchReplay" data-arg="${b.id}">▶ VER</button>`:''}</div>`).join('')||'<div class="dim" style="font-size:12px;padding:6px">Sin combates recientes.</div>';
  const arow=(a)=>{const pct=Math.min(100,Math.round(a.progress/a.goal*100));
    return `<div class="mis ${a.done?'done':''}"><div class="mrow">
      <span>${a.claimed?'🏅':a.done?'✅':'▫️'} <b>${a.name}</b> <span class="dim" style="font-size:11px">${a.desc} (${a.progress}/${a.goal})</span></span>
      ${a.done&&!a.claimed?`<button class="btn sm gold pulse" style="padding:3px 7px" data-act="claimAch" data-arg="${a.key}">+${a.reward.coins}🪙${a.reward.gems?'+'+a.reward.gems+'💎':''}</button>`
        :`<span style="color:var(--gold);font-size:11px">${a.claimed?'✔':'+'+a.reward.coins+'🪙'}</span>`}
      </div><div class="mis-bar"><i style="width:${pct}%"></i></div></div>`;};
  openOverlay(`<div>
    <div class="center mb8">
      <b id="prof-name" style="font-size:17px">${esc(p.displayName)}</b>
      <button class="help" data-act="editName" title="Cambiar nombre" style="width:22px;height:22px;font-size:11px">✏️</button>
      <div class="dim" style="font-size:11px">🏅 ${p.league} · mejor: ${p.bestLeague}</div>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:4px;margin-bottom:10px">
      ${stat('victorias',p.totalWins)}${stat('win rate',winrate+'%')}${stat('mejor racha',p.bestStreak+'d')}
      ${stat('aigrons',p.collectionCount)}${stat('mazmorras',p.dungeonsCleared)}${stat('fusiones',p.fusionsDone)}
      ${stat('🛡 defensas',p.defenseWins||0)}
    </div>
    <div class="mb8"><b style="font-size:13px">🏅 Logros</b>${ach.map(arow).join('')}</div>
    <div class="mb8"><b style="font-size:13px">📅 Tus semanas de liga</b>${weeks}</div>
    <div class="mb8"><b style="font-size:13px">⚔️ Últimos combates</b>${recent}</div>
    <button class="btn sm ghost" style="width:100%" data-act="close">CERRAR</button>
  </div>`);
}
async function editName(){
  const cur=$("#prof-name")?$("#prof-name").textContent:'';
  const name=prompt('Nuevo nombre (3-16 caracteres):',cur);
  if(!name||name.trim()===cur)return;
  try{ const r=await api('/me/name',{method:'POST',body:{name:name.trim()}});
    S.user.displayName=r.displayName; toast('Nombre cambiado'); openProfile(); }
  catch(e){ toast('Nombre no válido'); }
}
async function claimAch(key){
  try{ const r=await api('/achievements/claim',{method:'POST',body:{key}});
    await refreshMe(); refreshChips(); SFX.play('claim'); buzz(60);
    toast(`🏅 +${r.reward.coins||0}🪙${r.reward.gems?' +'+r.reward.gems+'💎':''}`); openProfile(); }
  catch(e){ toast('Aún no desbloqueado'); }
}
// ---- REPLAY: reproduce un combate grabado (equipos + log + estado final) ----
async function watchReplay(battleId){
  let rep=null; try{ rep=await api('/battle/'+battleId+'/replay'); }catch(e){ toast('Replay no disponible'); return; }
  closeOverlay();
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  $("#s-battle").classList.add("active");
  registerUnitArt(rep.team); registerUnitArt(rep.opponent);
  const A=rep.team.map((s,i)=>mkUnit(s,'A',i));
  const B=rep.opponent.map((s,i)=>mkUnit(s,'B',i));
  CB={A,B,seed:0,battleId:null,pvp:false,live:false,mode:'replay',you:rep.you||'A',oppName:'',
      rng:null,turn:0,order:[],oi:0,plan:{},planTurn:0,selecting:null,phase:'replay',speed:savedSpeed(),
      decisions:[],timer:null,planTimer:null,initA:rep.team,initB:rep.opponent,ended:false};
  buildArena();
  const pl=$("#planner"); if(pl)pl.innerHTML='';
  const ctrl=document.querySelector('#s-battle .combat-ctrl');
  if(ctrl)ctrl.innerHTML=`<button class="cbtn" id="rp-speed" data-act="replaySpeed">▶▶ 1x</button><button class="cbtn" data-act="replayExit">✕ SALIR</button>`;
  setBanner('▶ REPLAY');
  const swapNeeded=(rep.you==='B');
  const loc=(uid)=>(!uid?uid:(swapNeeded?(uid[0]==='A'?'B':'A')+uid.slice(1):uid));
  const byUid=(luid)=>CB.A.find(x=>x.uid===luid)||CB.B.find(x=>x.uid===luid);
  const log=rep.log||[]; let i=0;
  function tick(){
    if(!CB||CB.mode!=='replay')return;
    if(i>=log.length){
      // estado final autoritativo (corrige curas no registradas en el log)
      ((rep.end&&rep.end.A)||[]).forEach(s=>{const u=byUid(loc(s.uid));if(u)u.hp=s.hp;});
      ((rep.end&&rep.end.B)||[]).forEach(s=>{const u=byUid(loc(s.uid));if(u)u.hp=s.hp;});
      refreshArena(); setBanner('▶ Fin del replay');
      CB.timer=null; return;
    }
    const e=log[i++];
    const actor=byUid(loc(e.uid));
    [...CB.A,...CB.B].forEach(x=>x.el&&x.el.classList.remove("acting"));
    if(actor&&actor.el)actor.el.classList.add("acting");
    const who=actor&&actor.team==='A'?'var(--cyan)':'var(--magenta)';
    const nm=actor?actor.name:e.name;
    if(e.poison&&actor){actor.hp=Math.max(0,actor.hp-e.poison);if(actor.el)floatNum(actor,"☠"+e.poison,"var(--epi)");}
    if(e.stunned)setBanner(`<span style="color:${who}">${nm}</span> está aturdido 💫`);
    else if(e.died){if(actor)actor.hp=0;setBanner(`<span style="color:${who}">${nm}</span> cae ☠`);}
    else if(e.guard)setBanner(`<span style="color:${who}">${nm}</span> se protege 🛡️`);
    else if(e.ability)setBanner(`<span style="color:${who}">${nm}</span> usa <b style="color:var(--gold)">${e.ability}</b>`);
    else if(e.hits&&e.hits.length)setBanner(`<span style="color:${who}">${nm}</span> ataca`);
    (e.hits||[]).forEach(h=>{const t=byUid(loc(h.tgt&&h.tgt.uid));if(!t)return;
      t.hp=Math.max(0,t.hp-h.dmg);
      if(t.el){t.el.classList.remove("hit");void t.el.offsetWidth;t.el.classList.add("hit");
        floatNum(t,(h.crit?"¡":"")+h.dmg+(h.crit?"!":""),h.crit?"var(--gold)":"#fff",h.crit); impactFx(t,h);}});
    refreshArena();
    CB.timer=setTimeout(tick,tickMs());
  }
  CB.timer=setTimeout(tick,400);
}
function replaySpeed(){ if(!CB||CB.mode!=='replay')return; CB.speed=CB.speed===1?2:1; const b=$("#rp-speed"); if(b)b.textContent='▶▶ '+CB.speed+'x'; }
function replayExit(){ if(CB&&CB.timer)clearTimeout(CB.timer); CB=null; go('home'); openProfile(); }

/* ====================== COLECCIÓN ====================== */
let collFilter="TODOS", collSort="RECIENTE", collSearch="";
const RARITY_ORDER={LEGENDARIA:0,EPICA:1,RARA:2,COMUN:3};
const isNewToday=(i)=>i.obtained_at&&new Date(i.obtained_at).toDateString()===new Date().toDateString();
async function renderCollection(){
  refreshChips();
  const fl=["TODOS","COMUN","RARA","EPICA","LEGENDARIA"];
  // Contador por rareza en cada filtro: comunica cuánto tienes de cada tipo.
  const counts={}; S.collection.forEach(i=>{counts[i.template.rarity]=(counts[i.template.rarity]||0)+1;});
  const fLabel=f=>f==="TODOS"?`TODOS · ${S.collection.length}`:`${f} · ${counts[f]||0}`;
  let items=S.collection.slice();
  if(collFilter!=="TODOS")items=items.filter(i=>i.template.rarity===collFilter);
  // Búsqueda por nombre/tipo (imprescindible cuando la colección crece).
  if(collSearch){const q=collSearch.toLowerCase();
    items=items.filter(i=>i.template.name.toLowerCase().includes(q)||(i.template.types||[i.template.type]).join(' ').toLowerCase().includes(q));}
  // Ordenación: RECIENTE (orden del servidor), NIVEL desc, RAREZA (leg→común, luego nivel).
  if(collSort==="NIVEL")items.sort((a,b)=>b.level-a.level);
  else if(collSort==="RAREZA")items.sort((a,b)=>(RARITY_ORDER[a.template.rarity]-RARITY_ORDER[b.template.rarity])||(b.level-a.level));
  const sorts=["RECIENTE","NIVEL","RAREZA"];
  // Badges de contexto: EQ (está en tu equipo) y NUEVO (obtenido hoy).
  const extraFor=(i)=>{const tags=[];
    if(S.team.includes(i.instance_id))tags.push('<div class="tag-eq">EQ</div>');
    if(isNewToday(i))tags.push('<div class="tag-new">NUEVO</div>');
    return tags.join("");};
  $("#s-collection").innerHTML=`
    <h2 class="title">COLECCIÓN <small>${S.collection.length} aigrons</small></h2>
    <div class="filters">${fl.map(f=>`<span class="f ${f===collFilter?'on':''}" data-act="setFilter" data-arg="${f}">${fLabel(f)}</span>`).join("")}</div>
    <div class="filters" style="margin-top:-4px">${sorts.map(s=>`<span class="f sortf ${s===collSort?'on':''}" data-act="setSort" data-arg="${s}">${s==='RECIENTE'?'🕐':s==='NIVEL'?'⬆':'★'} ${s}</span>`).join("")}
      <input id="coll-search" placeholder="🔍 buscar" value="${esc(collSearch)}" style="flex:1;min-width:90px;background:#0a0818;border:2px solid var(--line);color:var(--ink);font-family:var(--ui);font-size:12px;padding:4px 7px"></div>
    ${items.length?`<div class="grid">${items.map(i=>cardHTML(i,extraFor(i))).join("")}</div>`:'<div class="dim tc" style="padding:30px">Nada aquí'+(collSearch?' con esa búsqueda':' todavía')+'.</div>'}`;
  renderCanvases($("#s-collection"));
  $("#s-collection").querySelectorAll(".card").forEach(c=>c.onclick=()=>openDetail(c.dataset.iid));
  const si=$("#coll-search");
  if(si){ si.oninput=()=>{ collSearch=si.value; const pos=si.selectionStart; renderCollection(); const si2=$("#coll-search"); if(si2){si2.focus(); si2.setSelectionRange(pos,pos);} }; }
}
function setFilter(f){collFilter=f;renderCollection();}
function setSort(s){collSort=s;renderCollection();}
function openDetail(iid){
  const inst=instById(iid);if(!inst)return;const t=inst.template;
  const cost={dust:10*inst.level,coins:50*inst.level};
  const inTeam=S.team.includes(iid);
  // Singularidad por instancia: IV (±6%) aplicados a las stats mostradas, y
  // "potencial" (media 0..100). Cada captura es ligeramente distinta.
  const stats=ENGINE.applyIV(t.stats||t.base_stats, iid);
  const pot=(inst.potential!=null)?inst.potential:((ENGINE.ivFor(iid)||{}).potential||0);
  const variant=inst.variant||(FEATURES.prismatic?ENGINE.variantOf(iid):null);
  const atMax=inst.level>=ENGINE.LEVEL_MAX;
  const canLevel=S.user.dust>=cost.dust&&S.user.coins>=cost.coins&&!atMax;
  // Qué GANAS al subir de nivel (antes de pagar): deltas de stats escalados,
  // INCLUYENDO el salto de evolución si el próximo nivel cruza el umbral.
  let gainTxt='';
  if(!atMax){
    const b=t.base_stats;
    const stNow=ENGINE.evoStageAt(t.id,inst.level), stNext=ENGINE.evoStageAt(t.id,inst.level+1);
    const sc=(l)=>k=>Math.round(ENGINE.scaled(b[k],l)*ENGINE.evoPowerMult(t.id,l));
    const now=sc(inst.level), next=sc(inst.level+1);
    const dHp=next('hp')-now('hp'), dAtk=Math.max(next('atkP')-now('atkP'),next('atkS')-now('atkS')), dSpd=next('spd')-now('spd');
    const evoFlash=stNext>stNow?`<b style="color:var(--cyan)">🧬 ¡EVOLUCIONA!</b> · `:'';
    gainTxt=`<div class="dim" style="font-size:11px;margin-top:4px">Al subir: ${evoFlash}<b style="color:var(--green)">+${dHp} HP</b> · <b style="color:var(--green)">+${dAtk} ATQ</b> · <b style="color:var(--green)">+${dSpd} SPD</b></div>`;
  }
  // Si no alcanza, di POR QUÉ (qué falta) en vez de solo apagar el botón.
  const missing=[];
  if(!atMax&&S.user.dust<cost.dust)missing.push(`${cost.dust-S.user.dust}✨`);
  if(!atMax&&S.user.coins<cost.coins)missing.push(`${cost.coins-S.user.coins}🪙`);
  const vMult=variant==='aurea'?4:(variant==='prismatica'?2:1);
  const releaseDust=Math.round((ENGINE.RELEASE_DUST[t.rarity]||5)*vMult);
  const vLabel=variant==='aurea'?'<span style="color:var(--gold);font-weight:700">✨ ÁUREA</span>'
    :(variant==='prismatica'?'<span style="color:var(--epi);font-weight:700">✦ PRISMÁTICA</span>':'');
  // Color del potencial: verde alto, gris medio, rojo bajo (referencia rápida).
  const potCol=pot>=75?'var(--green)':pot>=45?'var(--gold)':'var(--dim2,#9a93c7)';
  // EVOLUCIÓN: arte/nombre de la etapa actual y pista de la siguiente.
  let dispT=t;
  if(inst.evo) dispT=evoTpl(t.id,inst.evo.stage);
  else if(inst.shiny_image_url) dispT=Object.assign({},t,{image_url:inst.shiny_image_url});
  const evoNextE=ENGINE.evoNext(t.id,inst.level);
  const evoStage=inst.evo?inst.evo.stage:0;
  const evoLine=evoStage||evoNextE?
    `<div class="mb8" style="font-size:12px">${evoStage?`<span style="color:var(--cyan);font-weight:700">🧬 EVOLUCIÓN ${evoStage===2?'FINAL':'1ª'}</span>`:''}
      ${evoNextE?`${evoStage?' · ':''}<span class="dim">🧬 ${evoStage?'Evolución final':'Evoluciona'} en <b style="color:var(--cyan)">Nv.${evoNextE.at}</b></span>`:''}</div>`:'';
  // Sendero de evolución (#6): elegir/cambiar el perfil de stats de la forma evolucionada.
  const pathLabel=inst.evo_path&&ENGINE.EVO_PATHS[inst.evo_path]?ENGINE.EVO_PATHS[inst.evo_path].label:null;
  const pathLine=evoStage?`<div class="mb8" style="font-size:12px">${pathLabel
    ?`🧬 Sendero: <b style="color:var(--cyan)">${esc(pathLabel)}</b> <button class="btn sm ghost" style="padding:2px 8px;width:auto;margin-left:4px" data-act="chooseEvoPath" data-arg="${iid}">cambiar</button>`
    :`<button class="btn sm gold pulse" style="width:auto" data-act="chooseEvoPath" data-arg="${iid}">🧬 ELIGE SENDERO</button>`}</div>`:'';
  openOverlay(`<div class="center">
    <span class="art-wrap ${variant==='aurea'?'aurea':variant==='prismatica'?'prismatic':''}">${artTag(dispT,9,iid)}</span>
    <div style="font-size:20px;font-weight:700;margin-top:4px">${esc(dispT.name)} <span class="dim" style="font-size:13px">Nv.${inst.level}</span></div>
    <div class="mb8">${typePills(t)} <span class="rar-txt ${t.rarity}" style="font-weight:700">${t.rarity}</span>
      <span class="dim" style="font-size:11px"> · ${ENGINE.isPhysical(t.type)?'⚔️ Físico':'✨ Especial'}</span></div>
    <div class="mb8" style="font-size:12px">${vLabel?vLabel+' · ':''}Potencial <b style="color:${potCol}">${pot}%</b> <span class="dim" style="font-size:10px">(stats únicos de esta criatura)</span></div>
    ${evoLine}
    ${pathLine}
    <div style="text-align:left;margin-bottom:8px">${statBars(stats, t.stats?inst.level:1)}</div>
    <div class="panel" style="text-align:left;margin-bottom:10px">
      <div style="font-weight:700;color:var(--gold);font-size:14px">✨ ${ABILITIES[t.ability].name}
        <span class="dim" style="font-size:11px;font-weight:400">· ⚡${ABILITIES[t.ability].cost} · ${abilityKind(t.ability)}</span></div>
      <div style="font-size:13px;margin-top:5px;line-height:1.45">${abilityEffect(t.ability)}</div>
      ${t.lore?`<div class="dim" style="font-size:12px;margin-top:7px;font-style:italic;border-top:1px solid var(--line);padding-top:6px">"${t.lore}"</div>`:''}
    </div>
    <div class="mb8">
      <button class="btn sm" style="width:100%" data-act="levelUp" data-arg="${iid}" ${canLevel?'':'disabled'}>${atMax?`NIVEL MÁX (${ENGINE.LEVEL_MAX})`:`SUBIR NV (${cost.dust}✨ ${cost.coins}🪙)`}</button>
      ${missing.length?`<div style="font-size:11px;color:var(--red);margin-top:4px">Te faltan ${missing.join(' y ')}</div>`:gainTxt}
    </div>
    <div class="row mb8">
      <button class="btn sm ghost" style="flex:1" data-act="toggleFav" data-arg="${iid}">${inst.favorite?'★ Favorito':'☆ Favorito'}</button>
      <button class="btn sm ghost" style="flex:1" data-act="release" data-arg="${iid}" ${(inst.locked||inTeam)?'disabled':''}>LIBERAR +${releaseDust}✨</button>
    </div>
    <button class="btn sm gold" style="width:100%" data-act="fusionPick" data-arg="${iid}" ${(inst.locked||inTeam)?'disabled':''}>FUSIONAR 🧬</button>
    <div id="frame-row" class="mt8"></div>
    <button class="btn sm ghost mt8" style="width:100%" data-act="close">CERRAR</button>
  </div>`);
  loadFrameRow(inst);
}
// Marcos cosméticos: chips de los marcos desbloqueados (por liga/victorias).
let _framesCache=null;
async function loadFrameRow(inst){
  try{ if(!_framesCache)_framesCache=await api('/frames'); }catch(e){ return; }
  const row=$("#frame-row"); if(!row)return;
  const chips=_framesCache.map(f=>`<span class="f ${inst.frame===f.key?'on':''}" ${f.unlocked?`data-act="setFrame" data-arg="${inst.instance_id}:${f.key}"`:'style="opacity:.4"'} title="${f.unlocked?'':'Bloqueado'}">${f.unlocked?'':'🔒 '}${f.name.replace('Marco ','')}</span>`).join('');
  row.innerHTML=`<div class="dim" style="font-size:11px;margin-bottom:4px">Marco:</div>
    <div class="filters" style="margin:0"><span class="f ${!inst.frame?'on':''}" data-act="setFrame" data-arg="${inst.instance_id}:">ninguno</span>${chips}</div>`;
}
async function setFrame(arg){
  const i=arg.indexOf(':'); const iid=arg.slice(0,i), frame=arg.slice(i+1)||null;
  try{ await api('/creature/'+iid+'/frame',{method:'PUT',body:{frame}});
    await refreshCollection(); openDetail(iid); }
  catch(e){ toast('Marco bloqueado'); }
}
async function levelUp(iid){
  try{ const r=await api('/creature/'+iid+'/level-up',{method:'POST'}); await Promise.all([refreshMe(),refreshCollection()]); refreshChips();
    if(r.evolved){ showEvolution(iid,r.evolved); } else { openDetail(iid); toast("¡Subió de nivel!"); } }
  catch(e){ const er=e.data&&e.data.error; toast(er==='max_level'?'Nivel máximo':er==='insufficient'?'Te faltan recursos':'No se pudo'); }
}
// Celebración de EVOLUCIÓN (automática al cruzar el umbral de nivel del aigron):
// reveal con la forma nueva (sprite derivado o arte IA cuando llegue) y su nombre.
function showEvolution(iid,evo){
  const inst=instById(iid); if(!inst){openDetail(iid);return;}
  const t=inst.template, e=evoTpl(t.id,evo.stage);
  SFX.play('claim'); buzz([50,40,50,40,120]);
  if(window.POC&&window.POC.confetti){window.POC.confetti();setTimeout(window.POC.confetti,250);}
  openOverlay(`<div class="center reveal" style="position:relative"><div class="rays"></div>
    <div style="position:relative;z-index:2">
      <div style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin-bottom:10px">🧬 ¡EVOLUCIONÓ!</div>
      <div class="evo-pair">
        ${artTag(t,6)}
        <span class="evo-arrow">→</span>
        ${artTag(e,10,iid)}
      </div>
      <div style="font-size:20px;font-weight:700;margin-top:6px">${esc(e.name)}</div>
      <div class="dim" style="font-size:12px;margin-bottom:8px">${esc(t.name)} ha alcanzado su ${evo.stage===2?'forma FINAL':'primera evolución'} en Nv.${evo.at}</div>
      <div style="color:var(--green);font-size:13px;font-weight:700;margin-bottom:12px">¡Todas sus stats han dado un gran salto!</div>
      <button class="btn mag" data-act="chooseEvoPath" data-arg="${iid}">🧬 ELEGIR SENDERO</button>
      <button class="btn ghost mt8" data-act="evoOk" data-arg="${iid}">VER FICHA</button>
    </div></div>`);
}
// Sendero de evolución (#6): perfil de stats permanente (reescribible) de la forma
// evolucionada. Mismo bicho y arte; distinto destino según cómo lo quieras jugar.
let pendingPathIid=null;
function chooseEvoPath(iid){
  pendingPathIid=iid;
  const inst=instById(iid); const cur=inst&&inst.evo_path;
  const P=ENGINE.EVO_PATHS;
  const opt=(k,emoji)=>`<button class="btn ghost ${cur===k?'cyan':''}" data-act="setEvoPath" data-arg="${k}" style="text-align:left;margin-bottom:8px;width:100%">
     ${emoji} <b>${P[k].label}</b> <span class="dim" style="font-size:12px">— ${esc(P[k].desc)}</span>${cur===k?' <span style="color:var(--cyan)">✓</span>':''}</button>`;
  openOverlay(`<div class="center">
    <div style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin-bottom:8px">🧬 SENDERO DE EVOLUCIÓN</div>
    <div class="dim mb8" style="font-size:13px">Elige cómo crece tu forma evolucionada. Mismo aigrón, distinto estilo. <b>Puedes cambiarlo cuando quieras.</b></div>
    ${opt('OFENSIVO','⚔️')}${opt('DEFENSIVO','🛡️')}${opt('VELOZ','⚡')}
    <button class="btn sm ghost mt8" data-act="evoOk" data-arg="${iid}">${cur?'CERRAR':'AHORA NO'}</button>
  </div>`);
}
async function setEvoPath(path){
  const iid=pendingPathIid; if(!iid)return;
  try{ await api('/creature/'+iid+'/evo-path',{method:'POST',body:{path}});
    await refreshCollection(); SFX.play('claim'); buzz(40);
    toast('🧬 Sendero: '+(ENGINE.EVO_PATHS[path]||{}).label); openDetail(iid); }
  catch(e){ toast('No se pudo elegir el sendero'); }
}
async function toggleFav(iid){
  try{ await api('/creature/'+iid+'/favorite',{method:'POST'}); await refreshCollection(); openDetail(iid); }catch(e){ toast('Error'); }
}
async function release(iid){
  try{ const r=await api('/creature/'+iid+'/release',{method:'POST'}); await Promise.all([refreshMe(),refreshCollection()]); closeOverlay(); refreshChips(); renderCollection(); toast("+"+r.dust+"✨ polvo"); }
  catch(e){ const er=e.data&&e.data.error; toast(er==='in_team'?'En equipo':er==='locked'?'Protegido':'No se pudo'); }
}

/* ---------------- Fusión ---------------- */
let fusionA=null;
function fusionPick(iid){
  fusionA=iid;
  const others=S.collection.filter(i=>i.instance_id!==iid && !i.locked && !S.team.includes(i.instance_id));
  const grid=others.map(i=>`<div class="card r-${i.template.rarity}" data-iid="${i.instance_id}">
     <div class="lv">L${i.level}</div>${artTag(i.template,6)}
     <div class="nm">${i.template.name}</div></div>`).join("");
  openOverlay(`<div><div class="center mb8"><b>Fusionar con…</b><div class="dim" style="font-size:12px">Se consumen ambos aigrons + monedas</div></div>
    ${others.length?`<div class="grid" id="fusgrid" style="max-height:46vh;overflow-y:auto">${grid}</div>`:'<div class="dim tc" style="padding:20px">No tienes otro aigrón libre para fusionar.</div>'}
    <button class="btn sm ghost mt8" style="width:100%" data-act="close">CANCELAR</button></div>`);
  $("#fusgrid")&&$("#fusgrid").querySelectorAll(".card").forEach(c=>c.onclick=()=>doFusion(fusionA,c.dataset.iid));
}
async function doFusion(a,b){
  try{
    const r=await api('/fusion',{method:'POST',body:{a,b}});
    const t=registerTpl(r.instance.template);
    await Promise.all([refreshMe(),refreshCollection()]); refreshChips();
    const rays=(t.rarity==="EPICA"||t.rarity==="LEGENDARIA")?'<div class="rays"></div>':'';
    openOverlay(`<div class="center reveal" style="position:relative">${rays}<div style="position:relative;z-index:2">
       <div style="font-family:var(--pixel);font-size:11px;color:var(--magenta);margin-bottom:8px">¡FUSIÓN!</div>
       ${artTag(t,11)}
       <div style="font-size:19px;font-weight:700;margin-top:6px">${t.name}</div>
       <div class="mb8"><span class="rar-txt ${t.rarity}" style="font-weight:700">${t.rarity} · ${typesLabel(t)}</span></div>
       <div style="text-align:left;max-width:220px;margin:0 auto 12px">${statBars(t.base_stats)}</div>
       <button class="btn" data-act="toCollection">¡GENIAL!</button></div></div>`);
  }catch(e){ const er=e.data&&e.data.error; toast(er==='insufficient'?'Te faltan monedas':er==='in_team'?'Hay uno en tu equipo':er==='locked'?'Hay uno protegido':'No se pudo fusionar'); }
}

/* ====================== COMBATE ====================== */
let teamSel=[];
async function renderBattle(){
  refreshChips();
  if(CB&&CB.timer)return;
  const team=S.team.map(instById).filter(Boolean);
  $("#s-battle").innerHTML=`
    <h2 class="title">COMBATE <small>Liga ${S.user.league} · ${S.user.leaguePoints} pts</small></h2>
    <div class="panel"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="font-size:14px">Tu equipo</b>
        <button class="btn sm ghost" data-act="editTeam">EDITAR</button></div>
      <div class="grid">${team.length?team.map(i=>cardHTML(i)).join(""):'<div class="grid-hint" data-act="editTeam">＋ Elige 3 aigrons de tu colección</div>'}</div>
    </div>
    <button class="btn mag" data-act="prepBattle" ${team.length<1?'disabled':''}>⚔️ COMBATE PvP EN VIVO — ⚡1</button>
    <div class="panel mt8"><b style="font-size:14px">Estrategia</b>
      <div class="dim" style="font-size:13px;margin-top:6px">Te emparejas con <b>otro jugador en directo</b> de tu nivel. Eliges <b>capitán</b> y <b>estancia</b>, y cada ronda planificas a tus 3 aigrons (10s): toca una habilidad y luego un <b>rival</b> para apuntar (⬆/⬇ de tipo); <b>🛡️ guardia</b> protege; con energía de sobra, <b>sobrecarga</b> (⚡⚡) pega ×1.5. La mazmorra es PvE; el combate es siempre PvP.</div></div>`;
  renderCanvases($("#s-battle"));
  $("#s-battle").querySelectorAll(".card").forEach(c=>c.onclick=()=>openDetail(c.dataset.iid));
}
function editTeam(){
  teamSel=S.team.slice();   // init UNA vez (no en cada re-render)
  renderTeamPicker();
}
function teamPickCard(i){
  const sel=teamSel.includes(i.instance_id);
  return `<div class="card r-${i.template.rarity}" data-iid="${i.instance_id}" style="${sel?'outline:3px solid var(--cyan);outline-offset:-3px':''}">
    ${sel?`<div class="badge">${teamSel.indexOf(i.instance_id)+1}</div>`:''}
    <div class="lv">L${i.level}</div>${artTag(i.template,6)}
    <div class="nm">${i.template.name}</div></div>`;
}
function renderTeamPicker(){
  const byId=id=>S.collection.find(c=>c.instance_id===id);
  const selected=teamSel.map(byId).filter(Boolean);
  const rest=S.collection.filter(i=>!teamSel.includes(i.instance_id));
  const empties=Array.from({length:Math.max(0,3-selected.length)},()=>
    `<div class="card" style="border-style:dashed;opacity:.45;display:flex;align-items:center;justify-content:center;min-height:96px"><span class="dim" style="font-size:11px">vacío</span></div>`).join("");
  const selGrid=selected.map(teamPickCard).join("")+empties;
  const restGrid=rest.length?rest.map(teamPickCard).join(""):`<div class="dim tc" style="grid-column:1/-1;padding:16px">No tienes más aigrons.</div>`;
  // Feedback en vivo mientras eliges: PODER total + tipos cubiertos (sinergia).
  const power=teamPower(selected);
  const types=[...new Set(selected.flatMap(i=>(i.template.types||[i.template.type])))];
  const syn=teamSynergyOf(selected);
  const liveInfo=selected.length?`<div class="dim" style="font-size:11px;margin-top:3px">PODER <b style="color:var(--cyan)">${power}</b> · tipos: ${types.map(ty=>`<span class="type-pill" style="font-size:9px;padding:1px 4px">${ty}</span>`).join(' ')}</div>
    <div style="margin-top:5px">${synergyChip(syn)}</div>`:'';
  // Bug: el modal se re-renderiza entero en cada toque y el scroll de la lista
  // saltaba al principio. Se preserva y restaura el scrollTop.
  const prevScroll=($("#restgrid")||{}).scrollTop||0;
  openOverlay(`<div>
    <div class="center mb8"><b>Tu equipo ${selected.length}/3</b>
      <div class="dim" style="font-size:11px">toca un elegido para quitarlo</div>${liveInfo}</div>
    <div class="grid">${selGrid}</div>
    <div class="center" style="margin:12px 0 6px"><b style="font-size:13px">Cambiar / añadir</b>
      <div class="dim" style="font-size:11px">toca uno para meterlo al equipo</div></div>
    <div class="grid" id="restgrid" style="max-height:34vh;overflow-y:auto">${restGrid}</div>
    <div class="row mt8">
      <button class="btn sm ghost cyan" style="flex:0 0 auto" data-act="autoTeam" title="Los 3 de mayor poder">⚡ AUTO</button>
      <button class="btn" style="flex:1" data-act="saveTeam">GUARDAR EQUIPO</button>
    </div></div>`);
  const rg=$("#restgrid"); if(rg)rg.scrollTop=prevScroll;
  $("#modal").querySelectorAll(".card[data-iid]").forEach(c=>c.onclick=()=>{
    const iid=c.dataset.iid;const k=teamSel.indexOf(iid);
    if(k>=0)teamSel.splice(k,1);else if(teamSel.length<3)teamSel.push(iid);else{toast("Máx 3");return;}
    renderTeamPicker();});   // re-render SIN resetear teamSel
}
// AUTO: elige los 3 aigrons de mayor poder (índice de stats escalados).
function autoTeam(){
  const power=i=>{const s=i.template.stats||i.template.base_stats;return s?s.hp/10+s.atkP+s.atkS+s.defP+s.defS+s.spd:0;};
  teamSel=S.collection.slice().sort((a,b)=>power(b)-power(a)).slice(0,3).map(i=>i.instance_id);
  renderTeamPicker();
}
async function saveTeam(){
  if(!teamSel.length){toast("Elige al menos 1");return;}
  try{ const r=await api('/team',{method:'PUT',body:{slots:teamSel.slice()}}); S.team=r.slots; closeOverlay(); renderHome(); }
  catch(e){ toast('No se pudo guardar'); }
}

let CB=null, prep=null;
function mkUnit(s,team,i){ return E.unitFromStats(s,team,i); }
/* Velocidad de combate: base MÁS LENTA que antes (750ms/acción; feedback de
   jugadores nuevos: "demasiado rápido"), ciclo x1→x2→x3 y MEMORIA en
   localStorage. AUTO = la IA planifica y confirma sola (modo idle). */
const BASE_TICK=750;
function savedSpeed(){ const v=parseInt(localStorage.getItem('aigrons_speed')||'1',10); return [1,2,3].includes(v)?v:1; }
function tickMs(){ return Math.round(BASE_TICK/((CB&&CB.speed)||1)); }
function autoMode(){ return localStorage.getItem('aigrons_auto')==='1'; }

/* =========================== PvP EN VIVO (WebSocket) =========================
   Localmente SIEMPRE: mi equipo = 'A' (abajo), rival = 'B' (arriba) -> reutiliza
   toda la UI de combate. Solo traduzco uids al hablar con el servidor (si soy 'B'
   intercambio A<->B). El servidor es autoritativo: manda el log + estado; aquí
   solo se anima. */
let PVP=null;
const pvpSwap=(uid)=> (uid[0]==='A'?'B':'A')+uid.slice(1);
const toServerUid=(luid)=> (CB.you==='A'?luid:pvpSwap(luid));
const toLocalUid=(suid)=> (!suid?suid:(CB.you==='A'?suid:pvpSwap(suid)));
function pvpWsUrl(){
  const tok=encodeURIComponent(TOKEN||'');
  if(API_BASE) return API_BASE.replace(/^http/,'ws')+'/pvp?token='+tok;
  return (location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/pvp?token='+tok;
}
function startLivePvp(captain,stance,code,extra){
  extra=extra||{};
  const arena=extra.arena||null; // modo Arena Sellada: equipo drafteado (ids)
  if(!S.user||S.user.energy<1){toast('Sin energía ⚡');return;}
  if(!arena&&!S.team.length){toast('Equipo vacío');return;}
  if(PVP){return;}
  let ws; try{ ws=new WebSocket(pvpWsUrl()); }catch(e){ toast('PvP no disponible'); return; }
  PVP={ws,status:'connecting',captain:captain||S.team[0],stance:stance||'NEUTRAL',code:code||null,arena};
  pvpQueueUI(arena?'⚔️ Arena · buscando rival…':code?`Reto privado · código <b style="color:var(--cyan);font-family:var(--pixel)">${code}</b>`:'Conectando…');
  ws.onmessage=(ev)=>{ let m;try{m=JSON.parse(ev.data);}catch(e){return;} pvpOnMessage(m); };
  ws.onclose=()=>{ const wasPlaying=PVP&&(PVP.status==='match'); PVP=null; if(wasPlaying&&CB&&CB.live&&!CB.ended){ pvpReconnect(1); } };
  ws.onerror=()=>{};
}
// Reconexión tras un corte de red en pleno match (el servidor da ~30s de
// gracia): nuevo socket + 'resume' con el matchId. Antes cualquier microcorte
// era derrota instantánea por abandono.
function pvpReconnect(attempt){
  if(!CB||!CB.live||CB.ended)return;
  if(attempt>5){ toast('Conexión PvP perdida'); CB=null; closeOverlay(); go('home'); return; }
  setBanner(`⚠️ Reconectando… (${attempt}/5)`);
  let ws; try{ ws=new WebSocket(pvpWsUrl()); }catch(e){ setTimeout(()=>pvpReconnect(attempt+1),1500); return; }
  PVP={ws,status:'resuming'};
  ws.onmessage=(ev)=>{ let m;try{m=JSON.parse(ev.data);}catch(e){return;}
    if(m.t==='hello'){ pvpSend({t:'resume',matchId:CB.battleId}); return; }
    pvpOnMessage(m); };
  ws.onclose=()=>{ const resuming=PVP&&PVP.status!=='over'; PVP=null;
    if(resuming&&CB&&CB.live&&!CB.ended) setTimeout(()=>pvpReconnect(attempt+1),1200); };
  ws.onerror=()=>{};
}
function pvpSend(o){ if(PVP&&PVP.ws&&PVP.ws.readyState===1) PVP.ws.send(JSON.stringify(o)); }
function pvpCancel(){ if(PVP){ pvpSend({t:'leave'}); try{PVP.ws.close();}catch(e){} PVP=null; } closeOverlay(); }
function pvpQueueUI(msg){
  openOverlay(`<div class="center">
    <div style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin-bottom:12px">PvP EN VIVO</div>
    <div class="spinner" style="margin:14px auto"></div>
    <div class="dim" id="pvp-status" style="font-size:13px;margin:10px 0">${msg}</div>
    <button class="btn sm ghost" data-act="pvpCancel" style="width:100%">CANCELAR</button></div>`);
}
function pvpStatus(msg){ const e=$('#pvp-status'); if(e)e.textContent=msg; }
function pvpOnMessage(m){
  if(!PVP)return;
  if(m.t==='hello'){ PVP.status='queue'; pvpSend({t:'queue',captain:PVP.captain,stance:PVP.stance,code:PVP.code||undefined,arena:PVP.arena||undefined}); if(!PVP.code)pvpStatus('Buscando rival…'); }
  else if(m.t==='queued'){ if(!PVP.code)pvpStatus('Buscando rival…'); }
  else if(m.t==='error'){
    if(m.msg==='resume_failed'){ toast('La partida ya terminó'); PVP=null; CB=null; closeOverlay(); go('home'); return; }
    toast(m.msg==='no_energy'?'Sin energía ⚡':m.msg==='empty_team'?'Equipo vacío':'PvP no disponible'); pvpCancel(); }
  else if(m.t==='match'){ PVP.status='match'; closeOverlay(); startLiveBattle(m); }
  else if(m.t==='resumed'){ PVP.status='match'; closeOverlay(); resumeLiveBattle(m); }
  else if(m.t==='round'){ pvpRound(m); }
  else if(m.t==='resolve'){ pvpResolve(m); }
  else if(m.t==='opponentDisconnected'){ setBanner('📶 Rival desconectado — esperando su reconexión…'); }
  else if(m.t==='opponentReconnected'){ toast('Rival reconectado'); }
  else if(m.t==='opponentLeft'){ toast('Tu rival abandonó'); }
  else if(m.t==='emote'){ showEmote(m.i,false); }
  else if(m.t==='opponentReady'){ const e=$("#foe-ready"); if(e){e.textContent='✓ Rival listo';e.style.opacity=1;} }
  else if(m.t==='over'){ PVP.status='over'; pvpOver(m); }
}
// --- Emotes (toque social competitivo, estilo Clash Royale/Marvel Snap) ---
const EMOTES=['👋','😎','😂','😮','🔥','💀','🤝','😱'];
function pvpEmote(){
  openOverlay(`<div class="center"><div class="dim mb8" style="font-size:12px">Envía un emote</div>
    <div class="emote-grid">${EMOTES.map((e,i)=>`<button class="emote-pick" data-act="sendEmote" data-arg="${i}">${e}</button>`).join('')}</div></div>`);
}
function sendEmote(i){ i=+i; closeOverlay(); pvpSend({t:'emote',i}); showEmote(i,true); }
function showEmote(i,mine){
  const e=EMOTES[i]; if(e==null)return;
  const side=document.querySelector(mine?'.player-side':'.enemy-side')||$("#s-battle");
  const b=document.createElement('div'); b.className='emote-bubble'; b.textContent=e;
  (side||document.body).appendChild(b); SFX.play('click'); setTimeout(()=>b.remove(),1600);
}
function startLiveBattle(m){
  go('battle');
  registerUnitArt(m.team); registerUnitArt(m.opponent); // arte IA del rival
  const A=m.team.map((s,i)=>mkUnit(s,'A',i));      // MI equipo -> local 'A' (abajo)
  const B=m.opponent.map((s,i)=>mkUnit(s,'B',i));  // rival -> local 'B' (arriba)
  CB={A,B,seed:0,battleId:m.matchId,pvp:!m.bot,live:true,you:m.you,oppName:m.oppName||'Rival',
      duelCode:(PVP&&PVP.code)||null, // para ofrecer REVANCHA al terminar
      rng:null,turn:0,order:[],oi:0,plan:{},planTurn:0,selecting:null,phase:'wait',speed:savedSpeed(),
      decisions:[],timer:null,planTimer:null,initA:m.team,initB:m.opponent,ended:false};
  buildArena();
  const vs=$(".vs"); if(vs){vs.style.opacity=1;setTimeout(()=>{vs.style.opacity=0;},800);}
  const syn=ENGINE.teamSynergy(m.team||[]);
  setBanner(`⚔️ ${m.bot?'Combate':'PvP'} vs <b>${esc(CB.oppName)}</b>`+(syn?` · <span style="color:var(--cyan)">✦ ${esc(syn.label)}</span>`:''));
}
// Reconstruye el combate tras reanudar: mismos equipos + estado ACTUAL del servidor.
function resumeLiveBattle(m){
  go('battle');
  registerUnitArt(m.team); registerUnitArt(m.opponent);
  const A=m.team.map((s,i)=>mkUnit(s,'A',i));
  const B=m.opponent.map((s,i)=>mkUnit(s,'B',i));
  CB={A,B,seed:0,battleId:m.matchId,pvp:true,live:true,you:m.you,oppName:m.oppName||'Rival',
      rng:null,turn:0,order:[],oi:0,plan:{},planTurn:m.round,selecting:null,phase:'wait',speed:savedSpeed(),
      decisions:[],timer:null,planTimer:null,initA:m.team,initB:m.opponent,ended:false};
  buildArena();
  const smap={};
  ((m.state&&m.state.A)||[]).forEach(s=>smap[toLocalUid(s.uid)]=s);
  ((m.state&&m.state.B)||[]).forEach(s=>smap[toLocalUid(s.uid)]=s);
  [...CB.A,...CB.B].forEach(u=>{const s=smap[u.uid]; if(s){u.hp=s.hp;u.shield=s.shield;u.energy=s.energy;u.poisonTurns=s.poisonTurns;u.stunTurns=s.stunTurns;}});
  refreshArena();
  toast('✅ Reconectado');
  pvpRound({round:m.round,deadline:m.deadline});
}
function pvpRound(m){
  if(!CB||!CB.live||CB.ended)return;
  // El servidor manda 'resolve' y 'round' seguidos: si aún se está ANIMANDO la
  // ronda anterior, NO la cortes (antes esto mataba el intervalo y el combate
  // parecía no ejecutar nada). Se difiere y se arranca al acabar la animación.
  if(CB.phase==='resolve'){ CB.pendingRound=m; return; }
  if(CB.timer){clearInterval(CB.timer);CB.timer=null;}
  { const fr=$("#foe-ready"); if(fr){ fr.textContent=''; fr.style.opacity=0; } }
  CB.phase='plan'; CB.planTurn=m.round; CB.selecting=null;
  CB.plan={}; CB.A.forEach(u=>{ if(u.hp>0) CB.plan[u.uid]={action:'basic',target:null,overcharge:false}; });
  [...CB.A,...CB.B].forEach(x=>x.el&&x.el.classList.remove("acting"));
  renderPlanner();
  CB.planEndsAt=m.deadline||(Date.now()+10000);
  if(CB.planTimer)clearInterval(CB.planTimer);
  CB.planTimer=setInterval(planTimerTick,100);
  if(autoMode()) setTimeout(()=>{ if(CB&&CB.phase==='plan'&&CB.live)confirmPlan(); },600);
}
function pvpConfirm(){
  const decisions=[];
  Object.keys(CB.plan).forEach(uid=>{ const pl=CB.plan[uid]; let d;
    if(pl.action==='guard') d={uid,action:'guard'};
    else if(pl.action==='ability') d={uid,action:'ability',target:pl.target||undefined,overcharge:!!pl.overcharge};
    else if(pl.action==='attack') d={uid,action:'attack',target:pl.target||undefined};
    else d={uid,action:'attack'};
    d.uid=toServerUid(d.uid); if(d.target) d.target=toServerUid(d.target);
    decisions.push(d);
  });
  pvpSend({t:'plan',round:CB.planTurn,decisions});
  CB.phase='wait';
  const p=$("#planner"); if(p) p.innerHTML='<div class="dim tc" style="padding:12px">Esperando al rival…</div>';
  setBanner('Esperando al rival…');
}
function pvpResolve(m){
  if(!CB||!CB.live||CB.ended)return;
  CB.phase='resolve';
  liveAnimate(m.log||[], m.state);
}
function liveAnimate(log, state){
  const smap={};
  if(state){ (state.A||[]).forEach(s=>smap[toLocalUid(s.uid)]=s); (state.B||[]).forEach(s=>smap[toLocalUid(s.uid)]=s); }
  const byUid=(luid)=> CB.A.find(x=>x.uid===luid)||CB.B.find(x=>x.uid===luid);
  let i=0;
  if(CB.timer)clearInterval(CB.timer);
  CB.timer=setInterval(()=>{
    if(!CB||CB.ended){ clearInterval(CB.timer); CB.timer=null; return; }
    if(i>=log.length){
      [...CB.A,...CB.B].forEach(u=>{ const s=smap[u.uid]; if(s){ u.hp=s.hp; u.shield=s.shield; u.poisonTurns=s.poisonTurns; u.stunTurns=s.stunTurns; u.energy=s.energy; } });
      refreshArena();
      if(CB.timer){clearInterval(CB.timer);CB.timer=null;}
      CB.phase='wait'; // espera al siguiente 'round' o 'over' del servidor
      // Despacha lo que llegó DURANTE la animación (round/over diferidos).
      const pr=CB.pendingRound, po=CB.pendingOver;
      CB.pendingRound=null; CB.pendingOver=null;
      if(po){ pvpOver(po); return; }
      if(pr){ pvpRound(pr); return; }
      return;
    }
    const e=log[i++];
    const actor=byUid(toLocalUid(e.uid));
    [...CB.A,...CB.B].forEach(x=>x.el&&x.el.classList.remove("acting"));
    if(actor&&actor.el) actor.el.classList.add("acting");
    const who=actor&&actor.team==='A'?'var(--cyan)':'var(--magenta)';
    const nm=actor?actor.name:e.name;
    if(e.poison&&actor&&actor.el){ floatNum(actor,"☠"+e.poison,"var(--epi)"); SFX.play('poison'); }
    if(e.stunned) setBanner(`<span style="color:${who}">${nm}</span> está aturdido 💫`);
    else if(e.died) setBanner(`<span style="color:${who}">${nm}</span> cae por el veneno ☠`);
    else if(e.guard) setBanner(`<span style="color:${who}">${nm}</span> se protege 🛡️`);
    else if(e.ability){ setBanner(`<span style="color:${who}">${nm}</span> usa <b style="color:var(--gold)">${e.ability}</b>${e.overcharge?' ⚡⚡×1.5':''}`); SFX.play('ability'); }
    else if(e.hits&&e.hits.length) setBanner(`<span style="color:${who}">${nm}</span> ataca`);
    // Historial (PvP en vivo): mismo formato que el combate local.
    {
      const rnd=`<span class="tl-r">R${CB.planTurn}</span>`;
      const nmH=`<span style="color:${who}">${nm}</span>`;
      if(e.poison) logTurn(`${rnd} ☠ ${nmH} sufre <b class="tl-dmg">−${e.poison}</b> de veneno/quemadura`);
      if(e.stunned) logTurn(`${rnd} 💫 ${nmH} está aturdido — pierde el turno`);
      else if(e.died) logTurn(`${rnd} ☠ ${nmH} cae`);
      else if(e.guard) logTurn(`${rnd} 🛡️ ${nmH} se pone en guardia`);
      else {
        const what=e.ability?`usa <b class="tl-ab">${e.ability}</b>${e.overcharge?' ⚡⚡':''}`:'ataca';
        const det=(e.hits||[]).map(h=>{const t=byUid(toLocalUid(h.tgt&&h.tgt.uid));
          return hitTxt(h,(t&&t.name)||'rival',!!(h.tgt&&h.tgt.hp<=0));}).join(' · ');
        logTurn(`${rnd} ${nmH} ${what}${det?' '+det:''}`);
      }
    }
    (e.hits||[]).forEach(h=>{ const luid=toLocalUid(h.tgt&&h.tgt.uid); const t=byUid(luid); if(!t||!t.el)return;
      t.el.classList.remove("hit");void t.el.offsetWidth;t.el.classList.add("hit");
      SFX.play(h.crit?'crit':'hit'); buzz(h.crit?40:15);
      floatNum(t,(h.shielded?"🛡":"")+(h.guarded?"🛡️":"")+(h.crit?"¡":"")+h.dmg+(h.crit?"!":""),h.crit?"var(--gold)":h.shielded?"#aebfce":h.guarded?"var(--cyan)":h.typeM>1?"var(--magenta)":"#fff",h.crit); impactFx(t,h);
      const ss=smap[luid]; if(ss) t.hp=ss.hp;
    });
    const sa=actor&&smap[actor.uid]; if(sa) actor.hp=sa.hp;
    refreshArena();
  }, tickMs());
}
function pvpOver(m){
  // Igual que 'round': si la última ronda aún se anima, difiere el resultado
  // para que el jugador VEA el desenlace antes del overlay de victoria/derrota.
  if(CB&&CB.live&&!CB.ended&&CB.phase==='resolve'&&CB.timer){ CB.pendingOver=m; return; }
  if(CB){ CB.ended=true; if(CB.timer){clearInterval(CB.timer);CB.timer=null;} if(CB.planTimer){clearInterval(CB.planTimer);CB.planTimer=null;} }
  if(m.leaguePoints!=null){ S.user.leaguePoints=m.leaguePoints; S.user.league=m.league; }
  if(m.energy!=null) S.user.energy=m.energy;
  refreshChips();
  MUSIC.setScene('menu');
  const won=!!m.youWon;
  SFX.play(won?'win':'lose'); buzz(won?[40,60,80]:60);
  openOverlay(`<div class="center">
    <div style="font-family:var(--pixel);font-size:16px;color:${won?'var(--green)':'var(--red)'};margin:6px 0 10px">${won?'¡VICTORIA!':'DERROTA'}</div>
    <div class="dim" style="font-size:13px">${m.reason==='opponent_left'?(won?'Tu rival abandonó.':'Abandonaste.'):'Combate PvP en vivo terminado.'}</div>
    ${m.lpDelta!=null?`<div style="font-family:var(--pixel);font-size:15px;margin:8px 0 2px;color:${m.lpDelta>=0?'var(--green)':'var(--red)'}">${m.lpDelta>=0?'+':''}${m.lpDelta} <span style="font-size:10px;color:var(--ink-dim)">RATING</span></div>`:''}
    <div style="margin:6px 0 12px;font-size:14px">Liga <b>${m.league}</b> · ${m.leaguePoints} pts</div>
    ${CB&&CB.duelCode&&m.reason!=='opponent_left'?`<button class="btn mag mb8" data-act="rematch" style="width:100%">🔁 REVANCHA (código ${esc(CB.duelCode)})</button>`:''}
    <button class="btn" data-act="pvpDone" style="width:100%">CONTINUAR</button></div>`);
  if(PVP){ try{PVP.ws.close();}catch(e){} PVP=null; }
}
function pvpDone(){ closeOverlay(); CB=null; go('home'); }
// Revancha de un duelo privado: vuelve a la cola con el MISMO código.
function rematch(){
  const code=CB&&CB.duelCode; const cap=(prep&&prep.captain)||S.team[0]; const st=(prep&&prep.stance)||'NEUTRAL';
  closeOverlay(); CB=null;
  if(!code){ go('home'); return; }
  startLivePvp(cap,st,code);
}

/* --- Preparación: capitán + estancia (decisión previa) --- */
function prepBattle(){
  const team=S.team.map(instById).filter(Boolean);
  if(!team.length){toast("Equipo vacío");return;}
  if(S.user.energy<1){toast("Sin energía ⚡ — recarga con el tiempo");return;}
  prep={captain:team[0].instance_id, stance:'NEUTRAL'};
  renderPrep(team);
}
function renderPrep(team){
  // La habilidad de cada candidato a capitán, para elegir con criterio.
  const capCards=team.map(i=>`<div class="card r-${i.template.rarity}" data-cap="${i.instance_id}" style="${prep.captain===i.instance_id?'outline:3px solid var(--gold);outline-offset:-3px':''}">
     ${prep.captain===i.instance_id?'<div class="badge" style="background:var(--gold);color:#000">★CAP</div>':''}
     <div class="lv">L${i.level}</div>${artTag(i.template,6)}<div class="nm">${i.template.name}</div>
     <div class="ty" style="color:var(--gold);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">✨ ${ABILITIES[i.template.ability].name}</div></div>`).join("");
  const st=(k,l,d)=>`<div class="stance ${prep.stance===k?'on':''}" data-stance="${k}"><b>${l}</b><div class="dim" style="font-size:10px">${d}</div></div>`;
  const syn=teamSynergyOf(team);
  openOverlay(`<div>
    <div class="center mb8"><b>Prepara el combate</b></div>
    <div class="center mb8">${synergyChip(syn)}</div>
    <div class="dim mb8" style="font-size:12px">Capitán: +15% a sus stats y liderazgo (+6% a todo el equipo).</div>
    <div class="grid mb8" id="capgrid">${capCards}</div>
    <div class="dim mb8" style="font-size:12px">Estancia del equipo:</div>
    <div class="stances mb8" id="stancesel">
      ${st('AGRESIVA','⚔️ Agresiva','+15% ATK<br>−10% DEF')}
      ${st('NEUTRAL','⚖️ Neutral','equilibrada')}
      ${st('DEFENSIVA','🛡️ Defensiva','+15% DEF<br>−8% ATK, +1⚡')}
    </div>
    <button class="btn mag" data-act="goBattle">⚔️ BUSCAR RIVAL — ⚡1</button>
    <button class="btn sm ghost cyan mt8" style="width:100%" data-act="duelPrivate">🤝 RETO PRIVADO (con código)</button>`);
  $("#capgrid").querySelectorAll("[data-cap]").forEach(c=>c.onclick=()=>{prep.captain=c.dataset.cap;renderPrep(team);});
  $("#stancesel").querySelectorAll("[data-stance]").forEach(c=>c.onclick=()=>{prep.stance=c.dataset.stance;renderPrep(team);});
}
function goBattle(){ const p=prep; closeOverlay(); startLivePvp(p.captain,p.stance); }
// Duelo PRIVADO: ambos jugadores introducen el MISMO código (4-6 letras) y se
// emparejan entre sí, sin ventana de nivel ni bot. El loop viral más barato.
function duelPrivate(){
  const gen=()=>Array.from({length:4},()=>"ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random()*24)]).join('');
  openOverlay(`<div class="center">
    <div style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin-bottom:10px">RETO PRIVADO</div>
    <div class="dim mb8" style="font-size:13px">Compartid un código: quien tenga el mismo, se enfrenta a ti (sin límite de nivel).</div>
    <input id="duel-code" maxlength="6" value="${gen()}" style="width:140px;text-align:center;font-family:var(--pixel);font-size:16px;letter-spacing:3px;background:#0a0818;color:var(--cyan);border:2px solid var(--cyan);padding:10px;text-transform:uppercase">
    <div class="row mt8">
      <button class="btn sm ghost" style="flex:1" data-act="close">CANCELAR</button>
      <button class="btn sm mag" style="flex:1" data-act="duelStart">⚔️ RETAR</button>
    </div></div>`);
  const inp=$("#duel-code"); if(inp){inp.focus();inp.select();}
}
function duelStart(){
  const code=(($("#duel-code")||{}).value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
  if(code.length<3){toast('Código demasiado corto');return;}
  const p=prep||{captain:S.team[0],stance:'NEUTRAL'};
  closeOverlay();
  startLivePvp(p.captain,p.stance,code);
}

function buildArena(){
  MUSIC.setScene('battle'); // la música se intensifica al combatir
  const fHTML=(u)=>`<div class="fighter ${u.team==='B'?'enemy':''}" data-uid="${u.uid}" ${u.team==='B'?`data-act="planEnemy" data-arg="${u.uid}"`:''}>
     <div class="thint"></div>
     <div class="flv">Nv${u.level}</div>
     ${artTag(combatTpl(u),5)}
     <div class="hpbar"><i style="width:100%"></i></div>
     <div class="hpnum"></div>
     <div class="fname">${u.name}</div>
     <div class="energy-pips">${'<span class="pip"></span>'.repeat(6)}</div></div>`;
  $("#s-battle").innerHTML=`
    <h2 class="title">${esc(CB.title||'COMBATE')} ${CB.pvp?'<small>PvP</small>':'<small>PvE</small>'}</h2>
    <div class="arena">
      <div class="vs">VS</div>
      <div class="side enemy-side">${CB.B.map(fHTML).join("")}</div>
      <div style="height:14px"></div>
      <div class="side player-side">${CB.A.map(fHTML).join("")}</div>
    </div>
    <div class="action-banner" id="abanner">¡Empieza el combate!</div>
    <div id="foe-ready" class="foe-ready"></div>
    <div class="turnlog" id="turnlog"></div>
    <div id="planner"></div>
    <div class="combat-ctrl">
      <button class="cbtn" id="cb-speed" data-act="cbSpeed" title="Velocidad de animación">▶▶ ${CB.speed||1}x</button>
      <button class="cbtn ${autoMode()?'on':''}" id="cb-auto" data-act="cbAuto" title="La IA decide y confirma sola">🤖 AUTO</button>
      ${CB.live&&CB.pvp?'<button class="cbtn" data-act="pvpEmote" title="Enviar emote">😀</button>':''}
      <button class="cbtn" data-act="flee">🏳 Huir</button>
    </div>`;
  renderCanvases($("#s-battle"));
  [...CB.A,...CB.B].forEach(u=>{u.el=$(`.fighter[data-uid="${u.uid}"]`);u.hpEl=u.el.querySelector(".hpbar i");u.hpNumEl=u.el.querySelector(".hpnum");u.pipsEl=u.el.querySelectorAll(".pip");});
  refreshArena();
}
function floatNum(u,txt,color,big){const s=document.createElement("span");s.className="floatnum"+(big?" big":"");s.textContent=txt;
  s.style.color=color;s.style.left="50%";s.style.top="0";if(!big)s.style.transform="translateX(-50%)";u.el.appendChild(s);setTimeout(()=>s.remove(),big?1100:1000);}
/* ---- JUICINESS: screen-shake del escenario + chispas de impacto -------------
   Puro render (no toca el motor determinista): solo "sienten" mejor los golpes. */
function shake(big){ const a=document.querySelector('.arena'); if(!a)return; const c=big?'shake-big':'shake';
  a.classList.remove('shake','shake-big'); void a.offsetWidth; a.classList.add(c); setTimeout(()=>a&&a.classList.remove(c), big?440:260); }
function sparks(u,color,n){ if(!u||!u.el)return; for(let i=0;i<(n||6);i++){ const s=document.createElement('span'); s.className='spark';
  const ang=Math.random()*Math.PI*2, dist=16+Math.random()*28;
  s.style.setProperty('--dx',(Math.cos(ang)*dist).toFixed(1)+'px');
  s.style.setProperty('--dy',(Math.sin(ang)*dist-8).toFixed(1)+'px');
  s.style.color=color; s.style.background=color; u.el.appendChild(s); setTimeout(()=>s.remove(),460); } }
// Impacto centralizado (lo usan los 4 caminos de animación: replay, PvP en vivo,
// PvE local y mazmorra). Añade el FLASH de crítico a nivel de sprite (encima del
// empuje .hit) y delega las partículas + screen-shake en POC (sistema de canvas
// ya afinado). Fallback a chispas DOM + shake del .arena si POC no cargó. */
function impactFx(t,h){ if(!t||!t.el)return; const crit=!!(h&&h.crit);
  if(crit){ t.el.classList.add('crit-hit'); setTimeout(()=>t.el&&t.el.classList.remove('crit-hit'),340); }
  if(window.POC&&window.POC.onHit){ try{ window.POC.onHit(t.el,h); }catch(e){} }
  else { shake(crit); sparks(t, crit?'var(--gold)':(h&&h.typeM>1?'var(--magenta)':(h&&h.guarded?'var(--cyan)':'#fff')), crit?11:6); } }
const sumHp=arr=>arr.reduce((s,u)=>s+Math.max(0,u.hp),0);
function refreshArena(){
  if(!CB)return;
  [...CB.A,...CB.B].forEach(u=>{
    if(!u.hpEl)return;
    u.hpEl.style.width=(Math.max(0,u.hp)/u.hpMax*100)+"%";
    u.hpEl.style.background=u.hp/u.hpMax<0.3?"var(--red)":u.hp/u.hpMax<0.6?"var(--gold)":"var(--green)";
    if(u.hpNumEl){
      const badges=(u.shield>0?" 🛡"+u.shield:"")+(u.poisonTurns>0?" ☠":"")+(u.stunTurns>0?" 💫":"")
        +(u.defBreakTurns>0?" ⛏":"")+(u.tauntTurns>0?" 🎯":"")+(u.immuneTurns>0?" ✨":"")
        +(u.spdTurns>0?(u.spdMul>1?" 💨":" 🐌"):"")+(u.markTurns>0?" 🔻":"");
      u.hpNumEl.innerHTML = (u.hp<=0?"☠️":(Math.max(0,Math.round(u.hp))+"/"+u.hpMax))+'<span style="font-size:9px">'+badges+'</span>';
    }
    if(u.hp<=0){ if(!u._died){ u._died=true; u.el.classList.add("dying"); sparks(u,"var(--red)",12);
        if(window.POC&&window.POC.onHit){ try{ window.POC.onHit(u.el,{crit:true}); }catch(e){} }
        setTimeout(()=>{ u.el&&u.el.classList.add("dead"); },240); }
      else u.el.classList.add("dead"); }
    u.el.classList.toggle("guarding", !!u.guarding && u.hp>0);
    u.pipsEl.forEach((p,i)=>p.classList.toggle("on",i<u.energy));
  });
  // hints de tipo (⬆ fuerte / ⬇ débil) en enemigos al elegir objetivo en la planificación
  const sel=CB.selecting?CB.A.find(x=>x.uid===CB.selecting):null;
  CB.B.forEach(u=>{ const h=u.el&&u.el.querySelector(".thint"); if(!h)return;
    if(sel&&u.hp>0){ const m=ENGINE.typeEff(sel.type,ENGINE.typesOf(u)); h.textContent=m>1?"⬆":m<1?"⬇":"•";
      h.style.color=m>1?"var(--green)":m<1?"var(--red)":"var(--ink-dim)"; h.style.display="block"; }
    else h.style.display="none";
    if(u.el) u.el.classList.toggle("targetable", !!(CB.selecting&&u.hp>0));
  });
}
function setBanner(html){ const b=$("#abanner"); if(b) b.innerHTML=html; }
/* ---- Historial de turnos: lo ya ocurrido, bajo el banner de la acción actual.
   Lo más reciente arriba; con números de daño/cura y estados alterados. ---- */
function logTurn(html){
  const l=$("#turnlog"); if(!l) return;
  const d=document.createElement("div"); d.className="tl"; d.innerHTML=html;
  l.prepend(d);
  while(l.children.length>80) l.removeChild(l.lastChild);
}
function hitTxt(h,tname,killed){
  const eff=h.typeM>1?' <i class="tl-eff">eficaz</i>':(h.typeM<1?' <i class="tl-res">resistido</i>':'');
  return `→ ${tname} <b class="tl-dmg">−${h.dmg}</b>${h.crit?' <b class="tl-crit">¡CRÍT!</b>':''}${h.shielded?' 🛡':''}${h.guarded?' 🛡️':''}${eff}${killed?' ☠':''}`;
}
// Línea de historial para una acción del combate local (resolveTick).
function logAction(u,action,st,extras){
  const who=u.team==='A'?'var(--cyan)':'var(--magenta)';
  const rnd=`<span class="tl-r">R${CB.turn}</span>`;
  const nm=`<span style="color:${who}">${u.name}</span>`;
  if(st&&st.poison) logTurn(`${rnd} ☠ ${nm} sufre <b class="tl-dmg">−${st.poison}</b> de veneno/quemadura`);
  if(action.stunned){ logTurn(`${rnd} 💫 ${nm} está aturdido — pierde el turno`); return; }
  if(action.died){ logTurn(`${rnd} ☠ ${nm} cae`); return; }
  if(action.guard){ logTurn(`${rnd} 🛡️ ${nm} se pone en guardia`); return; }
  const what=action.ability?`usa <b class="tl-ab">${action.ability}</b>${action.overcharge?' ⚡⚡':''}`:'ataca';
  const det=action.hits.map(h=>hitTxt(h,h.tgt.name,h.tgt.hp<=0)).join(' · ');
  logTurn(`${rnd} ${nm} ${what}${det?' '+det:''}${extras||''}`);
}
// Curas/escudos/estados que el motor aplica sin registrarlos en `action`:
// se detectan por diferencia de HP (snapshot antes/después) + tipo de habilidad.
function actionExtras(u,action,hpBefore,mine,foes){
  if(action.stunned||action.died||action.guard) return '';
  const out=[];
  const hitUids=new Set(action.hits.map(h=>h.tgt.uid));
  [...mine,...foes].forEach(x=>{
    const before=hpBefore.get(x.uid); if(before==null) return;
    const d=Math.round(x.hp-before);
    if(d>0) out.push(`💚 ${x.name} <b class="tl-heal">+${d}</b>`);
    else if(d<0&&!hitUids.has(x.uid)&&x.uid===u.uid) out.push(`(se hiere <b class="tl-dmg">−${-d}</b>)`);
  });
  if(action.ability){
    const ab=ABILITIES[u.ability];
    const tgtName=action.statusTgt?((foes.find(x=>x.uid===action.statusTgt)||{}).name||''):'';
    if(ab){
      if(ab.kind==='dot'&&tgtName) out.push(`☠ envenena a ${tgtName}`);
      if(ab.kind==='stun'&&tgtName) out.push(`💫 aturde a ${tgtName}`);
      if(ab.kind==='shield') out.push(`🛡 escudo${ab.team?' al equipo':''}`);
      if(ab.kind==='buffAtk') out.push('⬆ ATK');
      if(ab.kind==='buffDef') out.push(`⬆ DEF${ab.team?' al equipo':''}`);
      if(ab.kind==='critDown'&&tgtName) out.push(`⬇ crítico de ${tgtName}`);
      if(ab.kind==='mark'&&tgtName) out.push(`🎯 marca a ${tgtName}`);
    }
  }
  return out.length?' · '+out.join(' · '):'';
}
/* ===== COMBATE POR RONDAS: planificas (10s) y luego se resuelve ===== */
function startCombat(){
  CB.speed=1;
  const vs=$(".vs"); if(vs){vs.style.opacity=1;setTimeout(()=>{vs.style.opacity=0;},800);}
  if(!localStorage.getItem('aigrons_combat_tip')){ localStorage.setItem('aigrons_combat_tip','1'); showCombatTip(); return; }
  planTurn();
}
// Fase de PLANIFICACIÓN: eliges acción de tus 3 aigrons para la ronda.
function planTurn(){
  if(!CB||CB.ended)return;
  if(CB.timer){clearInterval(CB.timer);CB.timer=null;}
  CB.phase='plan'; CB.planTurn=CB.turn+1; CB.selecting=null;
  CB.plan={}; CB.A.forEach(u=>{ if(u.hp>0) CB.plan[u.uid]={action:'basic',target:null,overcharge:false}; });
  [...CB.A,...CB.B].forEach(x=>x.el&&x.el.classList.remove("acting"));
  // PvE: SIN límite de tiempo (feedback: 10s agobia aprendiendo). El temporizador
  // solo existe en PvP en vivo, donde lo impone el servidor (pvpRound).
  CB.planEndsAt=null;
  if(CB.planTimer){clearInterval(CB.planTimer);CB.planTimer=null;}
  renderPlanner();
  if(autoMode()) setTimeout(()=>{ if(CB&&CB.phase==='plan'&&!CB.live)confirmPlan(); },600);
}
function planTimerTick(){
  if(!CB||CB.phase!=='plan'){ if(CB&&CB.planTimer){clearInterval(CB.planTimer);CB.planTimer=null;} return; }
  const left=CB.planEndsAt-Date.now();
  const bar=$("#plan-bar"); if(bar) bar.style.width=Math.max(0,Math.min(100,left/10000*100))+"%";
  if(left<=0) confirmPlan();
}
function renderPlanner(){
  const p=$("#planner"); if(!p)return;
  setBanner(`Ronda ${CB.planTurn} · planifica tus aigrons`);
  const rows=CB.A.filter(u=>u.hp>0).map(u=>{
    const ab=ABILITIES[u.ability];
    const proj=Math.min(COMBAT_ENERGY_MAX,u.energy+1);
    const ready=proj>=ab.cost, canOc=proj>=ab.cost+2;
    const pl=CB.plan[u.uid]||{action:'basic'};
    const tgtName=pl.target?((CB.B.find(x=>x.uid===pl.target)||{}).name||'auto'):'auto';
    const lbl = pl.action==='guard'?'🛡️ Guardia'
      : pl.action==='ability'?`✨ ${ab.name}${pl.overcharge?' ⚡⚡':''} → ${tgtName}`
      : `⚔️ Atacar → ${tgtName}`;
    return `<div class="plan-unit ${CB.selecting===u.uid?'sel':''}">
      <div class="pu-spr">${artTag(tpl(u.tplId),4)}</div>
      <div class="pu-body">
        <div class="pu-nm"><span class="dim" style="font-size:10px">Nv${u.level}</span> ${u.name} <span class="dim" style="font-size:10px">⚡${proj}/${ab.cost}</span></div>
        <div class="pu-ab">✨ ${ab.name}: ${abilityShort(u.ability)}</div>
        <div class="pu-lbl">${lbl}</div>
      </div>
      <div class="pu-acts">
        <button class="pa ${pl.action==='attack'?'on':''}" data-act="planSet" data-arg="${u.uid}:attack" title="Atacar normal">⚔️</button>
        <button class="pa ${pl.action==='ability'?'on':''} ${ready?'':'dis'}" data-act="planSet" data-arg="${u.uid}:ability" title="${ab.name}: ${abilityEffect(u.ability)}">✨</button>
        <button class="pa ${pl.action==='guard'?'on':''}" data-act="planSet" data-arg="${u.uid}:guard" title="Guardia: protege al equipo">🛡️</button>
        ${canOc&&pl.action==='ability'?`<button class="pa oc ${pl.overcharge?'on':''}" data-act="planOc" data-arg="${u.uid}" title="Sobrecarga ×1.5">⚡⚡</button>`:''}
      </div>
    </div>`;
  }).join("");
  const leftPct=CB.planEndsAt?Math.max(0,Math.min(100,(CB.planEndsAt-Date.now())/10000*100)):100;
  // Barra de tiempo SOLO en PvP en vivo (deadline del servidor); en PvE piensas
  // lo que quieras (feedback: los 10s agobian aprendiendo).
  const timerBar=CB.planEndsAt?`<div class="plan-timer"><i id="plan-bar" style="width:${leftPct}%"></i></div>`:'<span class="dim" style="font-size:10px;margin-left:auto">⌛ sin límite de tiempo</span>';
  p.innerHTML=`<div class="plan-head"><b>RONDA ${CB.planTurn}</b>${timerBar}</div>
    ${rows}
    ${CB.selecting?`<div class="targhint">🎯 Toca un enemigo para <b>${(CB.A.find(x=>x.uid===CB.selecting)||{}).name}</b> · <span data-act="planAuto" style="color:var(--gold);cursor:pointer">auto</span></div>`:'<div class="dim tc" style="font-size:11px;margin:4px 0">Elige acción de cada aigrón. ⚔️/✨ puedes tocar un enemigo para focalizar.</div>'}
    <button class="btn mag mt8" style="width:100%" data-act="confirmPlan">LISTO ▶</button>`;
  renderCanvases(p);
  refreshArena();
}
// Habilidades de OBJETIVO ÚNICO (piden rival). El resto (equipo/self/AoE) son
// automáticas y no deben pedir objetivo.
const TARGETED_KINDS={dmg:1,dot:1,stun:1,drain:1,mark:1,critDown:1,double:1};
function abilityNeedsTarget(key){ const a=ABILITIES[key]; return !!(a&&TARGETED_KINDS[a.kind]); }
function planSet(arg){
  if(!CB||CB.phase!=='plan')return;
  const i=arg.indexOf(':'); const uid=arg.slice(0,i), action=arg.slice(i+1);
  const u=CB.A.find(x=>x.uid===uid); if(!u||u.hp<=0)return;
  const ab=ABILITIES[u.ability], proj=Math.min(COMBAT_ENERGY_MAX,u.energy+1);
  if(action==='ability'&&proj<ab.cost){ toast('Sin energía aún para '+ab.name); return; }
  const pl=CB.plan[uid]; pl.action=action;
  if(action==='guard'){ pl.target=null; pl.overcharge=false; CB.selecting=null; }
  else if(action==='ability'&&!abilityNeedsTarget(u.ability)){ pl.target=null; CB.selecting=null; } // equipo/self/AoE: automática
  else { CB.selecting=uid; } // ataque o habilidad de objetivo único -> elegir rival (opcional)
  renderPlanner();
}
function planOc(uid){
  if(!CB||CB.phase!=='plan')return; const u=CB.A.find(x=>x.uid===uid); if(!u)return;
  const ab=ABILITIES[u.ability]; const pl=CB.plan[uid];
  if(pl.action!=='ability'||Math.min(COMBAT_ENERGY_MAX,u.energy+1)<ab.cost+2)return;
  pl.overcharge=!pl.overcharge; renderPlanner();
}
function planEnemy(uid){
  if(!CB||CB.phase!=='plan'||!CB.selecting)return;
  const pl=CB.plan[CB.selecting]; if(pl&&(pl.action==='attack'||pl.action==='ability')) pl.target=uid;
  CB.selecting=null; renderPlanner();
}
function planAuto(){ if(!CB||!CB.selecting)return; const pl=CB.plan[CB.selecting]; if(pl)pl.target=null; CB.selecting=null; renderPlanner(); }
function confirmPlan(){
  if(!CB||CB.phase!=='plan')return;
  if(CB.planTimer){clearInterval(CB.planTimer);CB.planTimer=null;}
  if(CB.live){ return pvpConfirm(); }
  Object.keys(CB.plan).forEach(uid=>{ const pl=CB.plan[uid];
    if(pl.action==='guard') CB.decisions.push({turn:CB.planTurn,uid,action:'guard'});
    else if(pl.action==='ability') CB.decisions.push({turn:CB.planTurn,uid,action:'ability',target:pl.target||undefined,overcharge:!!pl.overcharge});
    else if(pl.action==='attack'&&pl.target) CB.decisions.push({turn:CB.planTurn,uid,action:'attack',target:pl.target});
  });
  CB.phase='resolve'; CB.selecting=null;
  const p=$("#planner"); if(p) p.innerHTML='';
  resolveTurn();
}
// Fase de RESOLUCIÓN: anima la ronda (todos actúan por velocidad), luego vuelve a planificar.
function resolveTurn(){ if(CB.timer)clearInterval(CB.timer); CB.timer=setInterval(resolveTick, tickMs()); }
function resolveTick(){
  if(!CB||CB.ended)return;
  if(!CB.A.some(u=>u.hp>0)||!CB.B.some(u=>u.hp>0)){ finishBattle(); return; }
  if(CB.oi>=CB.order.length){
    if(CB.turn>=CB.planTurn){ // la ronda planificada terminó -> a planificar de nuevo
      if(CB.timer){clearInterval(CB.timer);CB.timer=null;}
      if(CB.turn>=TURNS_MAX){ finishBattle(); return; }
      planTurn(); return;
    }
    CB.turn++; CB.order=E.turnOrder(CB.A,CB.B); CB.oi=0;
  }
  let u=null;
  while(CB.oi<CB.order.length){ const c=CB.order[CB.oi++]; if(c.hp>0){u=c;break;} }
  if(!u) return;
  [...CB.A,...CB.B].forEach(x=>x.el&&x.el.classList.remove("acting"));
  if(u.el) u.el.classList.add("acting");
  E.decBuffs(u);
  u.energy=Math.min(COMBAT_ENERGY_MAX,u.energy+1);
  const st=E.tickStatus(u); // veneno/quemadura + aturdimiento (igual que el motor)
  const mine=u.team==='A'?CB.A:CB.B, foes=u.team==='A'?CB.B:CB.A;
  const who=u.team==='A'?'var(--cyan)':'var(--magenta)';
  const hpBefore=new Map([...CB.A,...CB.B].map(x=>[x.uid,x.hp])); // para detectar curas en el historial
  let action;
  if(u.hp<=0){ action={uid:u.uid,name:u.name,ability:null,guard:false,hits:[],poison:st.poison,died:true}; }
  else if(st.stunned){ action={uid:u.uid,name:u.name,stunned:true,hits:[],poison:st.poison}; }
  else {
    let intent;
    if(u.team==='A'){
      const pl=CB.plan[u.uid];
      if(pl&&pl.action==='guard') intent={type:'guard'};
      else if(pl&&pl.action==='ability'&&u.energy>=ABILITIES[u.ability].cost) intent={type:'ability',target:pl.target,overcharge:!!pl.overcharge};
      else if(pl&&pl.action==='attack') intent={type:'basic',target:pl.target};
      else intent={type:'basic'};
    } else intent=E.aiIntent(CB.rng,u,foes,mine);
    action=E.performAction(CB.rng,u,intent,mine,foes); action.poison=st.poison;
  }
  logAction(u,action,st,actionExtras(u,action,hpBefore,mine,foes));
  if(st.poison && u.el){ floatNum(u,"☠"+st.poison,"var(--epi)"); SFX.play('poison'); } // veneno/quemadura
  if(action.stunned) setBanner(`<span style="color:${who}">${u.name}</span> está aturdido 💫`);
  else if(action.died) setBanner(`<span style="color:${who}">${u.name}</span> cae por el veneno ☠`);
  else if(action.guard) setBanner(`<span style="color:${who}">${u.name}</span> se protege 🛡️`);
  else if(action.ability){ setBanner(`<span style="color:${who}">${u.name}</span> usa <b style="color:var(--gold)">${action.ability}</b>${action.overcharge?' ⚡⚡×1.5':''}`); SFX.play('ability'); }
  else if(action.hits.length) setBanner(`<span style="color:${who}">${u.name}</span> ataca`);
  action.hits.forEach(h=>{const t=h.tgt; if(!t.el)return; t.el.classList.remove("hit");void t.el.offsetWidth;t.el.classList.add("hit");
    SFX.play(h.crit?'crit':'hit'); buzz(h.crit?40:15); impactFx(t,h);
    floatNum(t,(h.shielded?"🛡":"")+(h.guarded?"🛡️":"")+(h.crit?"¡":"")+h.dmg+(h.crit?"!":""),h.crit?"var(--gold)":h.shielded?"#aebfce":h.guarded?"var(--cyan)":h.typeM>1?"var(--magenta)":"#fff",h.crit);});
  refreshArena();
  if(!CB.A.some(x=>x.hp>0)||!CB.B.some(x=>x.hp>0)) finishBattle();
}
function cbSpeed(){ if(!CB)return; CB.speed=CB.speed===1?2:CB.speed===2?3:1; localStorage.setItem('aigrons_speed',String(CB.speed)); const b=$("#cb-speed"); if(b)b.textContent="▶▶ "+CB.speed+"x"; if(CB.phase==='resolve'&&CB.timer)resolveTurn(); }
function cbAuto(){ const on=localStorage.getItem('aigrons_auto')==='1'?'0':'1'; localStorage.setItem('aigrons_auto',on); const b=$("#cb-auto"); if(b)b.classList.toggle('on',on==='1'); toast(on==='1'?'🤖 AUTO activado':'AUTO desactivado'); if(on==='1'&&CB&&CB.phase==='plan')confirmPlan(); }
function showCombatTip(){
  openOverlay(`<div>
    <div class="center" style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin-bottom:10px">CÓMO LUCHAR</div>
    <div style="font-size:13px;line-height:1.6">
      • Combate por <b>rondas</b>. En cada ronda tienes <b>10s</b> para <b>planificar</b> a tus 3 aigrons (o pulsa LISTO).<br>
      • Por cada uno elige: <b>⚔️ Atacar</b>, <b>✨ Habilidad</b> (si tiene energía) o <b>🛡️ Guardia</b>.<br>
      • Con ⚔️ o ✨ puedes <b>tocar un enemigo</b> para focalizarlo (mira <span style="color:var(--green)">⬆</span> fuerte / <span style="color:var(--red)">⬇</span> débil por tipo), o se elige solo.<br>
      • <b>⚡</b> = energía (sube 1/ronda). <b>⚡⚡ Sobrecarga</b>: gasta +2⚡ para pegar ×1.5.<br>
      • Pulsa <b>LISTO</b> y la ronda se resuelve animada (actúa antes quien tiene más velocidad).
    </div>
    <button class="btn mt8" style="width:100%" data-act="combatTipOk">¡ENTENDIDO!</button>
  </div>`);
}
function combatTipOk(){ closeOverlay(); planTurn(); }
function finishBattle(){
  if(!CB||CB.ended)return; CB.ended=true;
  if(CB.timer){clearInterval(CB.timer);CB.timer=null;}
  if(CB.planTimer){clearInterval(CB.planTimer);CB.planTimer=null;}
  // Self-check (dev): recomputar con el motor y comparar con la animación.
  try{
    const A2=CB.initA.map((s,i)=>E.unitFromStats(s,'A',i));
    const B2=CB.initB.map((s,i)=>E.unitFromStats(s,'B',i));
    if(CB.relics){ E.applyRelics(A2,CB.relics); A2.forEach((u,i)=>u.hp=Math.min(u.hpMax, CB.initA[i].hp!=null?CB.initA[i].hp:u.hpMax)); }
    const rr=E.resolveBattle(A2,B2,CB.seed,CB.decisions);
    const animWin=CB.A.some(u=>u.hp>0)&&(!CB.B.some(u=>u.hp>0)||sumHp(CB.A)>=sumHp(CB.B));
    if((rr.winner==='A')!==animWin) console.warn('AIGRONS: animación≠motor', rr.winner, animWin, CB.decisions);
    // Comparación HP por-unidad (detecta divergencias finas en veneno/aturdir/escudo/drenaje).
    const cmp=(anim,eng)=>anim.forEach((u,i)=>{ if(Math.round(u.hp)!==Math.round(eng[i].hp)) console.warn('AIGRONS: HP≠motor', u.team, u.name, Math.round(u.hp), Math.round(eng[i].hp), CB.decisions); });
    cmp(CB.A,A2); cmp(CB.B,B2);
  }catch(e){}
  const battleId=CB.battleId, decisions=CB.decisions, mode=CB.mode, onResolve=CB.onResolve;
  setTimeout(()=>{
    if(typeof onResolve==='function'){ onResolve(decisions); return; } // modos genéricos (puzzle/boss/némesis/arena)
    if(mode==='dungeon'){
      api('/dungeon/battle',{method:'POST',body:{decisions}})
        .then(r=>{ CB=null; refreshMe().then(refreshChips); D=r.state; showDungeonResult(r); })
        .catch(err=>{ toast('Error al resolver'); CB=null; go('dungeon'); });
    } else {
      api('/battle/resolve',{method:'POST',body:{battleId,decisions}})
        .then(r=>{ refreshMe().then(refreshChips); showResult(r); })
        .catch(err=>{ toast('Error al resolver el combate'); CB=null; go('home'); });
    }
  },650);
}
// Combate local PvE genérico (puzzle/jefe/némesis/arena): mismas unidades A/B,
// planificador y animación de siempre; al acabar llama onResolve(decisions) para
// que cada modo valide en su endpoint. teamUnits/enemyUnits = stats públicos.
function startLocalCombat(opts){
  const A=opts.team.map((s,i)=>mkUnit(s,'A',i));
  const B=opts.enemy.map((s,i)=>mkUnit(s,'B',i));
  registerUnitArt(opts.team); registerUnitArt(opts.enemy);
  const seed=(opts.seed|0)||((Math.random()*0x7fffffff)|0);
  CB={A,B,seed,mode:opts.mode||'local',pvp:false,rng:mulberry32(seed>>>0),
      turn:0,order:[],oi:0,plan:{},planTurn:0,selecting:null,phase:'plan',speed:savedSpeed(),decisions:[],timer:null,planTimer:null,
      initA:opts.team,initB:opts.enemy,ended:false,onResolve:opts.onResolve,title:opts.title||'COMBATE'};
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  $("#s-battle").classList.add("active");
  buildArena();
  startCombat();
}
function showResult(r){
  const win=r.win;
  MUSIC.setScene('menu');
  SFX.play(win?'win':'lose'); buzz(win?[40,60,80]:60);
  openOverlay(`<div class="center">
     <div style="font-family:var(--pixel);font-size:16px;color:${win?'var(--gold)':'var(--ink-dim)'};margin-bottom:10px">${win?'¡VICTORIA!':'DERROTA'}</div>
     <div style="font-size:50px;margin-bottom:8px">${win?'🏆':'💀'}</div>
     <div class="panel" style="text-align:left">
       <div>🪙 Monedas <b style="float:right;color:var(--gold)">+${r.coins}</b></div>
       <div class="mt8">🏅 Puntos de liga <b style="float:right;color:${win?'var(--green)':'var(--red)'}">${r.leaguePoints}</b></div>
       <div class="mt8">🏆 Liga <b style="float:right;color:var(--cyan)">${r.league}</b></div>
       ${r.pvp?'<div class="mt8 dim" style="font-size:12px">Combate PvP asíncrono</div>':''}
     </div>
     <button class="btn mt8" data-act="continueBattle">CONTINUAR</button>
   </div>`);
}
function flee(){
  // En la mazmorra huir NO es gratis: termina la run (permadeath). Confirmación.
  if(CB&&CB.mode==='dungeon'&&!CB.ended){
    openOverlay(`<div class="center">
      <div style="font-family:var(--pixel);font-size:13px;color:var(--red);margin-bottom:10px">¿HUIR?</div>
      <div style="font-size:13px;line-height:1.6;margin-bottom:12px">Si huyes, la run <b>termina aquí</b> (☠️ permadeath).<br>Contará como derrota en el nodo actual.</div>
      <button class="btn mag" data-act="fleeDungeon">🏳 HUIR — FIN DE LA RUN</button>
      <button class="btn ghost mt8" data-act="fleeStay">SEGUIR LUCHANDO</button>
    </div>`);
    return;
  }
  if(CB){if(CB.live){pvpSend({t:'leave'});if(PVP){try{PVP.ws.close();}catch(e){}PVP=null;}}if(CB.timer)clearInterval(CB.timer);if(CB.planTimer)clearInterval(CB.planTimer);}
  CB=null;go('home');
}
function fleeStay(){
  closeOverlay();
  // Si estaba planificando, devuelve los 10 s completos (el reloj siguió corriendo).
  if(CB&&CB.phase==='plan'&&CB.planEndsAt) CB.planEndsAt=Date.now()+10000;
}
function fleeDungeon(){
  closeOverlay();
  if(!CB||CB.ended) return;
  if(CB.timer)clearInterval(CB.timer);
  if(CB.planTimer)clearInterval(CB.planTimer);
  CB=null;
  api('/dungeon/abandon',{method:'POST'})
    .then(r=>{ D=r.state; refreshMe().then(refreshChips).catch(()=>{}); showDungeonResult(Object.assign({win:false},r)); })
    .catch(()=>{ toast('No se pudo huir'); go('dungeon'); });
}

/* ====================== MAZMORRA (roguelike) ====================== */
let D=null;
function relicChip(id){ const r=ENGINE.RELICS[id]; return r?`<div class="dg-relic" title="${r.name}: ${r.desc}">${r.emoji}</div>`:''; }
function dgHeader(){
  // Pips junto al título (no perdidos a la derecha): hechos = cian, actual
  // brillando, jefe con borde dorado.
  const pips=[]; for(let i=0;i<D.totalDepth;i++){ const boss=i===D.totalDepth-1;
    pips.push(`<span class="dg-pip ${i<D.depth?'done':''} ${i===D.depth&&D.status==='active'?'cur':''} ${boss?'boss':''}"></span>`); }
  const team=D.team.map(m=>`<div class="dg-mem ${m.dead?'dead':''}">
     ${artTag(tpl(m.tplId),5)}
     <div class="hpbar"><i style="width:${m.dead?0:Math.round(m.hp/m.hpMax*100)}%;background:${m.hp/m.hpMax<0.3?'var(--red)':m.hp/m.hpMax<0.6?'var(--gold)':'var(--green)'}"></i></div>
     <div style="font-size:10px">${m.dead?'☠️':m.hp+'/'+m.hpMax}</div></div>`).join("");
  const nodeLvl=ENGINE.dungeonLevelAt(D.diffLevel||1,Math.min(D.depth,D.totalDepth-1),'COMBATE');
  return `<div class="dg-bar"><b>Nodo ${Math.min(D.depth+1,D.totalDepth)}/${D.totalDepth}</b>
       <span style="display:flex;gap:4px">${pips.join("")}</span>
       <span style="margin-left:auto;color:var(--epi)">${D.diffLabel||''} · nv~${nodeLvl}</span>
       <span class="dim" style="font-size:11px">botín: <b style="color:var(--gold)">${D.coins}</b>🪙</span></div>
     <div class="dg-team">${team}</div>
     <div class="dg-relics">${D.relics.length?D.relics.map(relicChip).join(""):'<span class="dim" style="font-size:12px">Sin reliquias aún</span>'}</div>`;
}
const NODE_INFO={ COMBATE:{ic:'⚔️',t:'Combate',d:'Enemigos del nivel'}, ELITE:{ic:'💀',t:'Élite',d:'Más difícil, mejor botín'}, JEFE:{ic:'👑',t:'JEFE FINAL',d:'Derrótalo para completar la mazmorra'}, DESCANSO:{ic:'🏕️',t:'Descanso',d:'Cura 40% al equipo'}, TIENDA:{ic:'🛒',t:'Tienda',d:'Compra reliquias o cura'} };
async function renderDungeon(){
  refreshChips();
  try{ D=await api('/dungeon'); }catch(e){ D={status:'none'}; }
  const el=$("#s-dungeon");
  if(!D||D.status==='none'){
    el.innerHTML=`<h2 class="title">MAZMORRA <small>del día</small></h2>
      <div class="panel"><div class="tc" style="font-size:40px">🗺️</div>
        <div class="tc mb8"><b>Mazmorra del Día</b></div>
        <div class="dim" style="font-size:13px">Recorre ${ENGINE.DUNGEON_DEPTH} nodos con tu equipo. El HP <b>se arrastra</b>, recoges <b>reliquias</b> y si caes acaba la run. <b>Elige dificultad</b>: el nivel de los enemigos lo fija ella, no el tuyo. Runs ilimitadas.</div></div>
      ${difficultyPicker()}
      ${dgRankSection()}`;
    loadDgRank(); return;
  }
  if(D.status==='cleared'||D.status==='dead'){
    el.innerHTML=`<h2 class="title">MAZMORRA <small>${D.diffLabel||''}</small></h2>
      <div class="panel tc">
        <div style="font-size:40px">${D.status==='cleared'?'🏆':'☠️'}</div>
        <div class="mb8"><b>${D.status==='cleared'?'¡MAZMORRA COMPLETADA!':'Run terminada'}</b></div>
        <div class="dim" style="font-size:13px">Llegaste al nodo <b style="color:var(--cyan)">${D.depth}/${D.totalDepth}</b> en <b>${D.diffLabel}</b>. Reintenta o cambia de dificultad.</div></div>
      ${dgHeader()}
      ${difficultyPicker()}
      ${dgRankSection()}`;
    renderCanvases(el); loadDgRank(); return;
  }
  let body='';
  if(D.stage==='choosing'){
    // Preview determinista del enemigo en nodos de combate (mismo motor y
    // semilla que usará el servidor): elegir camino con información.
    const preview=(kind)=>{
      try{
        const tpls=(S.daily&&S.daily.highlights)||[];
        if(!tpls.length||D.seed==null)return '';
        const en=E.dungeonEnemyTeam(D.seed,D.depth,kind,tpls,D.diffLevel||1);
        return `<div style="font-size:11px;margin-top:3px">${en.map(u=>{const t=tpl(u.tplId)||{};
          return `<span class="rar-txt ${t.rarity||'COMUN'}">${u.name}</span> <span class="dim">nv${u.level}</span>`;}).join(' · ')}</div>`;
      }catch(e){return '';}
    };
    body=`<div class="dim mb8" style="font-size:13px">Elige tu camino:</div>`+
      D.options.map((o,i)=>{const n=NODE_INFO[o.type]||{ic:'?',t:o.type,d:''};
        const pv=(o.type==='COMBATE'||o.type==='ELITE'||o.type==='JEFE')?preview(o.type):'';
        return `<div class="node-opt ${o.type}" data-act="dgChoose" data-arg="${i}">
          <span class="ni2">${n.ic}</span><div style="min-width:0"><b>${n.t}</b><div class="dim" style="font-size:12px">${n.d}</div>${pv}</div></div>`;}).join("");
  } else if(D.stage==='draft'){
    body=`<div class="dim mb8" style="font-size:13px">¡Nodo superado! Elige una reliquia:</div>`+
      D.draft.map((r,i)=>`<div class="relic-card" data-act="dgDraft" data-arg="${i}">
        <span class="re">${r.emoji}</span><div><b>${r.name}</b><div class="dim" style="font-size:12px">${r.desc}</div></div></div>`).join("")+
      `<button class="btn sm ghost mt8" style="width:100%" data-act="dgSkipDraft">SALTAR (no coger)</button>`;
  } else if(D.stage==='shop'){
    body=`<div class="dim mb8" style="font-size:13px">🛒 Tienda · 🪙 ${D.coins}</div>`+
      D.shop.relics.map((r,i)=>`<div class="relic-card" data-act="dgBuy" data-arg="${i}">
        <span class="re">${r.emoji}</span><div style="flex:1"><b>${r.name}</b><div class="dim" style="font-size:12px">${r.desc}</div></div>
        <span style="color:var(--gold)">${D.shop.relicCost}🪙</span></div>`).join("")+
      `<div class="relic-card" data-act="dgHeal"><span class="re">💊</span><div style="flex:1"><b>Curar equipo 50%</b></div><span style="color:var(--gold)">${D.shop.healCost}🪙</span></div>
       <button class="btn mt8" style="width:100%" data-act="dgLeaveShop">SEGUIR</button>`;
  } else if(D.stage==='combat'){
    body=`<div class="panel tc"><b>${D.battle&&D.battle.kind==='JEFE'?'👑 ¡JEFE!':D.battle&&D.battle.kind==='ELITE'?'💀 ¡Élite!':'⚔️ ¡Combate!'}</b>
       <div class="dim mb8" style="font-size:13px">Tu equipo conserva el HP de antes.</div>
       <button class="btn mag" data-act="dgFight">LUCHAR</button></div>`;
  }
  el.innerHTML=`<h2 class="title">MAZMORRA <small>nodo ${Math.min(D.depth+1,D.totalDepth)}/${D.totalDepth}</small></h2>${dgHeader()}${body}`;
  renderCanvases(el);
}
const DG_ORDER=['FACIL','NORMAL','DIFICIL','EXPERTO','PESADILLA'];
let dgDiff='NORMAL';
// Nivel medio del equipo (o de tus 3 primeros aigrons, igual que hace el servidor).
function myTeamLevel(){
  let team=S.team.map(instById).filter(Boolean);
  if(!team.length)team=S.collection.slice(0,3);
  return team.length?Math.round(team.reduce((a,i)=>a+i.level,0)/team.length):1;
}
function difficultyPicker(){
  // La mazmorra es una RAMPA: empieza suave (~25% del nivel de referencia) y
  // sube hasta superar el nivel en el jefe. La recomendación es HONESTA: en
  // verde solo si puedes al menos PROGRESAR (tu nivel >= primer nodo); si hasta
  // la más fácil te supera de inicio, aviso ámbar — nada de "ideal" engañoso.
  const lvl=myTeamLevel();
  const startOf=id=>ENGINE.dungeonLevelAt(ENGINE.DUNGEON_DIFFICULTIES[id].level,0,'COMBATE');
  const bossOf=id=>ENGINE.dungeonLevelAt(ENGINE.DUNGEON_DIFFICULTIES[id].level,ENGINE.DUNGEON_DEPTH-1,'JEFE');
  // Recomendada: la más alta cuyo primer nodo puedas pelear de tú a tú.
  let recId=null;
  DG_ORDER.forEach(id=>{ if(lvl>=startOf(id)) recId=id; });
  const cards=DG_ORDER.map(id=>{const d=ENGINE.DUNGEON_DIFFICULTIES[id];
    const s=startOf(id),b=bossOf(id);
    const rec=id===recId;
    const tooHard=lvl<s;
    const tag=rec?'<span style="color:var(--cyan);font-size:10px;font-weight:700">✓ PUEDES PROGRESAR</span>'
      :tooHard?`<span style="color:var(--gold);font-size:10px;font-weight:700">⚠️ EMPIEZA EN NV${s} — AÚN TE SUPERA</span>`:'';
    return `<div class="relic-card" style="align-items:center;${rec?'border-color:var(--cyan);box-shadow:0 0 8px rgba(52,245,228,.3)':tooHard?'border-color:var(--gold)':''}">
      <div style="flex:1"><b>${d.label}</b> ${tag}
        <div class="dim" style="font-size:11px">Enemigos nv${s} → nv${b} (jefe) · tu equipo: <b style="color:${tooHard?'var(--gold)':'var(--green)'}">nv${lvl}</b> · recompensa ×${d.coinMult}</div></div>
      <button class="btn sm ${rec?'':'ghost'}" data-act="dgStart" data-arg="${id}">JUGAR</button></div>`;}).join("");
  const warn=recId===null?`<div class="dim" style="font-size:12px;margin-top:6px">⚠️ Hasta la dificultad más baja empieza por encima de tu equipo (nv${lvl}). Puedes intentarlo igualmente, pero te recomendamos subir niveles primero.</div>`:'';
  return `<div class="panel"><div class="row" style="justify-content:space-between;align-items:center">
    <b style="font-size:13px">Elige dificultad</b><span class="dim" style="font-size:11px">la mazmorra sube de nivel nodo a nodo</span></div>
    ${warn}
    <div class="mt8">${cards}</div></div>`;
}
function dgRankSection(){
  const tabs=DG_ORDER.map(id=>`<button class="f ${dgDiff===id?'on':''}" data-act="dgRankTab" data-arg="${id}">${ENGINE.DUNGEON_DIFFICULTIES[id].label}</button>`).join("");
  return `<div class="panel"><b style="font-size:13px">Ranking de hoy</b>
    <div class="filters mt8">${tabs}</div>
    <div id="dg-rank" class="mt8 dim" style="font-size:12px">Cargando…</div></div>`;
}
function dgRankTab(id){ dgDiff=id; renderDungeon(); }
async function loadDgRank(){
  try{ const r=await api('/dungeon/ranking?difficulty='+dgDiff); const box=$("#dg-rank"); if(!box)return;
    const rows=r.rows||[];
    box.innerHTML=rows.length?rows.slice(0,10).map(x=>`<div class="rank-row ${x.me?'me':''}" style="padding:5px 4px"><span class="pos">${x.pos}</span><span class="nm">${esc(x.name)}</span><span style="color:var(--gold)">${x.cleared?'🏆 ':''}nodo ${x.depth}</span></div>`).join(""):'Nadie ha entrado aún en esta dificultad.';
  }catch(e){}
}
async function dgStart(diff){ try{ dgDiff=ENGINE.DUNGEON_DIFFICULTIES[diff]?diff:dgDiff; D=await api('/dungeon/start',{method:'POST',body:{difficulty:dgDiff}}); renderDungeon(); }catch(e){ toast(e.data&&e.data.error==='empty_team'?'Configura tu equipo en INICIO':'No se pudo entrar'); } }
async function dgChoose(i){ try{ D=await api('/dungeon/choose',{method:'POST',body:{choice:+i}}); renderDungeon(); }catch(e){ toast('No se pudo'); } }
async function dgDraft(i){ try{ D=await api('/dungeon/draft',{method:'POST',body:{choice:+i}}); renderDungeon(); }catch(e){ toast('No se pudo'); } }
async function dgSkipDraft(){ try{ D=await api('/dungeon/draft',{method:'POST',body:{skip:true}}); renderDungeon(); }catch(e){} }
async function dgBuy(i){ try{ D=await api('/dungeon/shop',{method:'POST',body:{action:'buy',arg:+i}}); renderDungeon(); }catch(e){ toast(e.data&&e.data.error==='insufficient'?'Te faltan monedas':'No se pudo'); } }
async function dgHeal(){ try{ D=await api('/dungeon/shop',{method:'POST',body:{action:'heal'}}); renderDungeon(); }catch(e){ toast(e.data&&e.data.error==='insufficient'?'Te faltan monedas':'No se pudo'); } }
async function dgLeaveShop(){ try{ D=await api('/dungeon/shop',{method:'POST',body:{action:'leave'}}); renderDungeon(); }catch(e){} }
function dgFight(){
  const b=D.battle; if(!b){ renderDungeon(); return; }
  const A=b.team.map((s,i)=>E.unitFromStats(s,'A',i)); E.applyRelics(A,b.relics); A.forEach((u,i)=>u.hp=Math.min(u.hpMax,b.team[i].hp));
  const B=b.enemy.map((s,i)=>E.unitFromStats(s,'B',i));
  CB={A,B,seed:b.battleSeed|0,mode:'dungeon',pvp:false,rng:mulberry32(b.battleSeed>>>0),
      turn:0,order:[],oi:0,plan:{},planTurn:0,selecting:null,phase:'plan',speed:savedSpeed(),decisions:[],timer:null,planTimer:null,
      initA:b.team,initB:b.enemy,relics:b.relics,ended:false};
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  $("#s-battle").classList.add("active");
  document.querySelectorAll(".nav button").forEach(x=>x.classList.toggle("on",x.dataset.screen==='dungeon'));
  buildArena();
  startCombat();
}
function showDungeonResult(r){
  const win=r.win; let extra='';
  MUSIC.setScene('menu');
  SFX.play(win?'win':'lose'); buzz(win?[40,60,80]:60);
  if(r.cleared) extra='<div style="color:var(--gold);margin-top:6px">🏆 ¡Mazmorra completada!</div>';
  else if(r.fled) extra='<div style="color:var(--red);margin-top:6px">🏳 Huiste — la run termina aquí.</div>';
  else if(r.dead) extra='<div style="color:var(--red);margin-top:6px">☠️ Tu equipo cayó.</div>';
  if(r.accountReward) extra+=`<div class="mt8">🪙 Recompensa a tu cuenta: <b style="color:var(--gold)">+${r.accountReward}</b></div>`;
  else if(r.noReward==='no_best'&&(r.cleared||r.dead)) extra+=`<div class="dim mt8" style="font-size:12px">Sin recompensa extra: no superaste tu mejor profundidad de hoy en esta dificultad.</div>`;
  openOverlay(`<div class="center">
     <div style="font-family:var(--pixel);font-size:15px;color:${win?'var(--gold)':'var(--ink-dim)'};margin-bottom:8px">${win?'¡NODO SUPERADO!':'DERROTA'}</div>
     <div style="font-size:44px">${win?'⚔️':'☠️'}</div>
     ${win&&r.coins?`<div class="mt8">🪙 +${r.coins} monedas de mazmorra</div>`:''}
     ${extra}
     <button class="btn mt8" data-act="dgContinue">CONTINUAR</button></div>`);
}
function dgContinue(){ closeOverlay(); go('dungeon'); }

/* ====================== RANKING ====================== */
let rankTab="diario";
const MEDALS=['🥇','🥈','🥉'];
async function renderRanking(){
  refreshChips();
  let rows=[],me=null,closeAt=null,rewards=null,hofWeek=null;
  try{
    if(rankTab==='fama'){ const h=await api('/hall-of-fame'); rows=h.rows||[]; hofWeek=h.week; }
    else{
      const r=await api(rankTab==="diario"?'/rankings/daily':'/rankings/league');
      // Compatibilidad: forma nueva {rows,me} o antigua (array).
      if(Array.isArray(r))rows=r;else{rows=r.rows||[];me=r.me||null;closeAt=r.closeAt||null;rewards=r.rewards||null;}
    }
  }catch(e){}
  // Cierre SEMANAL de ligas: cuenta atrás + tu recompensa si mantienes la liga.
  let closeLine='';
  if(rankTab==='liga'&&closeAt){
    const ms=new Date(closeAt)-Date.now();
    const d=Math.floor(ms/86400000),h=Math.floor(ms%86400000/3600000);
    const rw=rewards&&rewards[S.user.league];
    closeLine=`<div class="panel" style="padding:8px 10px;font-size:12px">⏳ Cierre semanal en <b style="color:var(--cyan)">${d}d ${h}h</b>${rw?` · recompensa ${S.user.league}: <b style="color:var(--gold)">+${rw.coins}🪙</b>${rw.gems?` <b style="color:var(--magenta)">+${rw.gems}💎</b>`:''}`:''}</div>`;
  }
  const rowHTML=r=>`<div class="rank-row ${r.me?'me':''}">
     <span class="pos">${r.pos<=3?MEDALS[r.pos-1]:r.pos}</span><span class="nm">${esc(r.name)}</span>
     <span style="color:var(--gold);font-weight:700">${r.score}${rankTab==='diario'?' ✕':' pts'}</span></div>`;
  let board=rows.length?rows.map(rowHTML).join("")
     :`<div class="dim tc" style="padding:18px">Aún no hay datos hoy.<br><button class="btn sm mag mt8" data-act="goHome">⚔️ IR A COMBATIR</button></div>`;
  // Tu posición SIEMPRE visible: si no estás en el top, se ancla abajo.
  if(rows.length&&me&&!rows.some(r=>r.me)){
    board+=`<div class="dim tc" style="font-size:11px;padding:3px">···</div>
      <div class="rank-row me"><span class="pos">${me.pos}</span><span class="nm">Tú</span>
      <span style="color:var(--gold);font-weight:700">${me.score}${rankTab==='diario'?' ✕':' pts'}</span></div>`;
  }
  const sub=rankTab==='diario'?'<div class="dim mb8" style="font-size:13px">Con el destacado de HOY (igual para todos), ¿quién ganó más combates?</div>'
    :rankTab==='fama'?`<div class="dim mb8" style="font-size:13px">👑 Salón de la fama: el top de la última semana cerrada${hofWeek?` (${hofWeek})`:''}.</div>`
    :`<div class="dim mb8" style="font-size:13px">Top global por puntos. Tú: <b style="color:var(--gold)">${S.user.league}</b> · <b style="color:var(--cyan)">${S.user.leaguePoints} pts</b>.</div>`;
  $("#s-ranking").innerHTML=`
    <h2 class="title">RANKING</h2>
    <div class="tabs">
      <div class="t ${rankTab==='diario'?'on':''}" data-act="setRank" data-arg="diario">DIARIO</div>
      <div class="t ${rankTab==='liga'?'on':''}" data-act="setRank" data-arg="liga">GLOBAL</div>
      <div class="t ${rankTab==='fama'?'on':''}" data-act="setRank" data-arg="fama">👑 FAMA</div></div>
    ${sub}
    ${closeLine}
    <div class="panel" style="padding:4px 8px">${board}</div>`;
}
function setRank(t){rankTab=t;renderRanking();}

/* ====================== TIENDA ====================== */
async function renderShop(){
  refreshChips();
  const item=(ico,t,d,btn,act,arg,extra,disabled)=>`<div class="panel shop-item">
     <div class="ico">${ico}</div><div class="meta"><div class="t">${t}</div><div class="d">${d}</div></div>
     <button class="btn sm ${extra||''}" ${disabled?'disabled':(act?`data-act="${act}" ${arg?`data-arg="${arg}"`:''}`:'disabled')}>${btn}</button></div>`;
  // Cada artículo muestra QUÉ recibes y QUÉ cuesta; la tirada enseña el techo
  // diario que queda (regla de producto: máx 10 tiradas pagas/día).
  const rollsLeft=Math.max(0,(S.user.rollsMax||10)-(S.user.rollsToday||0));
  const canRoll=rollsLeft>0&&S.user.coins>=100;
  const canEnergy=S.user.gems>=20&&S.user.energy<S.user.energyMax;
  $("#s-shop").innerHTML=`
    <h2 class="title">TIENDA <small class="dim">sin sorpresas tóxicas</small></h2>
    ${item("🥚","Tirada extra del álbum",
      `Aigrón del álbum (destacados más probables) · <b style="color:var(--gold)">100🪙</b> · quedan <b style="color:${rollsLeft>0?'var(--cyan)':'var(--red)'}">${rollsLeft}/${S.user.rollsMax||10}</b> hoy`,
      rollsLeft<=0?"MAÑANA":"TIRAR","shopRoll","","",!canRoll)}
    ${item("⚡","Recargar energía",`Energía al máximo (${S.user.energyMax}⚡) · <b style="color:var(--magenta)">20💎</b>`,
      S.user.energy>=S.user.energyMax?"LLENA":"RECARGAR","purchase","energy_refill","",!canEnergy)}
    ${item("💎","Pack de gemas",`<b style="color:var(--magenta)">+50💎</b> · 0,99 €`,"COMPRAR","purchase","gems_small","mag")}
    ${item("🎟️","Pase de temporada","30 días de recompensas · 4,99 €","COMPRAR","purchase","pass","gold")}
    <div class="dim tc mt8" style="font-size:12px">El dinero acelera tu colección, nunca compra victorias.<br>
    Las 💎 sirven para recargar energía (pronto: cosméticos). Las compras reales se validan con el recibo de la tienda.</div>`;
}
async function shopRoll(){
  try{
    const r=await api('/shop/roll',{method:'POST'});
    const t=registerTpl(r.template);
    await Promise.all([refreshMe(),refreshCollection()]); refreshChips();
    if($("#s-shop").classList.contains('active')) renderShop(); // contador de tiradas al día
    const rays=(t.rarity==="EPICA"||t.rarity==="LEGENDARIA")?'<div class="rays"></div>':'';
    openOverlay(`<div class="center reveal" style="position:relative">${rays}<div style="position:relative;z-index:2">
       ${artTag(t,10)}
       <div style="font-size:19px;font-weight:700;margin-top:6px">${t.name}</div>
       <div class="mb8"><span class="rar-txt ${t.rarity}" style="font-weight:700">${t.rarity} · ${typesLabel(t)}</span></div>
       <button class="btn" data-act="toCollection">¡GENIAL!</button></div></div>`);
  }catch(e){ const er=e.data&&e.data.error; toast(er==='daily_cap'?'Límite diario (10)':er==='insufficient'?'Te faltan monedas':'No se pudo'); }
}
async function purchase(sku){
  try{ const u=await api('/shop/purchase',{method:'POST',body:{sku}}); S.user=Object.assign(S.user,u); refreshChips(); renderShop(); toast(sku==='energy_refill'?'⚡ ¡Energía al máximo!':'¡Compra aplicada!'); }
  catch(e){ const er=e.data&&e.data.error;
    if(er==='insufficient_gems') toast('Te faltan gemas 💎');
    else if(er==='energy_full') toast('Energía ya llena');
    else if(e.status===501) toast('Requiere validación de recibo de tienda');
    else toast('No disponible'); }
}

/* ====================== NAVEGACIÓN + INIT ====================== */
const RENDER={home:renderHome,battle:renderBattle,dungeon:renderDungeon,collection:renderCollection,ranking:renderRanking,guild:renderGuildScreen,shop:renderShop};
function go(screen){
  if(CB&&CB.timer&&screen!=="battle"){clearInterval(CB.timer);CB=null;}
  MUSIC.setScene(screen==="battle"?"battle":"menu");
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  $("#s-"+screen).classList.add("active");
  document.querySelectorAll(".nav button").forEach(b=>b.classList.toggle("on",b.dataset.screen===screen));
  RENDER[screen]();
}
document.querySelectorAll(".nav button").forEach(b=>b.onclick=()=>go(b.dataset.screen));
const ACTIONS={
  doClaim:()=>doClaim(),
  claimMission:(a)=>claimMission(a),
  toCollection:()=>{closeOverlay();go("collection");},
  close:()=>closeOverlay(),
  setFilter:(a)=>setFilter(a),
  setSort:(a)=>setSort(a),
  goHome:()=>{closeOverlay();go('home');},
  shareAig:(a)=>shareAig(a),
  openProfile:()=>openProfile(), editName:()=>editName(), claimAch:(a)=>claimAch(a),
  openAlbum:()=>openAlbum(), claimAlbum:()=>claimAlbum(), tokenClaim:()=>tokenClaim(),
  openUnique:()=>openUnique(), claimUnique:()=>claimUnique(),
  openPuzzle:()=>openPuzzle(), puzzlePlay:()=>puzzlePlay(), puzzleShare:(a)=>puzzleShare(a),
  openBoss:()=>openBoss(), bossFight:()=>bossFight(),
  openNemesis:()=>openNemesis(), nemesisFight:()=>nemesisFight(),
  openArena:()=>openArena(), arenaPick:(a)=>arenaPick(a), arenaStart:()=>arenaStart(),
  watchReplay:(a)=>watchReplay(a), replaySpeed:()=>replaySpeed(), replayExit:()=>replayExit(),
  setFrame:(a,el)=>setFrame(a,el),
  duelPrivate:()=>duelPrivate(), duelStart:()=>duelStart(),
  pushEnable:()=>pushEnable(), pushSkip:()=>{closeOverlay();localStorage.setItem('aigrons_push_asked','1');},
  firstFight:()=>firstFight(),
  levelUp:(a)=>levelUp(a),
  evoOk:(a)=>{closeOverlay();openDetail(a);},
  chooseEvoPath:(a)=>chooseEvoPath(a), setEvoPath:(a)=>setEvoPath(a),
  toggleFav:(a)=>toggleFav(a),
  release:(a)=>release(a),
  fusionPick:(a)=>fusionPick(a),
  editTeam:()=>editTeam(),
  prepBattle:()=>prepBattle(),
  autoTeam:()=>autoTeam(),
  rematch:()=>rematch(),
  livePvp:()=>startLivePvp(), pvpCancel:()=>pvpCancel(), pvpDone:()=>pvpDone(),
  goBattle:()=>goBattle(),
  saveTeam:()=>saveTeam(),
  planSet:(a)=>planSet(a),
  planOc:(a)=>planOc(a),
  planEnemy:(a)=>planEnemy(a),
  planAuto:()=>planAuto(),
  confirmPlan:()=>confirmPlan(),
  cbSpeed:()=>cbSpeed(), cbAuto:()=>cbAuto(), combatTipOk:()=>combatTipOk(),
  pvpEmote:()=>pvpEmote(), sendEmote:(a)=>sendEmote(a),
  flee:()=>flee(),
  fleeDungeon:()=>fleeDungeon(), fleeStay:()=>fleeStay(),
  continueBattle:()=>{closeOverlay();go('home');},
  setRank:(a)=>setRank(a),
  shopRoll:()=>shopRoll(),
  purchase:(a)=>purchase(a),
  openTutorial:()=>openTutorial(),
  tutNext:()=>tutNext(), tutPrev:()=>tutPrev(), tutDone:()=>tutDone(),
  logout:()=>logout(),
  menuToggle:()=>{ $("#topmenu").classList.toggle("show");
    const s=$("#m-sound"); if(s)s.textContent=SFX.muted()?'🔇 Sonido: off':'🔊 Sonido: on';
    const mm=$("#m-music"); if(mm)mm.textContent=MUSIC.enabled()?'🎵 Música: on':'🎵 Música: off'; },
  menuTutorial:()=>{$("#topmenu").classList.remove("show");openTutorial();},
  menuSound:()=>{ const m=SFX.toggle(); const s=$("#m-sound"); if(s)s.textContent=m?'🔇 Sonido: off':'🔊 Sonido: on'; if(!m)SFX.play('claim'); },
  menuMusic:()=>{ const on=MUSIC.toggle(); const mm=$("#m-music"); if(mm)mm.textContent=on?'🎵 Música: on':'🎵 Música: off'; },
  menuStory:()=>{ openIntro(); },
  menuCodex:()=>{ openCodex(); },
  menuRecap:()=>{ openRecap(); },
  menuGuild:()=>{ openGuild(); }, menuTrades:()=>{ openTrades(); },
  openGuild:()=>openGuild(), guildCreate:()=>guildCreate(), guildJoin:(a)=>guildJoin(a),
  guildLeave:()=>guildLeave(), guildLeaveYes:()=>guildLeaveYes(), guildList:()=>guildList(),
  guildTab:(a)=>guildTabSet(a), guildWeeklyClaim:()=>guildWeeklyClaim(), guildPost:()=>guildPost(),
  openTrades:()=>openTrades(), tradeCreateFlow:()=>tradeCreateFlow(), tradeOfferPick:(a)=>tradeOfferPick(a),
  tradeWantPick:(a)=>tradeWantPick(a), tradeAccept:(a)=>tradeAccept(a), tradeCancel:(a)=>tradeCancel(a),
  openCodex:()=>openCodex(),
  openRecap:()=>openRecap(),
  expeditionCollect:()=>expeditionCollect(), expeditionInfo:()=>expeditionInfo(),
  recapNext:()=>recapNext(), recapDone:()=>recapDone(), recapShare:()=>recapShare(),
  introNext:()=>introNext(), introSkip:()=>introSkip(), introFF:()=>introFF(),
  menuLogout:()=>{$("#topmenu").classList.remove("show");logout();},
  dgStart:(a)=>dgStart(a), dgRankTab:(a)=>dgRankTab(a), dgChoose:(a)=>dgChoose(a), dgDraft:(a)=>dgDraft(a), dgSkipDraft:()=>dgSkipDraft(),
  dgBuy:(a)=>dgBuy(a), dgHeal:()=>dgHeal(), dgLeaveShop:()=>dgLeaveShop(), dgFight:()=>dgFight(), dgContinue:()=>dgContinue(),
  goDungeon:()=>go('dungeon')
};
document.getElementById("app").addEventListener("click",e=>{
  MUSIC.start(); // política de autoplay: la música arranca en el primer gesto (idempotente)
  const el=e.target.closest("[data-act]");
  // El menú de la topbar se cierra al tocar fuera de él.
  const menu=$("#topmenu");
  if(menu&&menu.classList.contains("show")&&!e.target.closest("#topmenu")&&(!el||el.dataset.act!=="menuToggle")) menu.classList.remove("show");
  if(!el) return;
  SFX.play('click');
  const fn=ACTIONS[el.dataset.act]; if(fn) fn(el.dataset.arg, el);
});

/* ============== CINEMÁTICA DE APERTURA "GÉNESIS" (cold-open) ==============
   Establece el MUNDO antes del tutorial: por qué nacen aigrons cada día (el
   Núcleo roto) y quién es el Oráculo. Texto con efecto máquina de escribir,
   reveals por etapas y la música arrancando. Se ve una vez (primer login) y se
   puede REVER desde el menú ≡ → "Historia". Da alma a la colección. */
const LORE_INTRO=[
  {g:'🌑', h:`Hace mil ciclos, el <b>Núcleo</b> que soñaba el mundo se hizo añicos.`},
  {g:'✦',  h:`Cada fragmento atrapó una <span class="mag">idea viva</span>: una criatura imposible que aún no existía.`},
  {g:'🌅', h:`Por eso, <b>cada amanecer</b>, el cielo se quiebra y nace un <b>lote nuevo</b> de <b>aigrons</b>… el mismo para todo el que sueña.`},
  {g:'👁️', h:`El <span class="gold">Oráculo</span> los ve antes que nadie, y susurra profecías de lo que vendrá mañana.`},
  {g:'⚔️', h:`Reúnelos. Combate. Complétalos <b>antes de que el día se los lleve</b>.`},
  {g:'🥚', h:`Tu primer fragmento ya late. <b>¿Le das forma?</b>`},
];
let introI=0, introSkipType=null, introTyped=false;
// Máquina de escribir consciente de etiquetas: emite el HTML entero pero revela
// el TEXTO carácter a carácter (las etiquetas <b>… se mantienen intactas).
function typeLine(el, html, done){
  const tokens=html.match(/<[^>]+>|[^<]+/g)||[]; let out='', ti=0, ci=0, t=null, fin=false;
  const cur='<span class="intro-cursor">&nbsp;</span>';
  function finish(){ if(fin)return; fin=true; if(t)clearTimeout(t); el.innerHTML=html+cur; if(done)done(); }
  function step(){
    if(ti>=tokens.length){ finish(); return; }
    const tk=tokens[ti];
    if(tk[0]==='<'){ out+=tk; ti++; return step(); }
    const ch=tk[ci++]; out+=ch; if(ci>=tk.length){ ti++; ci=0; }
    el.innerHTML=out+cur;
    t=setTimeout(step, /[.,;…!?]/.test(ch)?150:24);
  }
  step();
  return finish; // llamarla completa la línea de golpe (fast-forward)
}
function showIntro(i){
  introI=i||0; introTyped=false;
  let host=$("#intro");
  if(!host){ host=document.createElement("div"); host.className="intro"; host.id="intro"; document.getElementById("app").appendChild(host); }
  const s=LORE_INTRO[introI], last=introI===LORE_INTRO.length-1;
  const dots=LORE_INTRO.map((_,k)=>`<span class="intro-dot ${k===introI?'on':''}"></span>`).join("");
  host.innerHTML=`
    <button class="intro-skip" data-act="introSkip">Saltar ✕</button>
    <div class="intro-glyph">${s.g}</div>
    <div class="intro-line" id="intro-line" data-act="introFF"></div>
    <div class="intro-dots">${dots}</div>
    <div class="intro-actions">
      <button class="btn ${last?'gold':'mag'}" id="intro-next" data-act="introNext"
        style="opacity:.3;pointer-events:none;max-width:260px">${last?'DAR FORMA ▸':'CONTINUAR ▸'}</button>
    </div>`;
  MUSIC.start();
  introSkipType=typeLine($("#intro-line"), s.h, ()=>{ introTyped=true;
    const b=$("#intro-next"); if(b){ b.style.opacity='1'; b.style.pointerEvents='auto'; } });
}
// Tocar el texto: si aún se está escribiendo, complétalo; si ya, avanza.
function introFF(){ if(!introTyped&&introSkipType){ introSkipType(); } else introNext(); }
function introNext(){ if(introI<LORE_INTRO.length-1){ showIntro(introI+1); } else introDone(); }
function introSkip(){ introDone(); }
function introDone(){ introSkipType=null; const h=$("#intro"); if(h)h.remove();
  localStorage.setItem('aigrons_intro','1');
  if(!localStorage.getItem('aigrons_tut')){ localStorage.setItem('aigrons_tut','1'); showTutorial(0); } }
function openIntro(){ $("#topmenu").classList.remove("show"); showIntro(0); }
// Onboarding de primer login: cinemática del mundo → tutorial de mecánicas.
function maybeOnboard(){
  if(!localStorage.getItem('aigrons_intro')){ localStorage.setItem('aigrons_intro','1'); showIntro(0); }
  else if(!localStorage.getItem('aigrons_tut')){ localStorage.setItem('aigrons_tut','1'); showTutorial(0); }
}

/* ===================== CÓDICE DEL MUNDO (lore + bestiario) =====================
   La mitología del Núcleo (continúa la cinemática "Génesis") se revela según
   descubres aigrons: cada hito desbloquea un fragmento. Da profundidad al mundo
   y un motivo extra para completar la colección. Se abre desde el menú ≡ y el
   álbum. Cómputo 100% en cliente desde S.collection (sin servidor). */
const CODEX=[
  {at:1,  t:'I · El Núcleo',        x:'Todo empezó con una luz que pensaba. El <b>Núcleo</b> soñó montañas, mares y bestias… hasta que se soñó a sí mismo roto.'},
  {at:3,  t:'II · La Lluvia',       x:'Al estallar, sus esquirlas cayeron como lluvia sobre el mundo dormido. Donde tocaban, algo imposible despertaba.'},
  {at:6,  t:'III · Los Aspectos',   x:'Cada esquirla guardaba un humor del Núcleo: furia, calma, hambre, ingenio. De ahí nacieron los <b>tipos</b> que hoy enfrentas.'},
  {at:10, t:'IV · El Amanecer',     x:'Ningún aigrón vive más de un ciclo. Al alba, el cielo se quiebra y nace un lote nuevo. Por eso coleccionas: para que no se pierdan.'},
  {at:15, t:'V · El Oráculo',       x:'Hay quien ve los fragmentos antes de caer. El <b>Oráculo</b> no miente, pero habla en acertijos: su profecía de mañana siempre se cumple.'},
  {at:20, t:'VI · Los Vínculos',    x:'Dos esquirlas afines pueden <b>fundirse</b> en una tercera, más rara. El Núcleo intenta, una y otra vez, recomponerse a través de ti.'},
  {at:28, t:'VII · Las Prismáticas',x:'Una de cada cien cae girando y se tiñe de todos los colores a la vez. No son más fuertes: son el recuerdo intacto del Núcleo entero.'},
  {at:38, t:'VIII · La Mazmorra',   x:'Bajo el mundo, las esquirlas que nadie reclamó se amontonan y se vuelven hostiles. Descender es enfrentar lo que el día olvidó.'},
  {at:50, t:'IX · El Jefe Mundial', x:'A veces una esquirla colosal se niega a morir al alba. Solo la comunidad entera, golpeando a la vez, la devuelve al sueño.'},
  {at:65, t:'X · La Áurea',         x:'Cuentan que existe una esquirla dorada, una entre cuatrocientas, que late con la voz original del Núcleo. Quien la halla, oye el mundo soñar.'},
  {at:90, t:'XI · El Coleccionista',x:'Y al final, una verdad incómoda: el Núcleo no se recompone con piezas, sino con alguien que las recuerde todas. Ese alguien eres tú.'},
];
function tplKey(t){ return t&&(t.template_id||t.id); }
function discoveredSet(){ const s=new Set(); (S.collection||[]).forEach(i=>{ const k=tplKey(i.template)||i.template_id; if(k)s.add(k); }); return s; }
function openCodex(){
  $("#topmenu").classList.remove("show");
  const ids=discoveredSet(), n=ids.size;
  const frags=CODEX.map(f=>{
    if(n>=f.at) return `<div class="codex-frag unlocked"><div class="cf-t">Fragmento ${esc(f.t)}</div><div class="cf-x">${f.x}</div></div>`;
    return `<div class="codex-frag locked"><div class="cf-t">🔒 Fragmento sellado</div>
      <div class="cf-lock">Descubre <b>${f.at}</b> aigrons para revelarlo <span class="dim">(llevas ${n})</span>.</div></div>`;
  }).join('');
  // Mini-bestiario: especies DISTINTAS descubiertas por rareza.
  const byR={COMUN:0,RARA:0,EPICA:0,LEGENDARIA:0}, seen=new Set();
  (S.collection||[]).forEach(i=>{ const t=i.template; if(!t)return; const k=tplKey(t)||i.template_id; if(!k||seen.has(k))return; seen.add(k);
    if(byR[t.rarity]!=null)byR[t.rarity]++; });
  const rarRow=Object.keys(byR).map(k=>`<div class="codex-stat"><span class="rar-txt ${k}">${k}</span><b>${byR[k]}</b></div>`).join('');
  const unlocked=CODEX.filter(f=>n>=f.at).length;
  const story=ENGINE.seasonStory&&ENGINE.seasonStory();
  const storyBanner=story?`<div class="season-chapter"><div class="sc-h">Este mes · Capítulo ${story.chapter} · <b>${esc(story.title)}</b></div><div class="sc-x">${esc(story.text)}</div></div>`:'';
  openOverlay(`<div class="album-modal">
    <div class="mrow" style="margin-bottom:6px"><b style="font-size:16px;color:var(--cyan)">📜 Códice del mundo</b><span class="dim">${unlocked}/${CODEX.length}</span></div>
    ${storyBanner}
    <div class="dim" style="font-size:12px;margin-bottom:10px">La historia del <b>Núcleo</b> se revela según descubres aigrons. Conoces <b style="color:var(--cyan)">${n}</b> especie${n===1?'':'s'}.</div>
    ${frags}
    <div class="panel" style="margin-top:10px"><b style="font-size:13px">Bestiario — especies descubiertas</b>${rarRow}</div>
    <button class="btn ghost mt8" data-act="close">CERRAR</button>
  </div>`);
}

/* ===================== RECAP MENSUAL "WRAPPED" (compartible) =====================
   Secuencia de tarjetas animadas con TU mes: descubrimientos, tu joya del mes,
   combates y un resumen para compartir (PNG). Viralidad emocional cuando el álbum
   está por rotar. Datos de /recap; se abre desde el menú ≡ y un aviso en Inicio. */
/* ===================== EXPEDICIÓN idle (progreso pasivo) ===================== */
function expeditionHomeCard(exp){
  if(!exp||!exp.rate) return '';
  // Guarda el estado para que el botín "suba en vivo" cada segundo (feel idle).
  S.exp={ rate:exp.rate, capHours:exp.capHours, atMs:new Date(exp.fullAt).getTime()-exp.capHours*3600000 };
  const team=(S.team||[]).map(instById).filter(Boolean).slice(0,3);
  const sprites=team.length
    ? team.map(i=>`<div class="exp-spr">${artTag(i.template,5)}</div>`).join('')
    : '<div class="dim" style="font-size:11px;align-self:center">Forma un equipo para explorar más rápido</div>';
  const p=exp.pending||{coins:0,dust:0};
  const ready=p.coins>0||p.dust>0;
  return `<div class="panel exp-card ${exp.full?'exp-ready':''}">
    <div class="row" style="justify-content:space-between;align-items:center">
      <b style="font-size:14px">⛺ Expedición <button class="exp-q" data-act="expeditionInfo" title="¿Qué es?">?</button></b>
      <span class="dim" style="font-size:11px">${exp.rate.coins}🪙 + ${exp.rate.dust}✨ /h</span></div>
    <div class="exp-team">${sprites}</div>
    <div class="exp-status" id="exp-status">${exp.full?'🟢 ¡Equipo listo para volver!':'⛏ Explorando…'}</div>
    <div class="mis-bar" style="margin-top:6px"><i id="exp-bar" style="width:${exp.pct}%${exp.full?';background:var(--gold)':''}"></i></div>
    <div class="row mt8" style="justify-content:space-between;align-items:center">
      <span style="font-size:14px">Botín: <b style="color:var(--gold)" id="exp-coins">${p.coins}</b>🪙 <b style="color:#bfe3ff" id="exp-dust">${p.dust}</b>✨ <b style="color:var(--epi)" id="exp-tok">${p.tokens||0}</b>🎟️</span>
      <button class="btn sm ${ready?'gold pulse':''}" id="exp-collect" style="width:auto;flex:0 0 auto" data-act="expeditionCollect" ${ready?'':'disabled'}>RECOGER</button></div>
    <div class="dim" style="font-size:10px;margin-top:6px" id="exp-full">${exp.full?'Al máximo — recoge para seguir acumulando':('Se llena en '+fmtHMS(new Date(exp.fullAt)-Date.now()))}</div>
  </div>`;
}
// Botín que sube EN VIVO (mismo cálculo que el servidor): da sensación idle real.
function expeditionNavDot(full){ const b=document.querySelector('.nav button[data-screen="home"]'); if(b)b.classList.toggle('nav-dot',!!full); }
function tickExpedition(){
  const e=S.exp; if(!e) return;
  const capMs=e.capHours*3600000, since=Math.max(0,Date.now()-e.atMs);
  const full=since>=capMs;
  expeditionNavDot(full); // aviso "listo" en la pestaña Inicio (desde CUALQUIER pantalla)
  const el=$("#exp-coins"); if(!el) return; // resto: solo si la tarjeta está visible
  const hours=Math.min(e.capHours, since/3600000);
  const coins=Math.floor(e.rate.coins*hours), dust=Math.floor(e.rate.dust*hours);
  const tokens=Math.floor((e.rate.tokensPerHour||0)*hours);
  const pct=Math.min(100,Math.round(since/capMs*100)), ready=coins>0||dust>0||tokens>0;
  el.textContent=coins; const d=$("#exp-dust"); if(d)d.textContent=dust; const tk=$("#exp-tok"); if(tk)tk.textContent=tokens;
  const bar=$("#exp-bar"); if(bar){ bar.style.width=pct+'%'; bar.style.background=full?'var(--gold)':'var(--cyan)'; }
  const btn=$("#exp-collect"); if(btn){ btn.disabled=!ready; btn.classList.toggle('gold',ready); btn.classList.toggle('pulse',ready); }
  const st=$("#exp-status"); if(st)st.textContent=full?'🟢 ¡Equipo listo para volver!':'⛏ Explorando…';
  const fu=$("#exp-full"); if(fu)fu.textContent=full?'Al máximo — recoge para seguir acumulando':('Se llena en '+fmtHMS(e.atMs+capMs-Date.now()));
  const card=document.querySelector('.exp-card'); if(card)card.classList.toggle('exp-ready',full);
}
// Explicación de la expedición (botón "?" y auto la primera vez).
function expeditionInfo(){
  localStorage.setItem('aigrons_exp_seen','1');
  openOverlay(`<div class="center">
    <div style="font-size:48px">⛺</div>
    <div style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin:6px 0 10px">LA EXPEDICIÓN</div>
    <div style="font-size:14px;line-height:1.55;text-align:left;margin-bottom:12px">
      Tu equipo <b>explora solo, aunque cierres el juego</b>, y va juntando <b>monedas</b> 🪙 y <b>polvo</b> ✨.<br><br>
      • Cuanto <b>más fuerte tu equipo</b> (nivel, evolución), <b>más rinde</b>.<br>
      • Se acumula hasta un <b>tope</b> y luego se para: <b>vuelve cada pocas horas</b> a tocar <b>RECOGER</b>.<br>
      • Es progreso pasivo: te ayuda a subir tu colección, pero <b>nunca</b> da ventaja en el PvP (eso se gana jugando).
    </div>
    <button class="btn" data-act="close">¡ENTENDIDO!</button></div>`);
}
// Intro automática UNA vez para quien ya pasó el tutorial (jugadores existentes).
let _expIntroShown=false;
function maybeExpeditionIntro(exp){
  if(_expIntroShown||!exp) return;
  if(localStorage.getItem('aigrons_exp_seen')||!localStorage.getItem('aigrons_tut')) return;
  _expIntroShown=true;
  setTimeout(()=>{ if(!$("#overlay").classList.contains('show')) expeditionInfo(); },800);
}
async function expeditionCollect(){
  try{
    const r=await api('/expedition/collect',{method:'POST'});
    if(r.user){ S.user=Object.assign(S.user,r.user); refreshChips(); }
    const tok=r.collected.tokens||0;
    if(r.nothing||(r.collected.coins<=0&&r.collected.dust<=0&&tok<=0)){ toast('Aún no hay nada que recoger'); renderHome(); return; }
    SFX.play('claim'); buzz([30,40,30,40,80]); if(window.POC&&window.POC.confetti)window.POC.confetti();
    openOverlay(`<div class="center reveal" style="position:relative"><div class="rays"></div>
      <div style="position:relative;z-index:2">
        <div style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin-bottom:8px">⛺ MIENTRAS NO ESTABAS</div>
        <div style="font-size:46px">🎁</div>
        <div style="font-size:14px;margin:8px 0">Tu equipo volvió de la expedición${r.hours?` (${r.hours}h)`:''} con:</div>
        <div style="font-size:20px;font-weight:700;margin-bottom:8px"><span style="color:var(--gold)">+${r.collected.coins}</span> 🪙 &nbsp; <span style="color:#bfe3ff">+${r.collected.dust}</span> ✨</div>
        ${tok>0?`<div style="font-size:15px;color:var(--epi);font-weight:700;margin-bottom:10px">+${tok} 🎟️ ficha${tok>1?'s':''} de álbum <span class="dim" style="font-size:11px;font-weight:400">(canjéalas en el Álbum)</span></div>`:''}
        <button class="btn" data-act="goHome">¡GENIAL!</button>
      </div></div>`);
  }catch(e){ toast('No se pudo recoger'); }
}

// Aviso en INICIO los últimos días del mes (cuando el álbum está por cambiar).
function recapHomeCard(){
  const now=new Date(), end=new Date(now.getFullYear(),now.getMonth()+1,0,23,59,59);
  const daysLeft=Math.max(0,Math.ceil((end-now)/86400000));
  if(daysLeft>5) return '';
  return `<div class="recap-cta" data-act="openRecap">
    <span class="rc-ic">✨</span>
    <div style="flex:1"><b>Tu resumen del mes</b><div class="dim" style="font-size:12px">El álbum cambia en ${daysLeft} día${daysLeft===1?'':'s'}. Mira (y comparte) tu mes.</div></div>
    <span style="font-size:18px;color:var(--gold)">▸</span></div>`;
}
let RECAP=null, recapI=0;
async function openRecap(){
  $("#topmenu").classList.remove("show");
  openOverlay(`<div class="center"><div class="spinner" style="margin:14px auto"></div><div class="dim">Preparando tu resumen…</div></div>`);
  let d; try{ d=await api('/recap'); }catch(e){ toast('No se pudo cargar el resumen'); closeOverlay(); return; }
  closeOverlay(); RECAP=d; recapI=0; MUSIC.start(); recapScenes(); recapRender();
}
let RECAP_S=[];
function recapScenes(){
  const d=RECAP;
  const pct=d.albumTotal?Math.round(d.albumOwned/d.albumTotal*100):0;
  const persona=d.topType?d.topType.type:null;
  RECAP_S=[];
  RECAP_S.push({g:'✨', html:`<div class="recap-big">Tu mes</div><div class="recap-label">en AIGRONS · <b style="color:var(--cyan)">${esc(d.season.label)}</b></div><div class="recap-sub">Toca para ver tu resumen.</div>`});
  RECAP_S.push({g:'🥚', html:`<div class="recap-big">+${d.newThisMonth}</div><div class="recap-label">aigrons cazados este mes</div><div class="recap-sub">Tu colección ya reúne <b>${d.collection}</b> criaturas.</div>`});
  RECAP_S.push({g:'📖', html:`<div class="recap-big">${d.albumOwned}/${d.albumTotal}</div><div class="recap-label">del álbum de ${esc(d.season.label)}</div>
    <div class="recap-bars"><div class="recap-bar"><span class="rb-l">Álbum</span><span class="rb-t"><i style="width:${pct}%;background:linear-gradient(90deg,var(--cyan),var(--magenta))"></i></span><span class="rb-v">${pct}%</span></div></div>
    <div class="recap-sub">${d.complete?'¡Completo! Eres leyenda.':`Conoces <b>${d.discovered}</b> especies en total.`}</div>`});
  if(persona) RECAP_S.push({g:'🧬', html:`<div class="recap-sub" style="margin:0 0 6px">Tu aspecto dominante del Núcleo</div><div class="recap-big" style="color:var(--cyan)">${esc(persona)}</div><div class="recap-label">${d.topType.count} especies de este tipo</div>`});
  if(d.top){ registerTpl(d.top);
    RECAP_S.push({g:'💎', html:`<div class="recap-sub" style="margin:0 0 8px">Tu joya del mes</div>
      <div class="recap-spr"><canvas data-aig="${d.top.id}" data-px="9"></canvas></div>
      <div class="recap-big" style="font-size:24px;color:var(--gold)">${esc(d.top.name)}</div>
      <div class="recap-label"><span class="rar-txt ${d.top.rarity}">${d.top.rarity}</span> · Nv.${d.top.level}</div>`}); }
  RECAP_S.push({g:'⚔️', html:`<div class="recap-big">${d.wins}</div><div class="recap-label">victorias en combate</div>
    <div class="recap-sub">Mejor racha diaria: <b style="color:var(--gold)">${d.bestStreak}</b> días · Liga <b>${esc(d.bestLeague||d.league)}</b></div>`});
  // Tarjeta final: resumen + compartir.
  RECAP_S.push({g:'🏁', final:true, html:`<div class="recap-big" style="font-size:26px">¡Buen mes!</div>
    <div class="recap-bars" style="max-width:260px">
      <div class="codex-stat"><span class="dim">Cazados este mes</span><b>+${d.newThisMonth}</b></div>
      <div class="codex-stat"><span class="dim">Álbum</span><b>${d.albumOwned}/${d.albumTotal}</b></div>
      <div class="codex-stat"><span class="dim">Especies conocidas</span><b>${d.discovered}</b></div>
      <div class="codex-stat"><span class="dim">Victorias</span><b>${d.wins}</b></div>
      <div class="codex-stat"><span class="dim">Mejor racha</span><b>${d.bestStreak}d</b></div>
    </div>
    <div class="recap-sub">Comparte tu mes y reta a quien quieras.</div>`});
}
function recapRender(){
  let host=$("#recap");
  if(!host){ host=document.createElement("div"); host.className="intro recap"; host.id="recap"; document.getElementById("app").appendChild(host); }
  const s=RECAP_S[recapI], last=recapI===RECAP_S.length-1;
  const dots=RECAP_S.map((_,k)=>`<span class="intro-dot ${k===recapI?'on':''}"></span>`).join("");
  host.innerHTML=`
    <button class="intro-skip" data-act="recapDone">Cerrar ✕</button>
    <div class="intro-glyph">${s.g}</div>
    <div style="display:flex;flex-direction:column;align-items:center;min-height:200px;justify-content:center" data-act="${last?'recapDone':'recapNext'}">${s.html}</div>
    <div class="intro-dots">${dots}</div>
    <div class="intro-actions">
      ${s.final?`<button class="btn gold" data-act="recapShare" style="max-width:170px">📤 COMPARTIR</button>
                 <button class="btn ghost" data-act="recapDone" style="max-width:120px">CERRAR</button>`
               :`<button class="btn mag" data-act="recapNext" style="max-width:260px">SIGUIENTE ▸</button>`}
    </div>`;
  renderCanvases(host);
}
function recapNext(){ if(recapI<RECAP_S.length-1){ recapI++; recapRender(); } else recapDone(); }
function recapDone(){ const h=$("#recap"); if(h)h.remove(); RECAP=null; }
// Imagen para compartir: portada con tu joya del mes + cifras clave.
async function recapShare(){
  const d=RECAP; if(!d)return;
  const c=document.createElement('canvas'); c.width=480; c.height=600;
  const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#0a0818'; g.fillRect(0,0,480,600);
  const bg=await loadUiArt('/art/ui/share-bg.png'); if(bg)g.drawImage(bg,0,0,480,600);
  g.strokeStyle='#3a3270'; g.lineWidth=6; if(!bg)g.strokeRect(10,10,460,580);
  g.textAlign='center';
  g.fillStyle='#34f5e4'; g.font='bold 26px monospace'; g.fillText('MI MES EN AIGRONS',240,50);
  g.fillStyle='#aaa2dc'; g.font='18px monospace'; g.fillText(d.season.label,240,78);
  if(d.top){ const t=tpl(d.top.id)||d.top; const sc=document.createElement('canvas'); drawAigron(sc,t,7);
    g.drawImage(sc,(480-280)/2,96,280,280);
    g.fillStyle='#e8e4ff'; g.font='bold 24px monospace'; g.fillText(t.name||'',240,402);
    g.fillStyle=RARITY_COLOR[t.rarity]||'#8b86b8'; g.font='bold 16px monospace'; g.fillText('Mi joya del mes · '+t.rarity,240,428); }
  const stats=[['Cazados este mes','+'+d.newThisMonth],['Album',d.albumOwned+'/'+d.albumTotal],
    ['Especies',String(d.discovered)],['Victorias',String(d.wins)],['Mejor racha',d.bestStreak+'d']];
  g.font='18px monospace'; let y=470;
  stats.forEach(([l,v])=>{ g.textAlign='left'; g.fillStyle='#aaa2dc'; g.fillText(l,70,y);
    g.textAlign='right'; g.fillStyle='#ffd23f'; g.fillText(v,410,y); y+=26; });
  g.textAlign='center'; g.fillStyle='#aaa2dc'; g.font='15px monospace'; g.fillText('aigrons.app',240,592);
  c.toBlob(async(b)=>{
    if(!b){toast('No se pudo crear la imagen');return;}
    const file=new File([b],'mi-mes-aigrons.png',{type:'image/png'});
    try{ if(navigator.canShare&&navigator.canShare({files:[file]})){
      await navigator.share({files:[file],title:'Mi mes en AIGRONS',text:`Mi mes en AIGRONS (${d.season.label}): +${d.newThisMonth} aigrons, ${d.wins} victorias 🥚 #AIGRONS`}); return; }
    }catch(e){ if(e&&e.name==='AbortError')return; }
    const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=file.name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),5000); toast('Imagen guardada 📸');
  });
}

/* ===================== CONSTELACIONES (gremios, #1) =====================
   Pestaña del nav (#s-guild) con sub-pestañas internas: Miembros / Misión / Muro.
   Sin constelación, la pantalla muestra crear + explorar. */
let guildTab='miembros', GUILD=null;
function openGuild(){ go('guild'); }            // compat: el menú ≡ y CTAs llevan a la pestaña
function tAgo(at){ const s=Math.max(0,(Date.now()-new Date(at).getTime())/1000);
  if(s<60)return 'ahora'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
async function renderGuildScreen(){
  const sc=$("#s-guild");
  sc.innerHTML=`<h2 class="title">🌌 CONSTELACIÓN</h2><div class="dim tc" style="padding:20px"><div class="spinner" style="margin:0 auto 10px"></div>Cargando…</div>`;
  let g; try{ g=await api('/guild'); }catch(e){ sc.innerHTML=`<h2 class="title">🌌 CONSTELACIÓN</h2><div class="panel dim">No disponible.</div>`; return; }
  GUILD=g;
  if(!g.guild){ renderGuildBrowse(); return; }
  const G=g.guild;
  const tab=(k,l)=>`<div class="t ${guildTab===k?'on':''}" data-act="guildTab" data-arg="${k}">${l}</div>`;
  sc.innerHTML=`<h2 class="title">🌌 CONSTELACIÓN</h2>
    <div class="panel glow-cyan"><div class="center">
      <div style="font-family:var(--pixel);font-size:13px;color:var(--cyan)">${esc(G.name)} <span style="color:var(--gold)">[${esc(G.tag)}]</span></div>
      <div class="dim" style="font-size:12px;margin-top:5px">Rango <b style="color:var(--gold)">#${G.rank||'—'}</b> · Poder <b style="color:var(--cyan)">${G.power}</b> · ${G.memberCount}/${G.max} miembros</div></div></div>
    <div class="tabs">${tab('miembros','Miembros')}${tab('mision','Misión')}${tab('muro','Muro')}</div>
    <div id="guild-body"></div>`;
  renderGuildTab();
}
function guildTabSet(t){ guildTab=t;
  $("#s-guild").querySelectorAll('.tabs .t').forEach(el=>el.classList.toggle('on', el.dataset.arg===t));
  renderGuildTab(); }
async function renderGuildTab(){
  const body=$("#guild-body"), g=GUILD; if(!body||!g||!g.guild)return;
  if(guildTab==='miembros'){
    body.innerHTML=`<div class="panel" style="padding:6px 8px">${g.members.map(m=>`<div class="rank-row ${m.me?'me':''}">
        <span class="pos">${m.owner?'👑':''}</span><span class="nm">${esc(m.name)}</span>
        <span class="dim" style="font-size:11px">${esc(m.league)}</span><span style="color:var(--cyan)">${m.leaguePoints}</span></div>`).join('')}</div>
      <button class="btn ghost cyan mt8" data-act="guildList">RANKING DE CONSTELACIONES</button>
      <button class="btn ghost mt8" data-act="guildLeave">${g.isOwner?'SALIR (cedo el liderazgo)':'SALIR'}</button>`;
  } else if(guildTab==='mision'){
    body.innerHTML=`<div class="dim tc" style="padding:10px">Cargando misión…</div>`;
    let w; try{ w=await api('/guild/weekly'); }catch(e){ body.innerHTML='<div class="panel dim">No disponible</div>'; return; }
    const pct=Math.min(100,Math.round(w.progress/w.goal*100));
    body.innerHTML=`<div class="panel">
      <b style="font-size:14px">Misión semanal de la constelación</b>
      <div class="dim" style="font-size:12px;margin:6px 0">${esc(w.label)}</div>
      <div class="mis-bar"><i style="width:${pct}%${w.done?';background:var(--green)':''}"></i></div>
      <div class="mrow" style="margin-top:8px"><span class="dim">${w.progress}/${w.goal} victorias · ${w.members} miembros</span>
        ${w.done?(w.claimed?'<span style="color:var(--green)">✔ Reclamada</span>':`<button class="btn sm gold pulse" style="width:auto" data-act="guildWeeklyClaim">+${w.reward.coins}🪙 +${w.reward.dust}✨</button>`):'<span class="dim">en progreso</span>'}</div>
      <div class="dim" style="font-size:11px;margin-top:10px">Suma las victorias PvP de <b>toda la constelación</b> esta semana. Cada miembro reclama su recompensa al alcanzar el objetivo. Se reinicia el lunes.</div></div>`;
  } else {
    body.innerHTML=`<div class="dim tc" style="padding:10px">Cargando muro…</div>`;
    let d; try{ d=await api('/guild/wall'); }catch(e){ body.innerHTML='<div class="panel dim">No disponible</div>'; return; }
    const msgs=d.messages.map(m=>`<div class="gmsg ${m.me?'me':''}"><div class="gm-h"><b>${esc(m.name)}</b> <span class="dim" style="font-size:10px">${tAgo(m.at)}</span></div><div class="gm-b">${esc(m.body)}</div></div>`).join('')||'<div class="dim tc" style="padding:10px">Sé el primero en escribir.</div>';
    body.innerHTML=`<div class="row mb8"><input id="gw-input" class="tinput" maxlength="200" placeholder="Escribe al muro…" style="flex:1"><button class="btn sm" style="width:auto" data-act="guildPost">ENVIAR</button></div>
      <div class="panel" style="padding:8px;max-height:52vh;overflow-y:auto">${msgs}</div>`;
    const inp=$("#gw-input"); if(inp) inp.addEventListener('keydown',e=>{ if(e.key==='Enter')guildPost(); });
  }
}
async function renderGuildBrowse(){
  const sc=$("#s-guild");
  let d; try{ d=await api('/guild/list'); }catch(e){ d={rows:[],cost:200,max:20}; }
  const rows=d.rows.map(x=>`<div class="rank-row">
    <span class="pos">${x.pos}</span><span class="nm">${esc(x.name)} <span style="color:var(--gold)">[${esc(x.tag)}]</span></span>
    <span class="dim" style="font-size:11px">${x.members}/${d.max}</span><span style="color:var(--cyan);width:46px;text-align:right">${x.power}</span>
    <button class="btn sm" style="width:auto;padding:3px 8px" data-act="guildJoin" data-arg="${x.id}" ${x.full?'disabled':''}>UNIRME</button></div>`).join('')||'<div class="dim tc" style="padding:14px">Sé el primero en fundar una.</div>';
  sc.innerHTML=`<h2 class="title">🌌 CONSTELACIÓN</h2>
    <div class="panel"><div class="center mb8"><b>Forma o únete a una constelación</b>
      <div class="dim" style="font-size:12px;margin-top:4px">Competid en el ranking, completad misiones semanales juntos y charlad en el muro.</div></div>
      <div class="row"><input id="g-name" class="tinput" maxlength="20" placeholder="Nombre" style="flex:1">
        <input id="g-tag" class="tinput" maxlength="4" placeholder="TAG" style="width:68px">
        <button class="btn sm" style="width:auto" data-act="guildCreate">FUNDAR ${d.cost}🪙</button></div></div>
    <b style="font-size:13px">Constelaciones top</b>
    <div class="panel" style="padding:6px 8px;margin-top:6px">${rows}</div>`;
}
async function guildCreate(){
  const name=(($("#g-name")||{}).value||'').trim(), tag=(($("#g-tag")||{}).value||'').trim();
  if(name.length<3){toast('Nombre de 3 a 20 caracteres');return;}
  if(tag.length<2){toast('TAG de 2 a 4 letras/números');return;}
  try{ const r=await api('/guild/create',{method:'POST',body:{name,tag}});
    if(r.user){S.user=Object.assign(S.user,r.user);refreshChips();} SFX.play('claim'); toast('🌌 ¡Constelación fundada!'); guildTab='miembros'; renderGuildScreen(); }
  catch(e){ const er=e.data&&e.data.error;
    toast(er==='name_taken'?'Ese nombre ya existe':er==='insufficient'?'Te faltan monedas':er==='bad_tag'?'TAG 2-4 letras/números':er==='bad_name'?'Nombre 3-20 caracteres':er==='already_in_guild'?'Ya estás en una':'No se pudo'); }
}
async function guildJoin(id){
  try{ await api('/guild/join',{method:'POST',body:{id}}); SFX.play('claim'); toast('¡Te uniste!'); guildTab='miembros'; renderGuildScreen(); }
  catch(e){ const er=e.data&&e.data.error; toast(er==='full'?'Constelación llena':er==='already_in_guild'?'Ya estás en una':'No se pudo'); }
}
function guildLeave(){ openOverlay(`<div class="center">
  <div class="mb8" style="font-size:14px">¿Salir de tu constelación?</div>
  <button class="btn mag mb8" data-act="guildLeaveYes">SÍ, SALIR</button>
  <button class="btn ghost" data-act="close">CANCELAR</button></div>`); }
async function guildLeaveYes(){ try{ await api('/guild/leave',{method:'POST'}); closeOverlay(); toast('Has salido'); renderGuildScreen(); }catch(e){ toast('No se pudo'); } }
async function guildWeeklyClaim(){
  try{ const r=await api('/guild/weekly/claim',{method:'POST'}); if(r.user){S.user=Object.assign(S.user,r.user);refreshChips();}
    SFX.play('claim'); if(window.POC&&window.POC.confetti)window.POC.confetti(); toast(`+${r.reward.coins}🪙 +${r.reward.dust}✨`); renderGuildTab(); }
  catch(e){ toast('Aún no completada'); }
}
async function guildPost(){
  const el=$("#gw-input"); const body=((el&&el.value)||'').trim(); if(!body)return;
  try{ await api('/guild/wall',{method:'POST',body:{body}}); if(el)el.value=''; renderGuildTab(); }
  catch(e){ const er=e.data&&e.data.error; toast(er==='too_fast'?'Espera un momento…':'No se pudo'); }
}
// Ranking de constelaciones (overlay de solo lectura).
async function guildList(){
  let d; try{ d=await api('/guild/list'); }catch(e){ toast('No disponible'); return; }
  const rows=d.rows.map(x=>`<div class="rank-row"><span class="pos">${x.pos}</span>
    <span class="nm">${esc(x.name)} <span style="color:var(--gold)">[${esc(x.tag)}]</span></span>
    <span class="dim" style="font-size:11px">${x.members}/${d.max}</span><span style="color:var(--cyan)">${x.power}</span></div>`).join('')||'<div class="dim tc" style="padding:14px">Aún no hay constelaciones.</div>';
  openOverlay(`<div class="album-modal"><div class="center mb8"><b style="color:var(--cyan)">🌌 RANKING DE CONSTELACIONES</b></div>
    <div class="panel" style="padding:6px 8px">${rows}</div><button class="btn ghost mt8" data-act="close">CERRAR</button></div>`);
}

/* ============================ TRUEQUE (#2) ============================ */
function regTradeTpl(o){ return registerTpl({ id:o.tpl, name:o.name, rarity:o.rarity, art_seed:o.art_seed,
  type:o.type, types:o.type2?[o.type,o.type2]:(o.type?[o.type]:undefined), image_url:o.image_url }); }
async function openTrades(){
  $("#topmenu").classList.remove("show");
  openOverlay(`<div class="center"><div class="spinner" style="margin:14px auto"></div><div class="dim">Cargando mercado…</div></div>`);
  let d; try{ d=await api('/trades'); }catch(e){ toast('No disponible'); closeOverlay(); return; }
  S._trades=d; renderTrades(d);
}
function tradeMini(o){ regTradeTpl(o.offer); regTradeTpl(o.want);
  return `<div class="trade-row">
    <div class="trade-side"><div class="trade-spr">${artTag(tpl(o.offer.tpl),5)}</div><span class="alb-name">${esc(o.offer.name)}</span></div>
    <span class="trade-arrow">⇄</span>
    <div class="trade-side"><div class="trade-spr">${artTag(tpl(o.want.tpl),5)}</div><span class="alb-name dim">${esc(o.want.name)}</span></div></div>`; }
function renderTrades(d){
  const market=d.market.map(o=>`<div class="panel" style="padding:8px">${tradeMini(o)}
    <div class="dim" style="font-size:11px;margin-top:4px">de ${esc(o.fromName)}</div>
    ${o.canFulfill?`<button class="btn sm mt8" data-act="tradeAccept" data-arg="${o.id}">ACEPTAR · doy un ${esc(o.want.name)}</button>`
      :`<div class="dim" style="font-size:11px;margin-top:6px">Necesitas un duplicado de <b>${esc(o.want.name)}</b></div>`}
    </div>`).join('')||'<div class="dim tc" style="padding:12px">No hay ofertas ahora. ¡Crea la tuya!</div>';
  const mine=d.mine.map(o=>`<div class="panel" style="padding:8px">${tradeMini(o)}
    <button class="btn sm ghost mt8" data-act="tradeCancel" data-arg="${o.id}">CANCELAR</button></div>`).join('')||'<div class="dim tc" style="padding:8px;font-size:12px">No tienes ofertas activas.</div>';
  openOverlay(`<div class="album-modal">
    <div class="center mb8"><div style="font-family:var(--pixel);font-size:12px;color:var(--cyan)">🔄 TRUEQUE</div>
      <div class="dim" style="font-size:12px;margin-top:4px">Cambia <b>duplicados</b> para completar tu álbum.</div></div>
    <button class="btn mag mb8" data-act="tradeCreateFlow">+ CREAR OFERTA</button>
    <b style="font-size:13px">El mercado</b>${market}
    <div style="border-top:1px solid var(--line);margin:10px 0"></div>
    <b style="font-size:13px">Mis ofertas</b>${mine}
    <button class="btn ghost mt8" data-act="close">CERRAR</button>
  </div>`);
  renderCanvases($("#overlay"));
}
let tradeDraft={offerInst:null};
function tradeCreateFlow(){
  const byTpl={}; (S.collection||[]).forEach(i=>{ const k=i.template.id; (byTpl[k]=byTpl[k]||[]).push(i); });
  const dups=Object.values(byTpl).filter(arr=>arr.length>=2).map(arr=>arr.find(i=>!i.locked)).filter(Boolean);
  if(!dups.length){ toast('No tienes duplicados para ofrecer'); return; }
  const cells=dups.map(i=>`<div class="card r-${i.template.rarity}" data-act="tradeOfferPick" data-arg="${i.instance_id}">${artTag(i.template,6)}<div class="nm">${esc(i.template.name)}</div></div>`).join('');
  openOverlay(`<div class="album-modal"><div class="center mb8"><b>1/2 · ¿Qué duplicado ofreces?</b></div>
    <div class="grid">${cells}</div><button class="btn ghost mt8" data-act="openTrades">CANCELAR</button></div>`);
  renderCanvases($("#overlay"));
}
async function tradeOfferPick(iid){
  tradeDraft.offerInst=iid;
  let s=S.season; if(!s){ try{ s=await api('/season'); S.season=s; }catch(e){} }
  const missing=(s&&s.entries||[]).filter(e=>!e.owned);
  if(!missing.length){ toast('¡Ya tienes el álbum completo!'); return; }
  const cells=missing.map(e=>{ registerTpl({id:e.id, rarity:e.rarity, art_seed:e.art_seed});
    return `<div class="card r-${e.rarity}" data-act="tradeWantPick" data-arg="${e.id}"><canvas data-sil="${e.id}" data-px="6"></canvas><div class="nm dim">???</div></div>`; }).join('');
  openOverlay(`<div class="album-modal"><div class="center mb8"><b>2/2 · ¿Qué te falta?</b>
    <div class="dim" style="font-size:11px">Pide una criatura del álbum que aún no tienes</div></div>
    <div class="grid">${cells}</div><button class="btn ghost mt8" data-act="tradeCreateFlow">ATRÁS</button></div>`);
  renderCanvases($("#overlay"));
}
async function tradeWantPick(tplId){
  try{ await api('/trades/create',{method:'POST',body:{offerInst:tradeDraft.offerInst, wantTpl:tplId}});
    SFX.play('claim'); toast('✅ Oferta publicada'); openTrades(); }
  catch(e){ const er=e.data&&e.data.error;
    toast(er==='not_duplicate'?'Debe ser un duplicado':er==='already_offered'?'Esa instancia ya está ofrecida':er==='too_many'?'Máx 5 ofertas abiertas':er==='locked'?'Está protegida (favorito)':'No se pudo'); }
}
async function tradeAccept(offerId){
  const d=S._trades; const o=d&&d.market.find(x=>x.id===offerId); if(!o){ openTrades(); return; }
  const mine=(S.collection||[]).filter(i=>i.template.id===o.want.tpl&&!i.locked);
  if(mine.length<2){ toast('Necesitas un duplicado de '+o.want.name); return; }
  try{ await api('/trades/accept',{method:'POST',body:{id:offerId, payInst:mine[0].instance_id}});
    SFX.play('claim'); buzz([40,40,80]); await refreshCollection();
    toast('🔄 ¡Trueque hecho! Recibiste '+o.offer.name); openTrades(); }
  catch(e){ const er=e.data&&e.data.error;
    toast(er==='not_open'?'La oferta ya se cerró':er==='pay_not_duplicate'?'Necesitas un duplicado':er==='offer_gone'?'La oferta ya no existe':'No se pudo'); }
}
async function tradeCancel(id){ try{ await api('/trades/cancel',{method:'POST',body:{id}}); toast('Oferta cancelada'); openTrades(); }catch(e){ toast('No se pudo'); } }

/* ====================== TUTORIAL (primer login) ====================== */
const TUTORIAL=[
  {ic:'🥚', t:'Bienvenido a AIGRONS', h:`Cada mes hay un <b>álbum nuevo</b> de criaturas únicas. <b>Reclama una gratis cada día</b>, combate para ganar más, y compite en el <b>ranking diario</b> — el mismo destacado para todos, así que es justo.`},
  {ic:'🎁', t:'Tu aigrón diario', h:`En <b>Inicio</b>, toca <b>ABRIR — GRATIS</b> una vez al día: sale una criatura del <b>álbum del mes</b>. Entra cada día para subir tu <b>racha</b> y <b>completar el álbum</b> antes de que cambie de mes.`},
  {ic:'📖', t:'Colección', h:`Toca un aigrón para <b>subir de nivel</b>, marcarlo <b>favorito</b>, <b>fusionar</b> dos en uno nuevo, o <b>liberar</b> duplicados a cambio de polvo. Algunos <b>🧬 EVOLUCIONAN</b> al alcanzar cierto nivel (¡y dan un gran salto de poder!).`},
  {ic:'🛡️', t:'Tu equipo', h:`En <b>Combate → EDITAR</b> elige <b>3 aigrons</b>. Los <b>tipos</b> mandan: cada uno es fuerte contra unos y débil contra otros (piedra-papel-tijera).`},
  {ic:'🎯', t:'Combate · preparación', h:`Antes de luchar eliges:<br>• <b>Capitán</b>: +15% a sus stats y +6% a todo el equipo.<br>• <b>Estancia</b>: ⚔️ Agresiva (+ATK, −DEF), 🛡️ Defensiva (+DEF, +1⚡ inicial) o ⚖️ Neutral.<br>Cada combate gasta <b>1⚡</b> (se recarga sola con el tiempo).`},
  {ic:'🕹️', t:'Combate · tu turno', h:`El 3v3 es <b>automático</b> (actúa primero quien tiene más velocidad). Tú decides cada turno:<br>• Toca una <b>habilidad</b> cuando su ⚡ esté cargada → luego toca un <b>enemigo</b> para apuntar (mira <span style="color:var(--green)">⬆</span> fuerte / <span style="color:var(--red)">⬇</span> débil por tipo).<br>• <b>🛡 Guardia</b>: esa criatura protege al equipo un turno (−40% daño recibido).<br>• <b>Sobrecarga ⚡⚡</b>: si te sobra energía, el golpe pega ×1.5.`},
  {ic:'⛺', t:'Expedición (mientras no juegas)', h:`En <b>Inicio</b>, tu equipo <b>explora solo aunque cierres el juego</b> y va juntando <b>monedas</b> 🪙 y <b>polvo</b> ✨. Cuanto <b>más fuerte</b> tu equipo, más rinde. Se llena hasta un <b>tope</b>: <b>vuelve cada pocas horas</b> y toca <b>RECOGER</b>. ¡Es progreso gratis!`},
  {ic:'🏆', t:'¡A jugar!', h:`Gana combates para subir de <b>liga</b> y escalar el <b>ranking diario</b>. La tienda acelera tu colección pero <b>nunca</b> compra victorias. ¡Vuelve mañana por las criaturas nuevas!`},
];
let tutI=0;
function showTutorial(i){ tutI=i||0; tutRender(); }
function tutRender(){
  const s=TUTORIAL[tutI], last=tutI===TUTORIAL.length-1, first=tutI===0;
  const dots=TUTORIAL.map((_,k)=>`<span class="tut-dot ${k===tutI?'on':''}"></span>`).join("");
  openOverlay(`<div class="center">
    <div style="font-size:46px;margin-bottom:4px">${s.ic}</div>
    <div style="font-family:var(--pixel);font-size:12px;color:var(--cyan);margin-bottom:10px">${s.t}</div>
    <div style="font-size:14px;line-height:1.55;text-align:left;margin-bottom:12px">${s.h}</div>
    <div class="tut-dots mb8">${dots}</div>
    <div class="row">
      ${first?'<button class="btn sm ghost" style="flex:1" data-act="tutDone">SALTAR</button>'
             :'<button class="btn sm ghost" style="flex:1" data-act="tutPrev">ATRÁS</button>'}
      <button class="btn sm ${last?'gold':'mag'}" style="flex:1" data-act="${last?'tutDone':'tutNext'}">${last?'¡EMPEZAR!':'SIGUIENTE'}</button>
    </div></div>`);
}
function tutNext(){ if(tutI<TUTORIAL.length-1){tutI++;tutRender();} else tutDone(); }
function tutPrev(){ if(tutI>0){tutI--;tutRender();} }
function tutDone(){ localStorage.setItem('aigrons_tut','1'); localStorage.setItem('aigrons_exp_seen','1'); closeOverlay(); }
function openTutorial(){ showTutorial(0); }

/* ---------------- Arranque ---------------- */
function bootMsg(msg,retry){ $("#boot-msg").textContent=msg; $("#boot-spin").style.display=retry?'none':'block'; $("#boot-retry").style.display=retry?'inline-block':'none'; }
function hideBoot(){ $("#boot").classList.add("hide"); }
function showBoot(){ $("#boot").classList.remove("hide"); }
function showLoadingSec(loading){ const l=$("#boot-loading"),g=$("#boot-login"); if(l)l.style.display=loading?'block':'none'; if(g)g.style.display=loading?'none':'block'; }
function loginErr(msg){ const e=$("#login-err"); if(e)e.textContent=msg||''; }
function gisReady(){ return new Promise(res=>{ let n=0; const t=setInterval(()=>{ if(window.google&&google.accounts&&google.accounts.id){clearInterval(t);res(true);} else if(++n>50){clearInterval(t);res(false);} },100); }); }
// Pantalla de login (obligatoria). Google si está configurado; invitado solo en dev.
async function showLogin(){
  showBoot(); showLoadingSec(false); loginErr('');
  let cfg; try{ cfg=await api('/auth/config'); }catch(e){ loginErr('No se pudo conectar con el servidor.'); showLoadingSec(true); bootMsg('Sin conexión.',true); return; }
  if(cfg.features) Object.assign(FEATURES,cfg.features);
  const devBox=$("#login-dev"); devBox.innerHTML='';
  if(cfg.allowDev){ devBox.innerHTML=(cfg.googleClientId?'<div class="dim" style="font-size:11px;margin:8px 0">ó</div>':'')+'<button class="btn sm ghost" id="devbtn" style="width:100%">👤 Entrar como invitado</button>'; $("#devbtn").onclick=devLogin; }
  const gbtn=$("#gbtn"); gbtn.innerHTML='';
  if(cfg.googleClientId){
    const ok=await gisReady();
    if(ok){
      google.accounts.id.initialize({ client_id:cfg.googleClientId, callback:onGoogleCredential });
      google.accounts.id.renderButton(gbtn,{ theme:'filled_black', size:'large', shape:'pill', text:'continue_with', width:260 });
    } else { gbtn.innerHTML='<div class="dim" style="font-size:12px">No se pudo cargar Google Sign-In.</div>'; }
  } else if(!cfg.allowDev){
    loginErr('Login no configurado (falta AUTH_GOOGLE_CLIENT_ID).');
  }
}
function onGoogleCredential(resp){
  if(!resp||!resp.credential){ loginErr('Inicio de sesión cancelado.'); return; }
  loginErr(''); showLoadingSec(true); bootMsg('Entrando…',false);
  api('/auth/login',{method:'POST',body:{provider:'google',idToken:resp.credential}})
    .then(r=>{ TOKEN=r.token; localStorage.setItem('aigrons_token',TOKEN); afterAuth(); })
    .catch(()=>{ showLoadingSec(false); loginErr('No se pudo iniciar sesión con Google.'); });
}
function devLogin(){ showLoadingSec(true); bootMsg('Entrando…',false); login().then(afterAuth).catch(()=>{ showLoadingSec(false); loginErr('No se pudo entrar.'); }); }
async function afterAuth(){
  try{ await refreshMe(); }
  catch(e){ if(e.status===401){ TOKEN=''; localStorage.removeItem('aigrons_token'); return showLogin(); } throw e; }
  await Promise.all([loadFeatures(),refreshDaily(),refreshCollection(),refreshTeam()]);
  hideBoot(); go("home"); maybeOnboard();
}
async function boot(){
  showBoot(); showLoadingSec(true); bootMsg('Conectando…',false);
  if(!TOKEN){ return showLogin(); }
  try{ await afterAuth(); }
  catch(e){ bootMsg('No se pudo conectar con el servidor. Asegúrate de que la API está arrancada.',true); }
}
function logout(){ TOKEN=''; localStorage.removeItem('aigrons_token'); try{ if(window.google&&google.accounts)google.accounts.id.disableAutoSelect(); }catch(e){} S.user=null; CB=null; showLogin(); }
window.__retryBoot=boot;
// Listener en JS (no atributo onclick inline): permite una CSP sin 'unsafe-inline'.
$("#boot-retry").onclick=boot;
// PWA: registra el service worker (instalable en móvil). No bloquea si falla.
if('serviceWorker' in navigator){ window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{})); }
// Refresca energía/estado periódicamente (servidor autoritativo) fuera de combate.
setInterval(()=>{ if(S.user && !(CB&&CB.timer)){ refreshMe().then(refreshChips).catch(()=>{}); } },30000);
boot();
