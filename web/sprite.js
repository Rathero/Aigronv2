/* =========================================================================
   sprite.js — RENDERER de sprites pixel-art de los aigrons (compartido).
   Fuente ÚNICA del dibujo procedural: lo usan la APP (web/app.js) y la
   LANDING (landing/landing.js), para que una criatura se vea EXACTAMENTE
   igual en las dos. Determinista desde {art_seed|id, type, rarity}.
   Requiere engine.js cargado antes (mulberry32/hashStr).
   ========================================================================= */
(function (root) {
  const E = root.ENGINE;
  const mulberry32 = E.mulberry32, hashStr = E.hashStr;

  /* paletas pixel por tipo: [oscuro, medio, claro, acento] */
  const PAL = {
    VOLCAN:["#5a1500","#c4391a","#ff8a3c","#ffe27a"],
    NIEBLA:["#2a3340","#5d7488","#aebfce","#d7f3ff"],
    CRISTAL:["#0a4d5e","#1fb6c9","#7df0ff","#ffffff"],
    RELOJ:["#4a2e0a","#a9741f","#ffcf5e","#fff2c0"],
    VACIO:["#1b0a33","#5b1f96","#a45cff","#ff8af0"],
    BESTIA:["#3a2412","#7a4a23","#c79a5e","#ffe6b0"],
    PLANTA:["#0d3d1a","#2c8f3a","#79e06a","#e6ffba"],
    TORMENTA:["#0a2150","#2552c9","#5fa8ff","#ffe45e"],
    METAL:["#2a2e35","#6b7280","#aeb6c2","#e8edf5"],
    HUESO:["#3a352a","#8a7e63","#cabfa0","#f3ead0"],
    SOMBRA:["#0a0a14","#2a1f3d","#5a3f7a","#9a6fd0"],
    LUMEN:["#5a4a10","#c9a82a","#ffe57a","#fffbe0"],
    HIELO:["#0a3a4d","#2a9fc9","#9fe8ff","#ffffff"],
    MAREA:["#06283d","#1f6fb6","#4fb0ff","#bfe9ff"],
    ARENA:["#5a4520","#b08a3a","#e6c879","#fff0c0"],
    TOXICO:["#243d0a","#6fa01f","#b6ff3e","#eaff9a"],
    ECO:["#0a2a33","#1f7a96","#5cc4ff","#9af0ff"],
    RUNA:["#0a2a2a","#1f7a7a","#5cc9c9","#9affff"],
    PLUMA:["#3a2a40","#8a6fae","#c7aee0","#f0e6ff"],
    HONGO:["#3a1a2a","#8a3f5a","#c76f8e","#ffb0c0"]
  };

  function spriteSeed(tpl){ return (tpl.art_seed!=null?tpl.art_seed:hashStr(tpl.id||"x"))>>>0; }
  function buildSprite(tpl){
    const N=16, half=8, rng=mulberry32(spriteSeed(tpl)^0x9e3779b9);
    const g=Array.from({length:N},()=>Array(N).fill(0));
    const rowW=[]; let topY=N, botY=0;
    for(let y=0;y<N;y++){
      const profile=Math.sin(Math.PI*(y+0.5)/N);
      let w=Math.round(profile*6 + (rng()*2-1)*1.2);
      if(y<3||y>13) w=Math.max(0,w-1);
      w=Math.max(0,Math.min(7,w));
      rowW[y]=w;
      if(w>0){topY=Math.min(topY,y);botY=Math.max(botY,y);}
    }
    for(let y=0;y<N;y++){
      const w=rowW[y]; if(!w)continue;
      for(let x=8-w;x<=7;x++){
        let v=1;
        if(y<=topY+2 && rng()<0.55) v=2;
        else if(x===8-w && rng()<0.6) v=3;
        else if(rng()<0.12) v=5;
        g[y][x]=v;
      }
    }
    let eyeY=Math.min(botY-2, topY+3);
    if(eyeY<topY) eyeY=topY+1;
    const ex=Math.max(8-rowW[eyeY]+1, 4);
    if(rowW[eyeY]>0 && g[eyeY] && g[eyeY][ex]){ g[eyeY][ex]=7; if(g[eyeY-1]) g[eyeY-1][ex]=6; }
    if((tpl.rarity==="EPICA"||tpl.rarity==="LEGENDARIA") && topY>0){
      const hx=Math.max(8-rowW[topY],3);
      g[topY-1][hx]=8; if(topY-2>=0)g[topY-2][hx]=8;
    }
    for(let y=0;y<N;y++) for(let x=0;x<half;x++) g[y][N-1-x]=g[y][x];
    const out=Array.from({length:N},()=>Array(N).fill(0));
    for(let y=0;y<N;y++)for(let x=0;x<N;x++){
      if(g[y][x]!==0)continue;
      const nb=[[1,0],[-1,0],[0,1],[0,-1]];
      for(const[dx,dy]of nb){const ny=y+dy,nx=x+dx;
        if(ny>=0&&ny<N&&nx>=0&&nx<N&&g[ny][nx]!==0&&g[ny][nx]!==4){out[y][x]=4;break;}}
    }
    for(let y=0;y<N;y++)for(let x=0;x<N;x++) if(out[y][x]===4&&g[y][x]===0) g[y][x]=4;
    if(tpl.rarity==="LEGENDARIA"){for(let k=0;k<4;k++){const sx=Math.floor(rng()*N),sy=Math.floor(rng()*N);if(g[sy][sx]===0)g[sy][sx]=9;}}
    return g;
  }
  function colorFor(v,tpl){
    const p=PAL[tpl.type]||PAL.VACIO;
    switch(v){case 1:return p[1];case 2:return p[2];case 3:return p[0];case 5:return p[3];
      case 6:return "#ffffff";case 7:return "#0c0a1a";case 8:return p[3];
      case 4:return tpl.rarity==="LEGENDARIA"?"#ffd23f":"#08060f";case 9:return "#fff7c8";default:return null;}
  }
  /* Dibujo básico a píxel cuadrado (sin caché/prisma: eso es de la app). */
  function drawTpl(canvas,tpl,px){
    px=px||8; const N=16;
    canvas.width=N*px; canvas.height=N*px;
    const ctx=canvas.getContext("2d"); ctx.imageSmoothingEnabled=false;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const g=buildSprite(tpl);
    for(let y=0;y<N;y++)for(let x=0;x<N;x++){
      const c=colorFor(g[y][x],tpl); if(!c)continue;
      ctx.fillStyle=c; ctx.fillRect(x*px,y*px,px,px);
    }
  }
  /* Silueta (criatura aún no descubierta): la MISMA forma, en un tono plano. */
  function drawSilhouette(canvas,tpl,px,color){
    px=px||6; const N=16;
    canvas.width=N*px; canvas.height=N*px;
    const ctx=canvas.getContext("2d"); ctx.imageSmoothingEnabled=false;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const g=buildSprite(tpl);
    ctx.fillStyle=color||"#15122e";
    for(let y=0;y<N;y++)for(let x=0;x<N;x++){ if(colorFor(g[y][x],tpl)) ctx.fillRect(x*px,y*px,px,px); }
  }

  root.SPRITE = { PAL, spriteSeed, buildSprite, colorFor, drawTpl, drawSilhouette };
})(typeof self !== "undefined" ? self : this);
