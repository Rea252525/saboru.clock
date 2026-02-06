
(function(){
  'use strict';
  function boot(){
    // ---------------- Config ----------------
    const UA = navigator.userAgent || '';
    const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const IS_IPAD = /iPad/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // iPadはGPU/CPU負荷が上がりやすいので、デフォルトは軽量モード（見た目はほぼ維持）
    const PERF_MODE = IS_IOS;
    const DPR = PERF_MODE ? 1 : Math.min(window.devicePixelRatio || 1, 2);


    // --- helpers (share build) ---
    function _clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

    function _stretchTargets(targets, cx, cy, sx, sy){
      if (!targets || !targets.length) return;
      for (let i=0; i<targets.length; i++){
        const t = targets[i];
        if (!t) continue;
        t.x = cx + (t.x - cx) * sx;
        t.y = cy + (t.y - cy) * sy;
      }
    }

    // Clipping helper for the blob render
    function _clipRoundedRect(ctx, rect){
      const x = rect.minX, y = rect.minY;
      const w = rect.maxX - rect.minX;
      const h = rect.maxY - rect.minY;
      const r = Math.max(0, rect.r || 0);
      ctx.beginPath();
      if (r > 0 && typeof ctx.roundRect === 'function'){
        ctx.roundRect(x, y, w, h, r);
      } else if (r > 0){
        const rr = Math.min(r, w*0.5, h*0.5);
        ctx.moveTo(x + rr, y);
        ctx.lineTo(x + w - rr, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
        ctx.lineTo(x + w, y + h - rr);
        ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        ctx.lineTo(x + rr, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
        ctx.lineTo(x, y + rr);
        ctx.quadraticCurveTo(x, y, x + rr, y);
        ctx.closePath();
      } else {
        ctx.rect(x, y, w, h);
      }
      ctx.clip();
    }

    let layoutInfo = null;

	    // ---- SLIME renderer params (guided) ----
	    // v0.0.0 の描写前提の定数を復活（未定義エラー回避 & 画質の基準）
	    const DISC_RADIUS = 14;      // smaller radius → sharper edge
	    const BLUR_AMOUNT = 3;       // less blur
	    const THRESH_LEVEL = 0.558;  // higher threshold → crisper

	    // Font
	    const USE_FONT = true;
	    const FONT_FAMILY_PRIMARY = 'InterLocal';
	    const FONT_FAMILY_LOCAL   = 'ClockFontLocal';
	    let FONT_WEIGHT = 700;
	    const LETTER_SPACING = 0.02;
	    let fontSize = 280;

    // Slime / blob buffer budget (pixels).
    // 1920x1080(=2,073,600px) で blobScale が基本 2 になるように設定。
    // resize() 内で blobScale = ceil(sqrt(area / MAX_BLOB_PIXELS)) を使う。
    const MAX_BLOB_PIXELS = PERF_MODE ? 220000 : 540000;
    // Particle allocation (seconds are removed (v0.5.6))
    // Render budgets (skip some particles when drawing the blob to keep it smooth on iPad)
    const RENDER_BUDGET_H = PERF_MODE ? 340 : 1400;
    const RENDER_BUDGET_M = PERF_MODE ? 340 : 1400;
    const RENDER_BUDGET_C = PERF_MODE ? 70  : 90;
    const ENABLE_OUTLINE_PASS = !PERF_MODE;
    const GUIDE_STRIDE_BASE = PERF_MODE ? 8 : 4;

    const HN = 770, MN = 770;
    const CN = 110;          // colon ":" allocation
    const N  = HN + MN + CN; // total
    const IDLE_JITTER = 0.35, SEEK_STRENGTH = 0.085, DAMP = 0.78;
    const DETECT_MIN_INTERVAL_MS = PERF_MODE ? 160 : 110, SEEN_DEBOUNCE_MS = 180;
    const LOST_CONFIRM_STREAK = 2; // 連続「未検知」回数で見失い確定（検出の瞬断を吸収）
    const HIT_CONFIRM_STREAK = 2;  // 連続「検知」回数で見つけた確定（誤検知を弾く）

    // 見失い時の「パキッ」を防ぐためのスムーズ切替（ms）
    // ②-a の最中・後でも、未検知になった瞬間からじわっとサボり(IDLE)へ。
    const LOST_TO_IDLE_MS = 220;

    // ---- Linger-head gag ----
    const LAG_FRACTION_MIN = 0.15, LAG_FRACTION_MAX = 0.25;
    const LAG_LINGER_MIN_MS = 700, LAG_LINGER_MAX_MS = 1100;
    const LAG_WIGGLE = 0.12, CATCHUP_MS = 320, CATCHUP_GAIN = 1.85;
    
    // Subtle life wobble when the clock is being seen (digits displayed)
    const SEEN_WOBBLE = 8.32;       // px amplitude of wobble
    const WOBBLE_BASE_HZ = 0.10;     // base cycles per second
    const WOBBLE_JITTER_HZ = 16.24;   // per-particle frequency variation

    
// ---------------- ENTER (登場) ----------------
// 顔認識したら、①-aスクスト or ②-aスクスト+一部おくれ がランダムで発生
// 状態は IDLE / ENTER / SHOW のみ

// ①-a（スクスト：v0.0.0 Tier3相当）のイージング（Expoオーバーシュート）
// ※値は v0.0.0 の Tier3 と同じ
const ENTER_OVERSHOOT_TIME_POWER = 1.0;
const ENTER_OVERSHOOT_BACK = 1.0;
const ENTER_OVERSHOOT_PEAK_FRAC = 0.4;
const ENTER_OVERSHOOT_OUT_EXPO_STEEPNESS = 40.0;
const ENTER_OVERSHOOT_IN_EXPO_STEEPNESS  = 40.0;

// ②-a：遅れてくるパートの開始遅延
const ENTER_DELAY_MS = 1200;   // 顔検知→0.5秒経過後

// Easings (from easings.net)
function easeOutCirc(x){
  x = Math.max(0, Math.min(1, x));
  return Math.sqrt(1 - Math.pow(x - 1, 2));
}
function easeInOutQuad(x){
  x = Math.max(0, Math.min(1, x));
  return x < 0.5 ? 2*x*x : 1 - Math.pow(-2*x + 2, 2)/2;
}
function easeOutQuad(x){
  x = Math.max(0, Math.min(1, x));
  return 1 - (1 - x) * (1 - x);
}
function easeInQuad(x){
  x = Math.max(0, Math.min(1, x));
  return x * x;
}


function easeOutExpoParam(t, steep, timePower){
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      const u = Math.pow(t, timePower);
      return 1 - Math.pow(2, -steep * u);
    }

    function easeInExpoParam(t, steep, timePower){
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      const u = Math.pow(t, timePower);
      // 0→1 に向かってだんだん加速する Expo
      return Math.pow(2, steep * (u - 1));
    }

    // 0→100→頂点→100 のうち、「0→頂点」と「頂点→100」を
    // それぞれ easeOutExpo / easeInExpo でつないだオーバーシュート用イージング。
    function expoOvershootBlendParam(t, overshootAmount, peakFrac, timePower, outSteep, inSteep){
      if (t <= 0) return 0;
      if (t >= 1) return 1;

      // 時間の進み方を少し曲げる
      const tt = Math.pow(t, timePower);
      const peak = 1 + overshootAmount; // 1.0=100 に対して overshootAmount=0.5 なら 150 まで行く

      if (tt <= peakFrac){
        // 0→頂点 までを easeOutExpo で
        const u = tt / peakFrac; // 0〜1
        const e = easeOutExpoParam(u, outSteep, 1.0); // timePower は外側でかけたので 1.0 固定
        return peak * e; // 0→peak
      } else {
        // 頂点→100 までを easeInExpo で
        const u = (tt - peakFrac) / (1 - peakFrac); // 0〜1
        const e = easeInExpoParam(u, inSteep, 1.0);
        // peak から 1.0 へ戻る
        return peak + (1 - peak) * e;
      }
    }

    let sketch = (p)=>{
      // --------------- State ---------------
      let pts = new Array(N).fill(0).map(()=>({x:0,y:0,vx:0,vy:0,tx:0,ty:0, group:0, activeAt:0, ax:0, ay:0, catchUntil:0, sx:0, sy:0, catchStart:0, catchTier:0}));
      let seen = true, prevSeen = true, lastTimeStr = "";
      let frames=0, lastFPS=0, lastFPSTime=performance.now();

      // 見失い時のソフト遷移（0..1の係数で「見られている影響」を残しつつIDLEへ）
      let softLost = null;     // { start:number, dur:number }
      let seenFactor = 1.0;    // 1=見られている, 0=見られていない（ソフト遷移中は中間）

// Phase（ミニマル）
// 状態は IDLE / ENTER / SHOW のみ
let phase = 'IDLE';       // 'IDLE' | 'ENTER' | 'SHOW'
let enterName = '-';      // UI 表示用（1a / 2a）
let enter = null;         // {type,start,end,...}


      // Camera state
      const cam = { enabled:false, preview:false,
                    video: document.getElementById('cam'),
                    wrap: document.getElementById('camWrap'),
                    inner: document.getElementById('camInner'),
                    previewMirror:true,
                    faceBox: document.getElementById('faceBox'),
                    stream:null, detector:null, api:'none', lastSeenAt: 0, lastDetectAt: 0, noFaceStreak: 0, hitStreak: 0,
                    face:{has:false,cx:0.5,cy:0.5,size:0.22,w:0,h:0}, faceAt:0 };

      function hideFaceBox(){
        if (cam.faceBox){ cam.faceBox.style.display = 'none'; }
      }

      // Update face tracking box on the camera preview using actual video DOM rect.
      // This avoids drift caused by layout/padding/aspect differences.
      function updateFaceBoxFromBB(bb, vw, vh){
        if (!cam.faceBox || !cam.video) return;
        if (!cam.preview){ cam.faceBox.style.display = 'none'; cam._faceBoxSmooth = null; return; }
        const inner = cam.inner || cam.video.parentElement;
        if (!inner) return;

        const vr = cam.video.getBoundingClientRect();
        const ir = inner.getBoundingClientRect();
        if (!vr || vr.width < 2 || vr.height < 2) return;

        // Normalize bbox to [0,1] in source video pixels
        let x0 = (bb.originX) / vw;
        let y0 = (bb.originY) / vh;
        let x1 = (bb.originX + bb.width) / vw;
        let y1 = (bb.originY + bb.height) / vh;

        // Clamp
        x0 = Math.max(0, Math.min(1, x0));
        y0 = Math.max(0, Math.min(1, y0));
        x1 = Math.max(0, Math.min(1, x1));
        y1 = Math.max(0, Math.min(1, y1));

        // Mirror X if preview video is mirrored via CSS
        if (cam.previewMirror){
          const nx0 = 1.0 - x1;
          const nx1 = 1.0 - x0;
          x0 = nx0; x1 = nx1;
        }

        // Convert to pixels inside inner (relative coords)
        const baseL = (vr.left - ir.left);
        const baseT = (vr.top  - ir.top);
        const wDisp = vr.width;
        const hDisp = vr.height;

        const leftPx = baseL + x0 * wDisp;
        const topPx  = baseT + y0 * hDisp;
        const wPx    = (x1 - x0) * wDisp;
        const hPx    = (y1 - y0) * hDisp;

        // Square box (use max of w/h) + small margin
        let s = Math.max(wPx, hPx) * 1.08;
        if (!isFinite(s) || s <= 0){
          cam.faceBox.style.display = 'none';
          return;
        }
        s = Math.max(12, s); // minimum visible size

        const cx = leftPx + wPx * 0.5;
        const cy = topPx  + hPx * 0.5;
        let boxL = cx - s * 0.5;
        let boxT = cy - s * 0.5;

        // Clamp inside video rect
        const minL = baseL;
        const minT = baseT;
        const maxL = baseL + wDisp - s;
        const maxT = baseT + hDisp - s;
        boxL = Math.max(minL, Math.min(maxL, boxL));
        boxT = Math.max(minT, Math.min(maxT, boxT));

        // --- Jitter smoothing (low-pass) ---
        // Face detection bbox fluctuates frame-by-frame, especially on iPad Safari.
        // Smooth position/size in *display pixels* to reduce "piku-piku".
        const tNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (!cam._faceBoxSmooth){
          cam._faceBoxSmooth = { l: boxL, t: boxT, s: s, tPrev: tNow, init: true };
        } else {
          const sm = cam._faceBoxSmooth;
          const dt = Math.max(0, tNow - (sm.tPrev || tNow));
          sm.tPrev = tNow;

          const dist = Math.hypot(boxL - sm.l, boxT - sm.t);

          // Dynamic time constants (ms): steadier when still, quicker when moving
          let tauPos  = 120;
          let tauSize = 170;
          if (dist > 24){ tauPos = 80;  tauSize = 120; }
          if (dist > 90){ tauPos = 40;  tauSize = 60;  }

          // If it jumps a lot (re-detect / fast move), snap immediately
          if (dist > 180){
            sm.l = boxL; sm.t = boxT; sm.s = s;
          } else {
            const aPos  = Math.min(0.55, Math.max(0.06, 1 - Math.exp(-dt / tauPos )));
            const aSize = Math.min(0.50, Math.max(0.05, 1 - Math.exp(-dt / tauSize)));

            // Deadband: ignore tiny fluctuations
            const dx = boxL - sm.l;
            const dy = boxT - sm.t;
            const ds = s    - sm.s;
            const EPS = 0.35; // px
            const EPS_S = 0.50; // px
            const tx = (Math.abs(dx) < EPS) ? sm.l : boxL;
            const ty = (Math.abs(dy) < EPS) ? sm.t : boxT;
            const ts = (Math.abs(ds) < EPS_S) ? sm.s : s;

            sm.l += (tx - sm.l) * aPos;
            sm.t += (ty - sm.t) * aPos;
            sm.s += (ts - sm.s) * aSize;
          }

          // Re-clamp with smoothed size
          const s2 = Math.max(12, sm.s);
          const maxL2 = baseL + wDisp - s2;
          const maxT2 = baseT + hDisp - s2;
          sm.l = Math.max(minL, Math.min(maxL2, sm.l));
          sm.t = Math.max(minT, Math.min(maxT2, sm.t));
          sm.s = s2;

          boxL = sm.l;
          boxT = sm.t;
          s    = sm.s;
        }

        // Optional pixel snapping (half-pixel) to reduce shimmer
        const snap = (v)=> Math.round(v * 2) / 2;
        boxL = snap(boxL);
        boxT = snap(boxT);
        s    = snap(s);

        cam.faceBox.style.left = boxL.toFixed(1) + 'px';
        cam.faceBox.style.top  = boxT.toFixed(1) + 'px';
        cam.faceBox.style.width  = s.toFixed(1) + 'px';
        cam.faceBox.style.height = s.toFixed(1) + 'px';
        cam.faceBox.style.display = (cam.faceBoxEnabled ? 'block' : 'none');
      }

      // UI
      const holder = document.getElementById('canvas-holder');
      const btnCam = document.getElementById('btnCam');
      const togglePreview = document.getElementById('togglePreview');
      const toggleFaceBox = document.getElementById('toggleFaceBox');
      const diag = document.getElementById('diag');

      // Fullscreen & UI visibility (for exhibition)
      const uiBox = document.getElementById('ui');
      const btnFS = document.getElementById('btnFS');
      const btnHideUI = document.getElementById('btnHideUI');
      const uiFab = document.getElementById('uiFab');
      const fsHelp = document.getElementById('fsHelp');
      const fsHelpClose = document.getElementById('fsHelpClose');

      // Persist minimal UI state so an accidental reload returns to the exhibition setup.
      // v2.1.1: migrate from v2.1.0 key → v2.1.1 key (read old if new is empty)
      const LS_KEY = 'sabo_sh_state_v0_2_7';
      const LS_KEY_OLD = 'sabo_sh_state_v0_2_6';
      function loadPersistedState(){
        try{
          const raw = localStorage.getItem(LS_KEY);
          if (raw) return JSON.parse(raw);
          const rawOld = localStorage.getItem(LS_KEY_OLD);
          if (rawOld) return JSON.parse(rawOld);
          return null;
        }catch(e){ return null; }
      }
      let _persisted = loadPersistedState();
      let _saveTimer = null;
      function savePersistedStateSoon(){
        if (typeof localStorage === 'undefined') return;
        if (_saveTimer) return;
        _saveTimer = setTimeout(()=>{
          _saveTimer = null;
          try{
            const st = {
              uiVisible: uiBox ? (uiBox.style.display !== 'none') : true,              togglePreview: togglePreview ? !!togglePreview.checked : false,
              toggleFaceBox: toggleFaceBox ? !!toggleFaceBox.checked : false
            };
            localStorage.setItem(LS_KEY, JSON.stringify(st));
          }catch(e){}
        }, 120);
      }

      // Wake Lock (supported browsers only) – helps prevent the display from sleeping.
      let _wakeLock = null;
      async function requestWakeLock(){
        try{
          if (!('wakeLock' in navigator)) return;
          if (_wakeLock) return;
          _wakeLock = await navigator.wakeLock.request('screen');
          if (_wakeLock && _wakeLock.addEventListener){
            _wakeLock.addEventListener('release', ()=>{ _wakeLock = null; });
          }
        }catch(e){}
      }
      document.addEventListener('visibilitychange', ()=>{
        if (document.visibilityState === 'visible') requestWakeLock();
      });

      function setUIVisible(v){
        if (!uiBox) return;
        uiBox.style.display = v ? 'block' : 'none';
        if (uiFab) uiFab.style.display = v ? 'none' : 'block';
        savePersistedStateSoon();
      }
      function showFsHelp(v){
        if (!fsHelp) return;
        fsHelp.style.display = v ? 'block' : 'none';
      }
      async function requestFullscreenSmart(){
        // Try Fullscreen API first (works on some browsers)
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!req){
          showFsHelp(true);
          return;
        }
        try{
          // Some browsers accept an options object, some don't.
          const maybe = req.length >= 1 ? req.call(el, { navigationUI: 'hide' }) : req.call(el);
          if (maybe && typeof maybe.then === 'function') await maybe;
        }catch(e){
          showFsHelp(true);
          return;
        }
      }

      // Apply persisted state now that helper functions exist.
      if (_persisted){        if (togglePreview && typeof _persisted.togglePreview === 'boolean') togglePreview.checked = _persisted.togglePreview;
        if (toggleFaceBox && typeof _persisted.toggleFaceBox === 'boolean') toggleFaceBox.checked = _persisted.toggleFaceBox;
        if (typeof _persisted.uiVisible === 'boolean') setUIVisible(_persisted.uiVisible);
      }

      if (btnHideUI){ btnHideUI.addEventListener('click', ()=> setUIVisible(false)); }
      if (uiFab){ uiFab.addEventListener('click', ()=> setUIVisible(true)); }
      if (btnFS){ btnFS.addEventListener('click', ()=>{ requestWakeLock(); requestFullscreenSmart(); }); }
      if (fsHelpClose){ fsHelpClose.addEventListener('click', ()=> showFsHelp(false)); }
      if (fsHelp){ fsHelp.addEventListener('click', (e)=>{ if (e.target === fsHelp) showFsHelp(false); }); }

      // v2.1.1: camera auto-start + auto-resume (after permission is granted once)
      // Goal: after the first permission grant, the camera should continue automatically on reload/return.
      let _camStartPromise = null;
      const LS_CAM_GRANTED = 'mon_saboru_cam_granted';

      function _isStreamLive(){
        try{
          if (!cam.stream) return false;
          const tracks = (cam.stream.getVideoTracks ? cam.stream.getVideoTracks() : []);
          if (!tracks || tracks.length === 0) return false;
          return tracks.some(t => t && t.readyState === 'live');
        }catch(_e){ return false; }
      }

      function _camWasGranted(){
        try{ return localStorage.getItem(LS_CAM_GRANTED) === '1'; }catch(_e){ return false; }
      }

      async function ensureCameraRunning(reason){
        const AUTO_PROMPT_FIRST_TIME = true;
        if (!AUTO_PROMPT_FIRST_TIME && !_camWasGranted()) return;
        if (_camStartPromise) return _camStartPromise;
        if (cam.enabled && _isStreamLive()) return;
        _camStartPromise = startCamera({ auto:true, reason, force:true })
          .finally(()=>{ _camStartPromise = null; });
        return _camStartPromise;
      }

      // Auto-resume when the page becomes visible again (macOS/Safari/Chrome can pause camera on background)
      window.addEventListener('pageshow', ()=>{ if (document.visibilityState === 'visible') ensureCameraRunning('pageshow'); }, { capture:true });
      document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') ensureCameraRunning('visible'); });

      // Boot: try to resume (after a small delay so layout settles)
      setTimeout(()=>ensureCameraRunning('boot'), 250);



// ENTER②-a parameters (tuning UI was removed for v1.2.x)
const ENTER2A_DELAY_MS = ENTER_DELAY_MS;
const ENTER2A_RATIO = 1.0;     // 0..1 (遅れ対象の割合)
const ENTER2A_CLUSTER = true;  // かたまりで遅らせる

// ---- Soft transition helpers ----
function startSoftLost(now){
  if (!softLost){
    softLost = { start: now, dur: LOST_TO_IDLE_MS };
  }
}

function updateSoftLost(now){
  if (seen){
    softLost = null;
    seenFactor = 1.0;
    return;
  }
  // not seen
  if (phase === 'IDLE'){
    softLost = null;
    seenFactor = 0.0;
    return;
  }
  if (!softLost) softLost = { start: now, dur: LOST_TO_IDLE_MS };
  const u = Math.max(0, Math.min(1, (now - softLost.start) / Math.max(1, softLost.dur)));
  const k = easeOutQuad(u);
  seenFactor = 1.0 - k;
  if (u >= 1){
    // transition finished → fully idle
    clearEnter();
    setPhase('IDLE');
    softLost = null;
    seenFactor = 0.0;
  }
}



// (v1.2.0) debug/test UI removed




      // Keep the camera <video> active even when preview is OFF.
      // Some browsers may pause the stream if the element is display:none.
      function applyPreviewVisibility(){
        if (!cam || !cam.wrap) return;
        if (!cam.enabled){
          cam.wrap.style.display = 'none';
          return;
        }
        // Always keep it in the render tree
        cam.wrap.style.display = 'block';

        if (cam.preview){
          cam.wrap.style.opacity = '1';
          cam.wrap.style.pointerEvents = 'auto';
          cam.wrap.style.borderColor = 'rgba(255,255,255,0.18)';
          cam.wrap.style.background = 'rgba(0,0,0,0.25)';
        } else {
          // Almost invisible, but still rendered (keeps video frames updating)
          cam.wrap.style.opacity = '0.001';
          cam.wrap.style.pointerEvents = 'none';
          cam.wrap.style.borderColor = 'transparent';
          cam.wrap.style.background = 'transparent';
          if (cam.faceBox) cam.faceBox.style.display = 'none';
        }
      }

      // HHMM only (seconds are not displayed)
      function clockString(){
        const d = new Date();
        const pad = n => String(n).padStart(2,'0');
        return pad(d.getHours()) + pad(d.getMinutes());
      }

      // ----- Font-based digits (fill) -----
      function drawFontDigits(g, text, size, cx, cy){
        const ctx = g.drawingContext;
        ctx.save();
        const fam = `'${FONT_FAMILY_LOCAL}', '${FONT_FAMILY_PRIMARY}', sans-serif`;
        ctx.font = `normal ${FONT_WEIGHT} ${size}px ${fam}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        let total = 0;
        for (const ch of text){
          const w = ctx.measureText(ch).width;
          total += w * (1 + LETTER_SPACING);
        }
        let x = cx - total/2;
        for (const ch of text){
          const w = ctx.measureText(ch).width * (1 + LETTER_SPACING);
          ctx.fillText(ch, x, cy);
          x += w;
        }
        ctx.restore();
      }

      function drawVectorDigits(g, text, size, cx, cy){
        g.push(); g.translate(cx, cy);
        g.stroke(255); g.strokeWeight(Math.max(2, size*0.065)); g.noFill();
        if (g.drawingContext){ g.drawingContext.lineJoin='round'; g.drawingContext.lineCap='round'; }
        const w=size*0.62, gap=size*0.18, halfH=size*0.52, halfW=w*0.5;
        function b(){g.beginShape();} function v(x,y){g.vertex(x,y);} function e(){g.endShape();}
        function digitPath(d, ox){
          const hw=halfW, hh=halfH, r=size*0.2; g.push(); g.translate(ox,0);
          switch(d){
            case '0': g.rectMode(g.CENTER); g.rect(0,0,w,size*1.04,r); break;
            case '1': b(); v(-hw*0.2,-hh); v(0,-hh); v(0,hh); e(); break;
            case '2': b(); v(-hw,-hh+2); v(hw,-hh+2); v(hw,0); v(-hw,0); v(-hw,hh); v(hw,hh); e(); break;
            case '3': b(); v(-hw,-hh+2); v(hw,-hh+2); v(hw,0); v(-hw*0.1,0); e(); b(); v(-hw*0.1,0); v(hw,0); v(hw,hh-2); v(-hw,hh-2); e(); break;
            case '4': b(); v(-hw,-hh); v(-hw,0); v(hw,0); e(); b(); v(hw,-hh); v(hw,hh); e(); break;
            case '5': b(); v(hw,-hh+2); v(-hw,-hh+2); v(-hw,0); v(hw,0); v(hw,hh-2); v(-hw,hh-2); e(); break;
            case '6': g.ellipseMode(g.CENTER); g.ellipse(-hw*0.05, hh*0.25, w*1.0, size*0.9); b(); v(hw*0.7,-hh+2); v(-hw,-hh+2); v(-hw,0); v(hw,0); e(); break;
            case '7': b(); v(-hw,-hh+2); v(hw,-hh+2); v(0,hh); e(); break;
            case '8': g.ellipseMode(g.CENTER); g.ellipse(0,-hh*0.38,w*0.9,size*0.70); g.ellipse(0,hh*0.42,w*0.98,size*0.80); break;
            case '9': g.ellipseMode(g.CENTER); g.ellipse(hw*0.05,-hh*0.25,w*1.0,size*0.9); b(); v(-hw,0); v(hw,0); v(hw,hh-2); v(-hw,hh-2); e(); break;
            case ':': g.noStroke(); g.fill(255); g.circle(0,-hh*0.35,size*0.10); g.circle(0,hh*0.35,size*0.10); g.noFill(); g.stroke(255); break;
          } g.pop();
        }
        const digW=size*0.62; const totalW = text.length*(digW+gap)-gap;
        let x=-totalW/2+digW*0.5;
        for (const ch of text){ digitPath(ch,x); x+=digW+gap; }
        g.pop();
      }

      function buildTargetsFor(text, maxCount, xCenter, yCenter){
        // Reuse the same offscreen canvas to prevent GPU/DOM canvas churn.
        const g = ensureSampleBuffer();
        g.clear();
        g.background(0,0);
        (USE_FONT ? drawFontDigits : drawVectorDigits)(g, text, fontSize, g.width/2, yCenter);
        g.loadPixels();
        const d=g.pixelDensity(), W=g.width*d, H=g.height*d;
        let step=Math.max(2, Math.floor(Math.min(p.width,p.height)*0.0035)*d); // denser than v0.8.0
        const arr=[];
        for (let y=0;y<H;y+=step){
          for (let x=0;x<W;x+=step){
            const a=g.pixels[4*(y*W+x)+3];
            if (a>128){ arr.push({x: x/d + (xCenter - g.width/2), y: y/d}); }
          }
        }
        if (arr.length>maxCount){
          const stride=Math.max(1, Math.ceil(arr.length/maxCount));
          const thin=[]; for (let i=0;i<arr.length;i+=stride) thin.push(arr[i]); return thin;
        }
        return arr;
      }

      function buildTargetsForHColon(maxCount, xCenter, yCenter, colonFont){
        const gW = Math.max(10, Math.min(p.width, Math.ceil(colonFont * 2.4)));
        const g = p.createGraphics(gW, p.height);
        g.pixelDensity(1);
        g.clear();
        const dotR = colonFont * 0.14;
        const gap = colonFont * 0.75; // user-chosen spacing
        g.noStroke(); g.fill(255);
        g.circle(gW/2 - gap/2, yCenter, dotR*2);
        g.circle(gW/2 + gap/2, yCenter, dotR*2);
        g.loadPixels();
        const d = 1;
        const W = g.width;
        const H = g.height;
        const step = Math.max(1, Math.floor(colonFont * 0.04));
        const arr=[];
        for (let y=0;y<H;y+=step){
          for (let x=0;x<W;x+=step){
            const a=g.pixels[4*(y*W+x)+3];
            if (a>128){ arr.push({x: x + (xCenter - gW/2), y: y}); }
          }
        }
        // deterministic-ish shuffle
        for (let i=arr.length-1;i>0;i--){
          const j=Math.floor(p.random(i+1));
          const tmp=arr[i]; arr[i]=arr[j]; arr[j]=tmp;
        }
        if (arr.length>maxCount) arr.length=maxCount;
        return arr;
      }

function rebuildTargets(){
        // Responsive layout derived from the *visible* area (viewRect).
        const vw = viewRect.maxX - viewRect.minX;
        const vh = viewRect.maxY - viewRect.minY;
        const cx = (viewRect.minX + viewRect.maxX) * 0.5;
        const cy = (viewRect.minY + viewRect.maxY) * 0.5;
        const ar = vh / Math.max(1, vw);
        const mode = (ar >= 1.18) ? 'tall' : 'wide';

        if (mode === 'wide'){
          const padX = Math.max(24, vw * 0.06);
          const padY = Math.max(24, vh * 0.06);

          let sizeHM = _clamp(Math.min(vh * 0.55, vw * 0.255), 160, 680);
          sizeHM = Math.min(sizeHM, Math.max(120, (vh - padY * 2) * 0.95));

          const digitHalfW = sizeHM * 0.54;
          const dxLimit = Math.max(sizeHM * 0.56, (vw * 0.5) - padX - digitHalfW);
          const dx = Math.min(sizeHM * 0.90, dxLimit); // slightly wider gap (v0.2.6 feedback)

          layoutInfo = {
            mode, cx, cy, viewW: vw, viewH: vh,
            H: { x: cx - dx, y: cy, size: sizeHM },
            M: { x: cx + dx, y: cy, size: sizeHM },
            C: { x: cx, y: cy - sizeHM * 0.06, size: sizeHM * 0.33, style: 'v' }
          };
        } else {
          const sizeHM = _clamp(Math.min(vw * 0.90, vh * 0.26), 140, 540);
          const dy = sizeHM * 0.82;
          layoutInfo = {
            mode, cx, cy, viewW: vw, viewH: vh,
            H: { x: cx, y: cy - dy, size: sizeHM },
            M: { x: cx, y: cy + dy, size: sizeHM },
            C: { x: cx, y: cy, size: sizeHM * 0.24, style: 'h' }
          };
        }

        // Per-group font weights
        const WEIGHT_HM = 700, WEIGHT_COLON = 100;

        const str = clockString();
        lastTimeStr = str;
        const HH = str.slice(0,2);
        const MM = str.slice(2,4);

        let txH = [], txM = [], txColon = [];
        FONT_WEIGHT = WEIGHT_HM;
        fontSize = Math.round(layoutInfo.H.size);
        txH = buildTargetsFor(HH, HN, Math.round(layoutInfo.H.x), Math.round(layoutInfo.H.y));

        FONT_WEIGHT = WEIGHT_HM;
        fontSize = Math.round(layoutInfo.M.size);
        txM = buildTargetsFor(MM, MN, Math.round(layoutInfo.M.x), Math.round(layoutInfo.M.y));

        FONT_WEIGHT = WEIGHT_COLON;
        const colonFont = Math.round(layoutInfo.C.size);
        fontSize = colonFont;
        if (layoutInfo.C.style === 'v'){
          txColon = buildTargetsFor(':', CN, Math.round(layoutInfo.C.x), Math.round(layoutInfo.C.y));
        } else {
          txColon = buildTargetsForHColon(CN, Math.round(layoutInfo.C.x), Math.round(layoutInfo.C.y), colonFont);
        }

        // Portrait/tall requirement: HH & MM slightly vertically stretched.
        if (layoutInfo.mode === 'tall'){
          _stretchTargets(txH, layoutInfo.H.x, layoutInfo.H.y, 1.00, 1.15);
          _stretchTargets(txM, layoutInfo.M.x, layoutInfo.M.y, 1.00, 1.15);
        }

        function assign(start, count, targets){
          const len = Math.max(1, targets.length);
          for (let i=0; i<count; i++){
            const idx = start + i;
            const t = targets[i % len];
            pts[idx].tx = t.x;
            pts[idx].ty = t.y;
          }
        }
        assign(0, HN, txH);
        assign(HN, MN, txM);
        assign(HN + MN, CN, txColon);

        guides = txH.concat(txM, txColon);

        // bounds calc (kept)
        const cx0 = cx;
        const cy0 = cy;
        const xs = [];
        const ys = [];
        for (let i=0; i<guides.length; i++){
          const t = guides[i];
          if (!t) continue;
          xs.push(t.x);
          ys.push(t.y);
        }

        if (xs.length < 8){
          clockBounds = { halfW: 720, halfH: 340 };
        } else {
          xs.sort((a,b)=>a-b);
          ys.sort((a,b)=>a-b);
          const trim = Math.max(0, Math.min(xs.length-1, Math.floor(xs.length * 0.002)));
          const minX = xs[trim];
          const maxX = xs[xs.length - 1 - trim];
          const minY = ys[trim];
          const maxY = ys[ys.length - 1 - trim];
          const EXTRA = Math.ceil(DISC_RADIUS * 0.85 + BLUR_AMOUNT * 0.40 + 2);
          const halfW = Math.max(cx0 - minX, maxX - cx0) + EXTRA;
          const halfH = Math.max(cy0 - minY, maxY - cy0) + EXTRA;
          clockBounds = { halfW, halfH };
        }
      }


// cached guide points
      let guides = [];
// digit layout bounds (for wall collision)
let clockBounds = { halfW: 720, halfH: 340 };

      
function setPhase(nextPhase){
  phase = nextPhase;
}

function clearEnter(){
  enter = null;
  enterName = '-';
  for (let i=0;i<N;i++){
    const a = pts[i];
    a.activeAt = 0;
    a.catchStart = 0;
    a.catchUntil = 0;
    a.catchEase = null;
    // ENTER②-a lag helpers
    a.lagArmed = false;
    a.lagJMul = 1.0;
    a.sx = a.x; a.sy = a.y;
    a.bx = 0; a.by = 0;
  }
}


function startEnterByRule(now){
  // 顔を認識したら、①-a（スクスト） or ②-a（スクスト+一部おくれ）をランダムで発火
  const pool = ['1a','2a'];
  startEnter(pool[Math.floor(Math.random()*pool.length)], now);
}

function startEnter(type, now){
  if (type !== '1a' && type !== '2a') type = '1a';
  // いつでも顔検知 → 見失ったら即サボる（= IDLEへ）は draw 側で強制される
  rebuildTargets();
  clearEnter();

  // ENTER 初期化
  enter = { type, start: now, end: now };
  enterName = type;
  setPhase('ENTER');

  // ①-a / ②-a : スクスト（catch-up easing）
  if (type === '1a' || type === '2a'){
    // 全粒子を「スクスト（オーバーシュート）」で数字へ
    for (let i=0;i<N;i++){
      const a = pts[i];
      a.sx = a.x; a.sy = a.y;
      a.activeAt = now;
      a.catchStart = now;
      a.catchUntil = now + CATCHUP_MS;
      a.catchEase = 'overshoot';
      a.lagArmed = false;
      a.lagJMul = 1.0;
    }
    enter.end = now + CATCHUP_MS;

    if (type === '2a'){
      // チーム(H/:/M)を等確率 → 4分割(ru/lu/ld/rd)を等確率 → その領域だけ遅らせる
      // NOTE: ":" グループは遅れが分かりにくいので、遅れ対象チームから除外（H/Mのみ）
      const teams = ['H','M'];
      const team = teams[Math.floor(Math.random()*teams.length)];
      const quads = ['ru','lu','ld','rd'];
      const quad = quads[Math.floor(Math.random()*quads.length)];

      // 各チームの中心（rebuildTargets内の値と一致させる）
      const center = (team==='H') ? {x:560,y:580} :
                                    {x:1360,y:580};

      const start = (team==='H') ? 0 : HN;
      const count = (team==='H') ? HN : MN;

      // クラスターOFF時に、遅れ粒子を「散った」配置で選ぶ（クラスターとの差を見やすく）
      function pickDispersed(pool, n){
        if (n >= pool.length) return pool.slice();

        let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
        for (let i=0;i<pool.length;i++){
          const a = pts[pool[i]];
          if (a.tx < minx) minx = a.tx;
          if (a.ty < miny) miny = a.ty;
          if (a.tx > maxx) maxx = a.tx;
          if (a.ty > maxy) maxy = a.ty;
        }
        const diag = Math.hypot(maxx-minx, maxy-miny) + 1e-6;

        const picked = [];
        let minD = diag * 0.35; // 最初は広めに散らす

        // 複数パスで minD を緩めながら埋める
        const cand = pool.slice();
        for (let pass=0; pass<5 && picked.length<n; pass++){
          // shuffle
          for (let i=cand.length-1;i>0;i--){
            const j = Math.floor(Math.random()*(i+1));
            const tmp = cand[i]; cand[i] = cand[j]; cand[j] = tmp;
          }
          const minD2 = minD*minD;
          for (let i=0;i<cand.length && picked.length<n;i++){
            const ii = cand[i];
            const a = pts[ii];
            let ok = true;
            for (let j=0;j<picked.length;j++){
              const b = pts[picked[j]];
              const dx = a.tx - b.tx;
              const dy = a.ty - b.ty;
              if (dx*dx + dy*dy < minD2){ ok = false; break; }
            }
            if (ok) picked.push(ii);
          }
          minD *= 0.65; // だんだん緩める
        }

        // 足りない分はランダムで補完（重複なし）
        if (picked.length < n){
          const set = new Set(picked);
          const rest = pool.filter(ii=>!set.has(ii));
          while (picked.length < n && rest.length > 0){
            const k = Math.floor(Math.random()*rest.length);
            picked.push(rest.splice(k,1)[0]);
          }
        }
        return picked;
      }

      // quadrant判定
      function inQuad(tx,ty){
        const right = tx >= center.x;
        const up    = ty <= center.y;
        if (quad==='ru') return right && up;
        if (quad==='lu') return (!right) && up;
        if (quad==='ld') return (!right) && (!up);
        return right && (!up); // rd
      }

      // 遅れ対象（象限内の“まとまり”だけ遅らせる）
      const cand = [];
      for (let k=0;k<count;k++){
        const ii = start + k;
        const a = pts[ii];
        if (!inQuad(a.tx, a.ty)) continue;
        cand.push(ii);
      }

      // fallback: 象限がスカスカならチーム全体から選ぶ
      let poolIdx = cand;
      if (poolIdx.length < 6){
        poolIdx = [];
        for (let k=0;k<count;k++) poolIdx.push(start+k);
      }

      let picked = poolIdx;

      // cluster: 読みやすい“かたまり”で遅らせる（デフォルトON）
      if (ENTER2A_CLUSTER && poolIdx.length > 0){
        const want = Math.max(3, Math.round(poolIdx.length * ENTER2A_RATIO));
        const lagN = Math.max(1, Math.min(want, poolIdx.length));

        // seed: centerから遠いトップ25%からランダムに選ぶ
        const scored = poolIdx.map(ii=>{
          const a = pts[ii];
          const dx = a.tx - center.x;
          const dy = a.ty - center.y;
          return {ii, d2: dx*dx + dy*dy};
        }).sort((u,v)=>v.d2 - u.d2);

        const top = Math.max(1, Math.round(scored.length * 0.25));
        const seed = scored[Math.floor(Math.random()*top)].ii;
        const s = pts[seed];
        const sx = s.tx, sy = s.ty;

        picked = poolIdx.slice().sort((i1,i2)=>{
          const a = pts[i1], b = pts[i2];
          const da = (a.tx - sx)*(a.tx - sx) + (a.ty - sy)*(a.ty - sy);
          const db = (b.tx - sx)*(b.tx - sx) + (b.ty - sy)*(b.ty - sy);
          return da - db;
        }).slice(0, lagN);
      } else {
        // non-cluster: 量スライダーを反映して、象限内で「散った」選び方にする
        if (poolIdx.length > 0){
          const want = Math.max(3, Math.round(poolIdx.length * ENTER2A_RATIO));
          const lagN = Math.max(1, Math.min(want, poolIdx.length));
          picked = pickDispersed(poolIdx, lagN);
        }
      }

      for (let idx=0; idx<picked.length; idx++){
        const a = pts[picked[idx]];

        // delay中は液体のまま → その後 easeOutCirc で集合
        a.activeAt = now + ENTER2A_DELAY_MS;
        // NOTE:
        // 遅れ粒子は delay 中に位置が動くので、
        // 「動いた後の位置」から集合が始まるように draw 側で sx/sy を再設定する。
        a.lagArmed = true;
        a.lagJMul = 2.2;

        // 少しだけ“置いていかれる”方向へ押し出して、遅れが視覚的に分かるようにする
        {
          const dx0 = a.tx - center.x;
          const dy0 = a.ty - center.y;
          const d0 = Math.sqrt(dx0*dx0 + dy0*dy0) + 1e-6;
          const nx0 = dx0 / d0;
          const ny0 = dy0 / d0;
          const sp = 7.0 + Math.random()*7.0;
          a.vx += nx0 * sp + (Math.random()-0.5) * sp * 0.25;
          a.vy += ny0 * sp + (Math.random()-0.5) * sp * 0.25;
        }

        a.catchStart = a.activeAt;
        a.catchUntil = a.catchStart + CATCHUP_MS;
        a.catchEase = 'outCirc';
      }
      enter.end = now + ENTER2A_DELAY_MS + CATCHUP_MS;
    }
    return;
  }
}







      // MediaPipe Face Detector (offline bundle)
      let mpFaceDetector = null;
      let mpInitPromise = null;

      async function initMediaPipeFaceDetector(){
        if (mpFaceDetector) return mpFaceDetector;
        if (mpInitPromise) return mpInitPromise;
        mpInitPromise = (async ()=>{
          updateDiag('診断: MediaPipe 初期化中…');
          // ESM bundle (offline)
          const base = new URL('.', window.location.href);
          const mpUrl = new URL('vendor/mediapipe/vision_bundle.mjs', base).toString();
          const wasmPath = new URL('vendor/mediapipe/wasm', base).toString();
          const modelPath = new URL('vendor/mediapipe/models/blaze_face_short_range.tflite', base).toString();

          const mp = await import(mpUrl);
          const vision = await mp.FilesetResolver.forVisionTasks(wasmPath);
          mpFaceDetector = await mp.FaceDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: modelPath },
            runningMode: 'VIDEO',
            minDetectionConfidence: 0.5,
            minSuppressionThreshold: 0.3
          });
          updateDiag('診断: MediaPipe FaceDetector');
          return mpFaceDetector;
        })().catch(err=>{
          console.error(err);
          updateDiag('診断: MediaPipe初期化失敗（ファイル/サーバ/CSP）');
          mpInitPromise = null;
          mpFaceDetector = null;
          throw err;
        });
        return mpInitPromise;
      }

            async function startCamera(opts){
        opts = opts || {};
        const force = !!opts.force;

        // If already live and not forcing a restart, do nothing
        if (!force && cam.enabled && _isStreamLive()) return;

        try{
          updateDiag('診断: カメラ起動中…');
          // Best-effort: keep the display awake during exhibition
          try{ requestWakeLock(); }catch(_e){}

          // Ensure the preview wrapper stays in the render tree
          if (cam.wrap){
            cam.wrap.style.display = 'block';
            if (!cam.preview) cam.wrap.style.opacity = '0.001';
          }

          // Stop existing stream cleanly
          if (cam.stream){
            try{
              const tracks = cam.stream.getTracks ? cam.stream.getTracks() : [];
              tracks.forEach(t=>{ try{ t.stop(); }catch(_e){} });
            }catch(_e){}
            cam.stream = null;
          }

          const constraints = {video:{facingMode:'user', width:{ideal:480}, height:{ideal:360}, frameRate:{ideal:30, max:30}}, audio:false};
          const stream = await navigator.mediaDevices.getUserMedia(constraints);

          cam.stream = stream;
          cam.video.muted = true;
          cam.video.autoplay = true;
          cam.video.setAttribute('playsinline','');
          cam.video.playsInline = true;
          cam.video.srcObject = stream;

          // Wait metadata so play() is more reliable
          await new Promise(resolve=>{
            if (cam.video.readyState >= 1) return resolve();
            cam.video.onloadedmetadata = ()=> resolve();
          });

          // Some browsers may still require a user gesture for play(); keep stream and ask for a click.
          try{
            await cam.video.play();
          }catch(playErr){
            console.warn(playErr);
            updateDiag('診断: 画面クリックでカメラ開始');
            const resume = async ()=>{
              document.removeEventListener('pointerdown', resume, true);
              document.removeEventListener('mousedown', resume, true);
              document.removeEventListener('touchstart', resume, true);
              try{
                await cam.video.play();
                updateDiag('診断: カメラ起動中…');
              }catch(_e){
                updateDiag('診断: カメラ不可（権限/環境）');
              }
            };
            document.addEventListener('pointerdown', resume, true);
            document.addEventListener('mousedown', resume, true);
            document.addEventListener('touchstart', resume, true);
          }

          cam.enabled = true;
          cam.preview = !!(togglePreview && togglePreview.checked);
          applyPreviewVisibility();

          // Remember: after the first successful start, auto-start on reload/return.
          try{ localStorage.setItem(LS_CAM_GRANTED, '1'); }catch(_e){}

          cam.api='MediaPipe';
          cam.detector=null;
          cam.face = {has:false,cx:0.5,cy:0.5,size:0.22,w:0,h:0};
          cam.faceAt = 0;
          cam.lastSeenAt = 0;
          cam.noFaceStreak = 0;
          cam.hitStreak = 0;

          // Hide face box until a face is detected
          if (cam.faceBox) cam.faceBox.style.display = 'none';

          // Auto-restart if the camera track ends (e.g., background/foreground)
          try{
            const vts = stream.getVideoTracks ? stream.getVideoTracks() : [];
            if (vts && vts[0] && vts[0].addEventListener){
              vts[0].addEventListener('ended', ()=>{
                cam.enabled = false;
                if (document.visibilityState === 'visible') ensureCameraRunning('track-ended');
              });
            }
          }catch(_e){}

          try{
            cam.detector = await initMediaPipeFaceDetector();
            cam.api='MediaPipe';
          }catch(_e){
            cam.detector = null;
            cam.api = 'none';
          }

          // Persist current UI state (best effort)
          savePersistedStateSoon();

        }catch(e){
          console.error(e);
          updateDiag('診断: カメラ不可（権限/環境）');
          // If auto start failed, allow retry by a single click/tap.
          if (opts && opts.auto){
            const retry = ()=>{
              document.removeEventListener('pointerdown', retry, true);
              document.removeEventListener('mousedown', retry, true);
              document.removeEventListener('touchstart', retry, true);
              startCamera({ force:true, auto:false, reason:'tap-retry' });
            };
            document.addEventListener('pointerdown', retry, true);
            document.addEventListener('mousedown', retry, true);
            document.addEventListener('touchstart', retry, true);
          }
        }
      }


      function ensureProcCanvas(){
        if (!cam.procCanvas){
          cam.procCanvas = document.createElement('canvas');
          cam.procCtx = cam.procCanvas.getContext('2d', { alpha:false, desynchronized:true });
        }
      }

      // Detect on a processing canvas that matches the *displayed preview* aspect/size.
      // This avoids iOS Safari coordinate drift between detectForVideo() bbox and DOM preview.
      function detectOnPreviewCanvas(now){
        ensureProcCanvas();

        const vr = cam.video ? cam.video.getBoundingClientRect() : null;
        const dpr = window.devicePixelRatio || 1;
        const MAX_SIDE = 512;

        let cw = 0, ch = 0;

        const hasDisp = vr && isFinite(vr.width) && isFinite(vr.height) && vr.width >= 2 && vr.height >= 2;

        if (hasDisp){
          cw = Math.max(2, Math.round(vr.width  * dpr));
          ch = Math.max(2, Math.round(vr.height * dpr));
        } else {
          // Fallback when preview is hidden: use intrinsic video size
          const vw0 = (cam.video && cam.video.videoWidth)  ? cam.video.videoWidth  : 640;
          const vh0 = (cam.video && cam.video.videoHeight) ? cam.video.videoHeight : 480;
          cw = Math.max(2, Math.round(vw0));
          ch = Math.max(2, Math.round(vh0));
        }

        // Cap to keep it light
        const s = Math.min(1, MAX_SIDE / Math.max(cw, ch));
        cw = Math.max(2, Math.round(cw * s));
        ch = Math.max(2, Math.round(ch * s));

        if (cam.procCanvas.width !== cw || cam.procCanvas.height !== ch){
          cam.procCanvas.width = cw;
          cam.procCanvas.height = ch;
        }

        cam.procCtx.setTransform(1,0,0,1,0,0);
        cam.procCtx.drawImage(cam.video, 0, 0, cw, ch);

	        // NOTE:
	        // FaceDetector is initialized with runningMode:'VIDEO'.
	        // In that mode, using detector.detect() may return nothing or throw.
	        // To keep coordinates consistent with our processing canvas,
	        // call detectForVideo() with the *canvas* as the image source.
	        let res = null;
	        if (cam.detector && typeof cam.detector.detectForVideo === 'function'){
	          res = cam.detector.detectForVideo(cam.procCanvas, now);
	        } else if (cam.detector && typeof cam.detector.detect === 'function'){
	          // Fallback for IMAGE mode
	          res = cam.detector.detect(cam.procCanvas);
	        }
        return { res, vw: cw, vh: ch };
      }

      function runDetection(now){
        if (!cam.enabled) return;
        if (now - (cam.lastDetectAt||0) < DETECT_MIN_INTERVAL_MS) return;
        cam.lastDetectAt = now;

        if (cam.api==='MediaPipe' && cam.detector){
          try{
            const { res, vw, vh } = detectOnPreviewCanvas(now);
            const faces = (res && Array.isArray(res.detections)) ? res.detections : [];
if (faces.length>0){

  // pick largest face
  let best = faces[0];
  for (let i=1;i<faces.length;i++){
    const b = faces[i].boundingBox; const bb = best.boundingBox;
    if (b && bb && (b.width*b.height > bb.width*bb.height)) best = faces[i];
  }

  const bb = best.boundingBox;
  if (bb && vw>1 && vh>1){

    // --- Detect debounce: require consecutive HIT_CONFIRM_STREAK frames ---
    cam.hitStreak = (cam.hitStreak||0) + 1;

    if (cam.hitStreak >= HIT_CONFIRM_STREAK){

      cam.noFaceStreak = 0;
      cam.lastSeenAt = now;

      const cxRaw = (bb.originX + bb.width*0.5) / vw;
      const cyRaw = (bb.originY + bb.height*0.5) / vh;

      // previewは左右反転して表示しているので、操作感を合わせてXを反転
      const cx = 1.0 - cxRaw;
      const cy = cyRaw;

      const wNorm = Math.max(0.00001, bb.width / vw);
      const hNorm = Math.max(0.00001, bb.height / vh);
      const size = Math.max(0.00001, (bb.width * bb.height) / (vw * vh));
      cam.face = {has:true, cx, cy, size, w:wNorm, h:hNorm};
      cam.faceAt = now;

      // Update preview overlay (green square)
      updateFaceBoxFromBB(bb, vw, vh);

    } else {
      // Not confirmed yet (1st hit) -> treat as "not seen"
      cam.noFaceStreak = (cam.noFaceStreak||0) + 1;
      cam.face.has = false;
      if (cam.faceBox) cam.faceBox.style.display = 'none';
      cam._faceBoxSmooth = null;
    }

  } else {
    // invalid bb
    cam.hitStreak = 0;
    cam.noFaceStreak = (cam.noFaceStreak||0) + 1;
    cam.face.has = false;
    if (cam.faceBox) cam.faceBox.style.display = 'none';
    cam._faceBoxSmooth = null;
  }

} else {
  cam.hitStreak = 0;
  cam.noFaceStreak = (cam.noFaceStreak||0) + 1;
  cam.face.has = false;
  if (cam.faceBox) cam.faceBox.style.display = 'none';
  cam._faceBoxSmooth = null;
}
          }catch(_e){
	            // If MediaPipe throws (often due to runningMode mismatch or source type), log it.
	            console.error('[FaceDetect]', _e);
            cam.noFaceStreak = (cam.noFaceStreak||0) + 1;
            cam.face.has = false;
            if (cam.faceBox) cam.faceBox.style.display = 'none';
                cam._faceBoxSmooth = null;
          }
        } else {
          cam.noFaceStreak = (cam.noFaceStreak||0) + 1;
          cam.face.has = false;
          if (cam.faceBox) cam.faceBox.style.display = 'none';
                cam._faceBoxSmooth = null;
        }
      }


      
function drawSlime(){
  if (!gBlob) return;

  // Seen factor (0..1)
  const sfVis = (typeof seenFactor === 'number') ? Math.max(0, Math.min(1, seenFactor)) : (seen ? 1.0 : 0.0);
  const ufVis = 1.0 - sfVis;

  // Stamp radius (in blob buffer space)
  const r = DISC_RADIUS * renderRadiusScale;

  // Alpha/outline (match v1.1.2 defaults)
  const BASE_ALPHA = 22;
  const OUTLINE_SCALE = 1.45;
  const OUTLINE_ALPHA = BASE_ALPHA * 0.35;

  // Colon thickness modulation (":") — only when being seen
  const COLON_THIN_SCALE = 0.28;
  let colonScale = 1.0;
  if (sfVis > 0.0001){
    const d = new Date();
    const base = d.getSeconds() + d.getMilliseconds() / 1000;
    const spd = Math.max(0.01, (typeof renderColonSpeed === 'number' ? renderColonSpeed : 1.0));
    const tt = base * spd;
    const sec = Math.floor(tt);
    const u = tt - sec; // 0..1
    const easeOut = 1 - Math.pow(1 - u, 5); // easeOutQuint
    if ((sec % 2) === 0){
      colonScale = COLON_THIN_SCALE + (1 - COLON_THIN_SCALE) * easeOut;
    } else {
      colonScale = 1 - (1 - COLON_THIN_SCALE) * easeOut;
    }
  }
  // Smoothly stop blinking when not seen
  colonScale = colonScale * sfVis + 1.0 * ufVis;
  const colonR = r * colonScale;

  // Sampling stride (budget-driven)
  const B_H = RENDER_BUDGET_H, B_M = RENDER_BUDGET_M, B_C = RENDER_BUDGET_C;
  const sH = Math.max(1, Math.floor(HN / B_H));
  const sM = Math.max(1, Math.floor(MN / B_M));
  const sC = Math.max(1, Math.floor(CN / B_C));

  // ---- stamp to gBlob
  gBlob.push();
  gBlob.background(0);
  gBlob.blendMode(gBlob.ADD);
  gBlob.noStroke();

  // main pass
  gBlob.fill(255, BASE_ALPHA);
  for (let i=0;i<HN;i+=sH){
    const a = pts[i];
    gBlob.circle(a.x / blobScale, a.y / blobScale, r * 2);
  }
  for (let i=HN;i<HN+MN;i+=sM){
    const a = pts[i];
    gBlob.circle(a.x / blobScale, a.y / blobScale, r * 2);
  }
  for (let i=HN+MN;i<N;i+=sC){
    const a = pts[i];
    gBlob.circle(a.x / blobScale, a.y / blobScale, colonR * 2);
  }

  // outline smoothing pass (H/M only)
  if (ENABLE_OUTLINE_PASS){
    gBlob.fill(255, OUTLINE_ALPHA);
    for (let i=0;i<HN;i+=sH){
      const a = pts[i];
      gBlob.circle(a.x / blobScale, a.y / blobScale, r * OUTLINE_SCALE * 2);
    }
    for (let i=HN;i<HN+MN;i+=sM){
      const a = pts[i];
      gBlob.circle(a.x / blobScale, a.y / blobScale, r * OUTLINE_SCALE * 2);
    }
  }

  // guide points are currently disabled (kept for future debugging)
  if (false && guides && guides.length){
    const gr = Math.max(1, Math.floor(DISC_RADIUS * 0.5));
    const GUIDE_ALPHA = 8;
    const GUIDE_STRIDE = GUIDE_STRIDE_BASE;
    gBlob.fill(255, GUIDE_ALPHA);
    for (let gi=0; gi<guides.length; gi+=GUIDE_STRIDE){
      const t = guides[gi];
      if (!t) continue;
      gBlob.circle(t.x / blobScale, t.y / blobScale, gr * 2);
    }
  }

  gBlob.pop();

  // ---- post filters
  try { gBlob.filter(p.BLUR, Math.max(0.5, Math.min(8.0, BLUR_AMOUNT))); } catch(e){}
  try { gBlob.filter(p.THRESHOLD, THRESH_LEVEL); } catch(e){ try { gBlob.filter(p.THRESHOLD); } catch(e2){} }

  // ---- draw to canvas (clipped)
  p.push();
  const ctx = p.drawingContext;
  ctx.save();
  _clipRoundedRect(ctx, { minX: viewRect.minX, maxX: viewRect.maxX, minY: viewRect.minY, maxY: viewRect.maxY, r: 0 });
  p.tint(renderTint.r, renderTint.g, renderTint.b, renderTint.a);
  p.image(gBlob, 0, 0, p.width, p.height);
  ctx.restore();
  p.pop();
}



      p.draw = function(){
        frames++; const now=performance.now();
        if (now-lastFPSTime>=500){ lastFPS=Math.round(frames*1000/(now-lastFPSTime)); frames=0; lastFPSTime=now; }

        if (cam.enabled) runDetection(now);
        const camSeen = cam.enabled ? ((now-cam.lastSeenAt<=SEEN_DEBOUNCE_MS) && ((cam.noFaceStreak||0) < LOST_CONFIRM_STREAK)) : false;
        const effectiveSeen = cam.enabled ? camSeen : false;
        seen = effectiveSeen;

        // Seen edge handling (IDLE / ENTER / SHOW only)
        if (!prevSeen && seen){
          startEnterByRule(now);
        } else if (prevSeen && !seen){
          startSoftLost(now);
        }
        prevSeen = seen;

        // Update soft transition / seenFactor (and finalize to IDLE when finished)
        updateSoftLost(now);

        p.background(0);
        const nowStr=clockString(); if (seen && nowStr!==lastTimeStr && (phase==='SHOW' || phase==='ENTER')) rebuildTargets();
// ENTER 終了判定
if (seen && phase === 'ENTER' && enter && (now >= enter.end)){
  // 数字の安定状態へ
  enter = null;
  setPhase('SHOW');
}
// NOTE: 見失い時の強制IDLEは updateSoftLost() が担当（スムーズに切り替えるため）



        
// v1.2.3: 演出は①-a/②-aのみ

// v0.10.1: 物理も「見失い時にパキッと」切り替えず、seenFactor(1→0)で滑らかにIDLEへ。
const sfNow = (typeof seenFactor === 'number') ? Math.max(0, Math.min(1, seenFactor)) : (seen ? 1.0 : 0.0);
const ufNow = 1.0 - sfNow;

// Physics step
        for (let i=0;i<N;i++){
          const a = pts[i];
          const active = (sfNow > 0.0001);

          if (active){
            // ②-a の遅れ：activeAt まで「もぞもぞ」、到達したらキャッチアップ開始
            if (now < a.activeAt){
              const jm = (a.lagArmed && a.lagJMul) ? a.lagJMul : 1.0;
              const jmul = jm * sfNow + ufNow;
              a.vx = (a.vx + (Math.random()-0.5) * IDLE_JITTER * jmul) * 0.98;
              a.vy = (a.vy + (Math.random()-0.5) * IDLE_JITTER * jmul) * 0.98;
            } else {
              if (a.lagArmed){
                a.lagArmed = false;
                a.lagJMul = 1.0;
                a.sx = a.x; a.sy = a.y;
                a.catchStart = now;
                a.catchUntil = now + CATCHUP_MS;
                // 遅れは outCirc で合流
                a.catchEase = 'outCirc';
              }

              // wobble（SHOWのみ）
              const t = now * 0.001;
              const wobbleAmp = (phase === 'SHOW') ? (SEEN_WOBBLE * sfNow) : 0.0;

              // ばらつき周波数
              const h = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
              const frac = h - Math.floor(h);
              const j = (frac - 0.5) * 2.0;

              const fx = (WOBBLE_BASE_HZ + j * WOBBLE_JITTER_HZ * 0.15);
              const fy = (WOBBLE_BASE_HZ * 1.3 + j * WOBBLE_JITTER_HZ * 0.11);

              // base target
              let targetX = a.tx;
              let targetY = a.ty;

              // catch-up interpolation（ENTER）
              if (now < a.catchUntil && a.catchStart){
                // ①-a / ②-a：catch-up easing（スクスト）
                const catchDur = CATCHUP_MS;
                const tNorm = Math.max(0, Math.min(1, (now - a.catchStart) / catchDur));

                let prog = tNorm;
                if (a.catchEase === 'overshoot'){
                  prog = expoOvershootBlendParam(
                    tNorm,
                    ENTER_OVERSHOOT_BACK,
                    ENTER_OVERSHOOT_PEAK_FRAC,
                    ENTER_OVERSHOOT_TIME_POWER,
                    ENTER_OVERSHOOT_OUT_EXPO_STEEPNESS,
                    ENTER_OVERSHOOT_IN_EXPO_STEEPNESS
                  );
                } else if (a.catchEase === 'outCirc'){
                  prog = easeOutCirc(tNorm);
                } else if (a.catchEase === 'outExpo'){
                  prog = easeOutExpoParam(tNorm, 10.0, 1.0);
                }

                const sx0 = (typeof a.sx === 'number') ? a.sx : a.x;
                const sy0 = (typeof a.sy === 'number') ? a.sy : a.y;
                targetX = sx0 + (a.tx - sx0) * prog;
                targetY = sy0 + (a.ty - sy0) * prog;
              }

              const wobbleX = Math.sin(t * fx + i * 0.37) * wobbleAmp;
              const wobbleY = Math.cos(t * fy + i * 0.41) * wobbleAmp;

              const dx = (targetX + wobbleX) - a.x;
              const dy = (targetY + wobbleY) - a.y;

              const dampBlend = 0.98 + (DAMP - 0.98) * sfNow;

              // 未視認の揺らぎも少し混ぜる
              const jx = (Math.random()-0.5) * IDLE_JITTER * ufNow;
              const jy = (Math.random()-0.5) * IDLE_JITTER * ufNow;

              a.vx = (a.vx + dx * SEEK_STRENGTH * sfNow + jx) * dampBlend;
              a.vy = (a.vy + dy * SEEK_STRENGTH * sfNow + jy) * dampBlend;
            }
          } else {
            a.vx = (a.vx + (Math.random()-0.5) * IDLE_JITTER) * 0.98;
            a.vy = (a.vy + (Math.random()-0.5) * IDLE_JITTER) * 0.98;
          }

          a.x += a.vx;
          a.y += a.vy;

          // keep inside canvas
          if (a.x < 0){ a.x = 0; a.vx *= -0.5; }
          else if (a.x > p.width){ a.x = p.width; a.vx *= -0.5; }

          if (a.y < 0){ a.y = 0; a.vy *= -0.5; }
          else if (a.y > p.height){ a.y = p.height; a.vy *= -0.5; }
        }

// SLIME rendering
        drawSlime();


      };

      window.addEventListener('resize', ()=>{ resize(); applyFitScale(); });
    };
    new p5(sketch);
  }
  if (document.readyState==='loading'){ window.addEventListener('DOMContentLoaded', boot); } else { boot(); }
})();
