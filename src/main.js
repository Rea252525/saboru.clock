
(function(){
  'use strict';

  // Filter benign console messages from MediaPipe/TFLite/Environment.
  // These are not fatal errors, but some browsers highlight them in red which is confusing.
  (function(){
    const DROP_PATTERNS = [
      /Created TensorFlow Lite XNNPACK delegate for CPU/i,
      /inference_feedback_manager\.cc:\d+\].*Feedback manager requires a model/i,
      /SES Removing unpermitted intrinsics/i
    ];
    function shouldDrop(args){
      try{
        const msg = args.map(a => {
          if (typeof a === 'string') return a;
          if (a && typeof a.message === 'string') return a.message;
          try { return JSON.stringify(a); } catch(e){ return String(a); }
        }).join(' ');
        return DROP_PATTERNS.some(rx => rx.test(msg));
      }catch(e){
        return false;
      }
    }
    ['log','info','warn','error'].forEach(level => {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        if (shouldDrop(args)) return;
        orig(...args);
      };
    });
  })();


  // small utility: clamp a number into [min,max]
  function _clamp(v, lo, hi){
    return Math.max(lo, Math.min(hi, v));
  }

  // Clip drawing to a (rounded) rectangle in *canvas coordinates*.
  // Used to ensure we only draw within the visible area (viewRect).
  function _clipRoundedRect(ctx, rect){
    if (!ctx || !rect) return;
    const x = rect.minX || 0;
    const y = rect.minY || 0;
    const w = (rect.maxX || 0) - x;
    const h = (rect.maxY || 0) - y;
    const r0 = Math.max(0, rect.r || 0);

    ctx.beginPath();
    if (w <= 0 || h <= 0){
      // Degenerate; clip nothing.
      ctx.rect(0, 0, 0, 0);
      ctx.clip();
      return;
    }

    const r = Math.min(r0, Math.min(w, h) * 0.5);

    // Modern browsers: CanvasRenderingContext2D.roundRect exists.
    if (r > 0 && typeof ctx.roundRect === 'function'){
      ctx.roundRect(x, y, w, h, r);
    } else if (r > 0){
      // Fallback: manual rounded-rect path.
      const rr = r;
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
      // Simple rect clip.
      ctx.rect(x, y, w, h);
    }
    ctx.clip();
  }

  // Apply a simple scale transform to target points around (cx,cy).
  // Used for the tall layout to make HH/MM slightly vertically elongated.
  function _stretchTargets(targets, cx, cy, sx, sy){
    if (!targets || !targets.length) return;
    for (let i=0; i<targets.length; i++){
      const t = targets[i];
      if (!t) continue;
      t.x = cx + (t.x - cx) * sx;
      t.y = cy + (t.y - cy) * sy;
    }
  }

  function boot(){
    // ---------------- Config ----------------
    const UA = navigator.userAgent || '';
    const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const IS_IPAD = /iPad/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const IS_ANDROID = /Android/i.test(UA);
    const IS_MOBILE = IS_IOS || IS_ANDROID;
    const SMALL_SCREEN = Math.min(window.innerWidth || 0, window.innerHeight || 0) > 0
      ? (Math.min(window.innerWidth, window.innerHeight) < 420)
      : false;
    const DEVICE_MEM = (typeof navigator.deviceMemory === 'number') ? navigator.deviceMemory : null; // GB (Chromium only)
    const CORES = (typeof navigator.hardwareConcurrency === 'number') ? navigator.hardwareConcurrency : null;

    // ---- Auto performance tier (no user settings needed) ----
    // 0: desktop/high, 1: mobile normal, 2: mobile low-end
    let PERF_LEVEL = 0;
    if (IS_MOBILE) PERF_LEVEL = 1;
    if (IS_MOBILE && SMALL_SCREEN) PERF_LEVEL = 2;
    if (DEVICE_MEM !== null && DEVICE_MEM <= 4) PERF_LEVEL = Math.max(PERF_LEVEL, 1);
    if (DEVICE_MEM !== null && DEVICE_MEM <= 3) PERF_LEVEL = 2;
    if (CORES !== null && CORES <= 4) PERF_LEVEL = Math.max(PERF_LEVEL, 1);
    if (CORES !== null && CORES <= 2) PERF_LEVEL = 2;

    const PERF_MODE = (PERF_LEVEL > 0);
    let DPR = 1; // force DPR=1 for stability/perf across devices

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
    // 1920x1080(=2,073,600px) のとき、blobScale が
    //   - PERF_LEVEL 0: 2
    //   - PERF_LEVEL 1: 4
    //   - PERF_LEVEL 2: 5
    // くらいになるようにして、スマホで自動的に軽くする。
    // resize() 内で blobScale = ceil(sqrt(area / MAX_BLOB_PIXELS)) を使う。
    let MAX_BLOB_PIXELS = (PERF_LEVEL === 0) ? 540000 : (PERF_LEVEL === 1 ? 320000 : 240000);

    // Render budgets (skip some particles when drawing the blob to keep it smooth on mobile)
    let RENDER_BUDGET_H = (PERF_LEVEL === 0) ? 1400 : (PERF_LEVEL === 1 ? 340 : 240);
    let RENDER_BUDGET_M = (PERF_LEVEL === 0) ? 1400 : (PERF_LEVEL === 1 ? 340 : 240);
    let RENDER_BUDGET_C = (PERF_LEVEL === 0) ? 90   : (PERF_LEVEL === 1 ? 70  : 55);
    const ENABLE_OUTLINE_PASS = (PERF_LEVEL === 0);
    const GUIDE_STRIDE_BASE = (PERF_LEVEL === 0) ? 4 : (PERF_LEVEL === 1 ? 8 : 10);

    const HN = 770, MN = 770;
    const CN = 110;          // colon ":" allocation
    const N  = HN + MN + CN; // total
    const IDLE_JITTER = 0.35, SEEK_STRENGTH = 0.085, DAMP = 0.78;
    let DETECT_MIN_INTERVAL_MS = (PERF_LEVEL === 0) ? 110 : (PERF_LEVEL === 1 ? 170 : 230);
    const SEEN_DEBOUNCE_MS = 450;
    const FRAME_RATE_TARGET = (PERF_LEVEL === 0) ? 60 : (PERF_LEVEL === 1 ? 55 : 50);
    const LOST_CONFIRM_STREAK = 2; // 連続「未検知」回数で見失い確定（検出の瞬断を吸収）

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
      const cam = { enabled:false, preview:false, showBox:false, starting:false,
                    video: document.getElementById('cam'),
                    wrap: document.getElementById('camWrap'),
                    inner: document.getElementById('camInner'),
                    previewMirror:true,
                    faceBox: document.getElementById('faceBox'),
                    stream:null, detector:null, api:'none', lastSeenAt: 0, lastDetectAt: 0, noFaceStreak: 0,
                    face:{has:false,cx:0.5,cy:0.5,size:0.22,w:0,h:0}, faceAt:0 };

      function hideFaceBox(){
        if (cam.faceBox){ cam.faceBox.style.display = 'none'; }
      }

      // Update face tracking box on the camera preview using actual video DOM rect.
      // This avoids drift caused by layout/padding/aspect differences.
      function updateFaceBoxFromBB(bb, vw, vh){
        if (!cam.faceBox || !cam.video) return;
        if (!cam.preview || !cam.showBox){ cam.faceBox.style.display = 'none'; cam._faceBoxSmooth = null; return; }
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
        cam.faceBox.style.display = 'block';
      }

      // UI
      const holder = document.getElementById('canvas-holder');
      const startOverlay = document.getElementById('startOverlay');
      const btnCam = document.getElementById('btnCam');
      const diag = document.getElementById('diag');

      // Fullscreen & UI visibility (for exhibition)
      const uiBox = document.getElementById('ui');
      const btnFS = document.getElementById('btnFS');
      const btnHideUI = document.getElementById('btnHideUI');
      const uiFab = document.getElementById('uiFab');
      const fsHelp = document.getElementById('fsHelp');
      const fsHelpClose = document.getElementById('fsHelpClose');

      // Preview toggles (camera preview + face box)
      const togglePreview = document.getElementById('togglePreview');
      const toggleFaceBox = document.getElementById('toggleFaceBox');

      function applyPreviewUI(){
        if (cam.wrap){ cam.wrap.style.display = cam.preview ? 'block' : 'none'; }
        if (!cam.preview){ hideFaceBox(); }
      }
      function applyFaceBoxUI(){
        if (!cam.showBox){ hideFaceBox(); }
      }

      // Load saved preferences
      try{
        const pv = localStorage.getItem('saboclock_preview');
        const fb = localStorage.getItem('saboclock_facebox');
        cam.preview = (pv === '1');
        cam.showBox = (fb === '1');
      }catch(e){}

      if (togglePreview){
        togglePreview.checked = cam.preview;
        togglePreview.addEventListener('change', ()=>{
          cam.preview = !!togglePreview.checked;
          try{ localStorage.setItem('saboclock_preview', cam.preview ? '1' : '0'); }catch(e){}
          // If preview is turned off, also turn off face box UI (it depends on preview)
          if (!cam.preview && toggleFaceBox){
            toggleFaceBox.checked = false;
            cam.showBox = false;
            try{ localStorage.setItem('saboclock_facebox', '0'); }catch(e){}
          }
          applyPreviewUI();
        });
      }
      if (toggleFaceBox){
        toggleFaceBox.checked = cam.showBox;
        toggleFaceBox.addEventListener('change', ()=>{
          cam.showBox = !!toggleFaceBox.checked;
          try{ localStorage.setItem('saboclock_facebox', cam.showBox ? '1' : '0'); }catch(e){}
          // Turning face box on implies preview on
          if (cam.showBox){
            cam.preview = true;
            if (togglePreview) togglePreview.checked = true;
            try{ localStorage.setItem('saboclock_preview', '1'); }catch(e){}
          }
          applyPreviewUI();
          applyFaceBoxUI();
        });
      }

      // Apply initial UI visibility
      applyPreviewUI();
      applyFaceBoxUI();


      function setUIVisible(v){
        if (!uiBox) return;
        uiBox.style.display = v ? 'block' : 'none';
        if (uiFab) uiFab.style.display = v ? 'none' : 'block';
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

      if (btnHideUI){ btnHideUI.addEventListener('click', ()=> setUIVisible(false)); }
      if (uiFab){ uiFab.addEventListener('click', ()=> setUIVisible(true)); }
      if (btnFS){ btnFS.addEventListener('click', ()=>{ requestFullscreenSmart(); }); }
      if (fsHelpClose){ fsHelpClose.addEventListener('click', ()=> showFsHelp(false)); }
      if (fsHelp){ fsHelp.addEventListener('click', (e)=>{ if (e.target === fsHelp) showFsHelp(false); }); }


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



// Shared version: camera is mandatory (no simulation mode)
      if (btnCam){
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
          btnCam.disabled = true;
          btnCam.textContent = 'この端末ではカメラを開始できません';
        } else {
          btnCam.addEventListener('click', startCamera);
        }
      }

      function updateDiag(text){
        if (!diag) return;
        if (typeof text === 'string'){
          diag.textContent = text;
          return;
        }
        const secureOk = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const now = performance.now();
        const camSeen = cam.enabled ? ((now - cam.lastSeenAt <= SEEN_DEBOUNCE_MS) && ((cam.noFaceStreak||0) < LOST_CONFIRM_STREAK)) : false;
        let msg = '診断: ';
        if (!secureOk) msg += 'HTTPS/localhost が必要';
        else if (!cam.enabled) msg += 'カメラ未開始（ボタンを押してください）';
        else msg += camSeen ? '見られている' : '見られていない';

        // show auto performance tier (helps when testing on phones)
        if (PERF_LEVEL === 0) msg += ' / 軽量:OFF';
        else if (PERF_LEVEL === 1) msg += ' / 軽量:ON';
        else msg += ' / 軽量:強';
        diag.textContent = msg;
      }

      // Canvas + slime buffer
      let gBlob = null, blobScale = 4;

// Rendering params (minimal)
const renderTint = {r:255,g:255,b:255,a:255};
const renderRadiusScale = 1.0;
const renderColonSpeed = 1.0;


      function resize(){
        p.resizeCanvas(1920, 1080);
        // Decide blob resolution
        const area = p.width * p.height;
        blobScale = Math.max(2, Math.ceil(Math.sqrt(area / MAX_BLOB_PIXELS)));
        const bw = Math.max(64, Math.floor(p.width / blobScale));
        const bh = Math.max(64, Math.floor(p.height / blobScale));
        gBlob = p.createGraphics(bw, bh);
        gBlob.pixelDensity(DPR);
        layoutInitial(); rebuildTargets();
      }
      let fitScale = 1.0;

      // Visible rectangle in *canvas coordinates* (canvas is CSS-scaled to COVER the screen).
      // Shared version rule: device active area == clock region (walls).
      let viewRect = { minX: 0, maxX: 1920, minY: 0, maxY: 1080, r: 0 };

      // Computed layout info derived from viewRect (shared version)
      let layoutInfo = null;


      function updateViewRect(){
        const vv = window.visualViewport;
        const vw = vv ? vv.width : window.innerWidth;
        const vh = vv ? vv.height : window.innerHeight;

        // COVER scale: fill the viewport while keeping 16:9 canvas.
        fitScale = Math.max(vw / 1920, vh / 1080);

        const visW = vw / fitScale;
        const visH = vh / fitScale;

        const cx = 1920 * 0.5;
        const cy = 1080 * 0.5;

        viewRect = {
          minX: cx - visW * 0.5,
          maxX: cx + visW * 0.5,
          minY: cy - visH * 0.5,
          maxY: cy + visH * 0.5,
          r: 0
        };

        // clamp
        viewRect.minX = Math.max(0, viewRect.minX);
        viewRect.maxX = Math.min(1920, viewRect.maxX);
        viewRect.minY = Math.max(0, viewRect.minY);
        viewRect.maxY = Math.min(1080, viewRect.maxY);
      }

      let _rebuildScheduled = false;
      function _scheduleRebuildTargets(){
        if (_rebuildScheduled) return;
        _rebuildScheduled = true;
        requestAnimationFrame(()=>{
          _rebuildScheduled = false;
          if (typeof rebuildTargets === 'function' && pts && pts.length) rebuildTargets();
        });
      }

      function applyFitScale(){
        updateViewRect();
        const c = holder.querySelector('canvas');
        if (c){
          c.style.position = 'absolute';
          c.style.left = '50%';
          c.style.top  = '50%';
          c.style.transform = `translate(-50%, -50%) scale(${fitScale})`;
          c.style.transformOrigin = 'center center';
        }
        _scheduleRebuildTargets();
      }

      p.setup = function(){

        const c = p.createCanvas(1920, 1080); c.parent(holder); applyFitScale();
        window.addEventListener('resize', applyFitScale, {passive:true});
        if (window.visualViewport){ window.visualViewport.addEventListener('resize', applyFitScale, {passive:true}); }
        p.pixelDensity(DPR);
        p.frameRate(FRAME_RATE_TARGET);
        resize();
        const waitFonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
        waitFonts.then(()=>{ rebuildTargets(); setTimeout(rebuildTargets, 0); });
        updateDiag();
      };

      function layoutInitial(){
        for (let i=0;i<N;i++){
          const g = (i < HN) ? 0 : (i < HN + MN ? 1 : 2);
          const pad = Math.max(2, DISC_RADIUS * 0.9);
          const minX = viewRect.minX + pad;
          const maxX = viewRect.maxX - pad;
          const minY = viewRect.minY + pad;
          const maxY = viewRect.maxY - pad;
          const rw = Math.max(1, maxX - minX);
          const rh = Math.max(1, maxY - minY);
          pts[i].x = minX + Math.random()*rw; pts[i].y = minY + Math.random()*rh;
          pts[i].vx = pts[i].vy = 0; pts[i].group = g;
          pts[i].activeAt = 0; pts[i].ax = pts[i].x; pts[i].ay = pts[i].y; pts[i].catchUntil = 0;
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
      function buildTargetsFor(text, maxCount, xCenter, yCenter, fontSize, isGuide){
        // Make an offscreen buffer just wide enough for the given font size.
        const estW = Math.ceil(fontSize * (text.length * 0.9 + 1.2));
        const gW = Math.max(10, Math.min(p.width, estW));
        const g = p.createGraphics(gW, p.height);
        g.pixelDensity(1);
        g.clear();

        // Prefer font rendering.
        drawFontDigits(g, text, fontSize, g.width*0.5, yCenter);

        g.loadPixels();
        const d = 1;
        const W = g.width * d;
        const H = g.height * d;
        const step = Math.max(1, Math.floor(Math.min(p.width, p.height) * 0.0035));

        const arr = [];
        for (let y = 0; y < H; y += step){
          for (let x = 0; x < W; x += step){
            const idx = 4*(y*W + x);
            const a = g.pixels[idx + 3];
            if (a > 128){
              arr.push({
                x: (x/d) + (xCenter - g.width*0.5),
                y: (y/d),
                g: !!isGuide
              });
            }
          }
        }

        // Random sample (stable enough for our use).
        if (arr.length > maxCount){
          for (let i = arr.length - 1; i > 0; i--){
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
          }
          arr.length = maxCount;
        }

        return arr;
      }
      function buildTargetsForHColon(maxCount, xCenter, yCenter, fontSize, isGuide){
        // Horizontal two-dots colon: ".."
        const gW = Math.max(10, Math.min(p.width, Math.ceil(fontSize * 2.4)));
        const g = p.createGraphics(gW, p.height);
        g.pixelDensity(1);
        // IMPORTANT: keep the background transparent.
        // We sample by alpha channel, so using background(0) would make the whole buffer opaque,
        // causing targets to fill the entire area (dots become invisible). 
        g.clear();

        const dotR = fontSize * 0.14;
        // Gap between the two dots. User feedback: 0.55 was too tight on tall (phone portrait).
        // Keep within the glyph buffer width (gW ≈ fontSize*2.4), so 0.75 is a safe increase.
        const gap = fontSize * 0.75;

        g.noStroke();
        g.fill(255);
        g.circle(gW / 2 - gap / 2, yCenter, dotR * 2);
        g.circle(gW / 2 + gap / 2, yCenter, dotR * 2);

        g.loadPixels();
        const d = 1;
        const W = g.width;
        const H = g.height;
        // For small glyphs (dots), use a finer sampling stride so we get enough unique targets.
        const step = Math.max(1, Math.floor(fontSize * 0.04));

        const arr = [];
        for (let y = 0; y < H; y += step){
          for (let x = 0; x < W; x += step){
            const idx = 4 * (y * W + x);
            const a = g.pixels[idx + 3];
            if (a > 128){
              arr.push({
                x: x + (xCenter - gW / 2),
                y: y,
                g: !!isGuide
              });
            }
          }
        }

        // deterministic-ish shuffle
        for (let i = arr.length - 1; i > 0; i--){
          const j = Math.floor(p.random(i + 1));
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
        }

        arr.length = Math.min(maxCount, arr.length);
        for (let i = 0; i < arr.length; i++) arr[i].i = i;
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
          // Wide layout (PC / tablet landscape): keep a strong presence without over-spacing on ultra-wide screens.
          const padX = Math.max(24, vw * 0.06);
          const padY = Math.max(24, vh * 0.06);

          // Size is limited by both height and width so it doesn't get too huge on 16:9 / ultrawide,
          // and doesn't collapse on smaller laptops. (Shared version prefers slightly smaller digits.)
          // Wide (landscape): make digits a bit smaller across all aspect ratios.
          let sizeHM = _clamp(Math.min(vh * 0.55, vw * 0.265), 160, 680);
          // Also respect vertical padding.
          sizeHM = Math.min(sizeHM, Math.max(120, (vh - padY * 2) * 0.95));

          // Digit spacing: tie primarily to size (stable across very wide screens), but also ensure it fits within viewRect.
          const digitHalfW = sizeHM * 0.54; // heuristic for "88" width / 2
          const dxLimit = Math.max(sizeHM * 0.56, (vw * 0.5) - padX - digitHalfW);
          // Give a bit more breathing room between H and M on wide screens.
          const dx = Math.min(sizeHM * 0.86, dxLimit);

          layoutInfo = {
            mode, cx, cy, viewW: vw, viewH: vh,
            H: { x: cx - dx, y: cy, size: sizeHM },
            M: { x: cx + dx, y: cy, size: sizeHM },
            C: { x: cx, y: cy - sizeHM * 0.06, size: sizeHM * 0.33, style: 'v' }
          };
        } else {
          // Tall (portrait): slightly smaller digits.
          const sizeHM = _clamp(Math.min(vw * 0.90, vh * 0.27), 140, 540);
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

        FONT_WEIGHT = WEIGHT_HM;
        const hmFontH = Math.round(layoutInfo.H.size);
        let txH = buildTargetsFor(HH, HN, Math.round(layoutInfo.H.x), Math.round(layoutInfo.H.y), hmFontH, true);

        FONT_WEIGHT = WEIGHT_HM;
        const hmFontM = Math.round(layoutInfo.M.size);
        let txM = buildTargetsFor(MM, MN, Math.round(layoutInfo.M.x), Math.round(layoutInfo.M.y), hmFontM, false);

        FONT_WEIGHT = WEIGHT_COLON;
        const colonFont = Math.round(layoutInfo.C.size);
        let txColon = [];
        if (layoutInfo.C.style === 'v'){
          txColon = buildTargetsFor(':', CN, Math.round(layoutInfo.C.x), Math.round(layoutInfo.C.y), colonFont, true);
        } else {
          txColon = buildTargetsForHColon(CN, Math.round(layoutInfo.C.x), Math.round(layoutInfo.C.y), colonFont, true);
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

        // Bounds (legacy/debug)
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
          const halfW = Math.max(cx - minX, maxX - cx) + EXTRA;
          const halfH = Math.max(cy - minY, maxY - cy) + EXTRA;
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
      const center = (team==='H') ? {x:layoutInfo.H.x, y:layoutInfo.H.y} :
                                    {x:layoutInfo.M.x, y:layoutInfo.M.y};

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
      async function startCamera(){
        try{
          if (cam.starting) return;
          if (cam.enabled && cam.stream) { updateDiag(); return; }
          cam.starting = true;
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
            updateDiag('診断: getUserMedia（カメラ）が使えません');
            return;
          }
          const secureOk = window.isSecureContext || location.hostname==='localhost' || location.hostname==='127.0.0.1';
          if (!secureOk){
            updateDiag('診断: HTTPS か localhost が必要です');
            return;
          }

          const stream = await navigator.mediaDevices.getUserMedia({
            video:{facingMode:'user', width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:30, max:30}},
            audio:false
          });

          cam.stream = stream;
          cam.video.srcObject = stream;
          await cam.video.play();

          cam.enabled = true;
          cam.preview = false;
          if (cam.wrap) cam.wrap.style.display = cam.preview ? 'block' : 'none';

          cam.api='MediaPipe';
          cam.detector=null;
          cam.face = {has:false,cx:0.5,cy:0.5,size:0.22,w:0,h:0};
          cam.faceAt = 0;
          cam.lastSeenAt = 0;
          cam.noFaceStreak = 0;

          if (cam.faceBox) cam.faceBox.style.display = 'none';

          try{
            cam.detector = await initMediaPipeFaceDetector();
            cam.api='MediaPipe';
          }catch(_e){
            cam.detector = null;
            cam.api = 'none';
          }

          if (startOverlay) startOverlay.style.display = 'none';
          cam.starting = false;
          updateDiag();
        }catch(e){
          console.warn(e);
          cam.starting = false;
          updateDiag('診断: カメラ開始に失敗（権限/対応/HTTPSを確認）');
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
              cam.noFaceStreak = 0;
              cam.lastSeenAt = now;

              // pick largest face
              let best = faces[0];
              for (let i=1;i<faces.length;i++){
                const b = faces[i].boundingBox; const bb = best.boundingBox;
                if (b && bb && (b.width*b.height > bb.width*bb.height)) best = faces[i];
              }

              const bb = best.boundingBox;
              if (bb && vw>1 && vh>1){
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
                cam.noFaceStreak = (cam.noFaceStreak||0) + 1;
              cam.face.has = false;
                if (cam.faceBox) cam.faceBox.style.display = 'none';
                cam._faceBoxSmooth = null;
              }
            } else {
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
  _clipRoundedRect(ctx, viewRect);
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
        seen = camSeen;

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

          // keep inside visible area (viewRect) — shared rule: device active area == clock region
          const wallPad = Math.max(2, DISC_RADIUS * 0.9);
          const minX = viewRect.minX + wallPad;
          const maxX = viewRect.maxX - wallPad;
          const minY = viewRect.minY + wallPad;
          const maxY = viewRect.maxY - wallPad;

          if (a.x < minX){ a.x = minX; a.vx *= -0.5; }
          else if (a.x > maxX){ a.x = maxX; a.vx *= -0.5; }

          if (a.y < minY){ a.y = minY; a.vy *= -0.5; }
          else if (a.y > maxY){ a.y = maxY; a.vy *= -0.5; }
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
