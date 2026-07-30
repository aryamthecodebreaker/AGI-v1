// The animated AI presence.
//
// An original canvas drawing: concentric rings of layered sine offsets whose
// amplitude, speed and colour follow the assistant's state. No external assets,
// no libraries, no branded artwork.
//
// Accessibility: the orb is decorative and marked aria-hidden. Every state it
// depicts is also written out in text next to it, so nothing is conveyed by
// motion or colour alone. Under prefers-reduced-motion the animation loop is not
// started at all — a single static frame is drawn per state change.

const PALETTE = {
  idle: { core: [124, 156, 255], glow: [74, 108, 240], speed: 0.25, amp: 0.05 },
  listening: { core: [110, 231, 183], glow: [16, 185, 129], speed: 1.5, amp: 0.22 },
  transcribing: { core: [110, 231, 183], glow: [16, 185, 129], speed: 0.9, amp: 0.12 },
  thinking: { core: [167, 139, 250], glow: [124, 58, 237], speed: 1.1, amp: 0.16 },
  confirming: { core: [251, 191, 36], glow: [217, 119, 6], speed: 0.6, amp: 0.1 },
  dispatching: { core: [96, 165, 250], glow: [37, 99, 235], speed: 2.2, amp: 0.26 },
  executing: { core: [96, 165, 250], glow: [37, 99, 235], speed: 1.6, amp: 0.2 },
  speaking: { core: [124, 156, 255], glow: [79, 70, 229], speed: 1.3, amp: 0.24 },
  success: { core: [74, 222, 128], glow: [22, 163, 74], speed: 0.4, amp: 0.09 },
  partial: { core: [251, 191, 36], glow: [217, 119, 6], speed: 0.5, amp: 0.12 },
  error: { core: [248, 113, 113], glow: [220, 38, 38], speed: 0.5, amp: 0.14 },
};

export const ORB_STATES = Object.keys(PALETTE);

export function createOrb(canvas) {
  const context = canvas.getContext('2d');
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  let state = 'idle';
  let frame = 0;
  let raf = null;
  // Eased so a state change glides rather than snapping.
  let current = { ...PALETTE.idle };

  function mix(from, to, t) {
    return from.map((v, i) => v + (to[i] - v) * t);
  }

  function draw() {
    const target = PALETTE[state] ?? PALETTE.idle;
    current = {
      core: mix(current.core, target.core, 0.08),
      glow: mix(current.glow, target.glow, 0.08),
      speed: current.speed + (target.speed - current.speed) * 0.08,
      amp: current.amp + (target.amp - current.amp) * 0.08,
    };

    const { width, height } = canvas;
    const cx = width / 2;
    const cy = height / 2;
    const base = Math.min(width, height) * 0.3;
    const t = frame * 0.02 * current.speed;

    context.clearRect(0, 0, width, height);

    // Outer glow.
    const glow = context.createRadialGradient(cx, cy, base * 0.2, cx, cy, base * 2.1);
    glow.addColorStop(0, `rgba(${current.glow.map(Math.round).join(',')},0.35)`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);

    // Three offset rings. Layering two sines at different frequencies gives an
    // organic wobble without any randomness, so it stays deterministic.
    for (let ring = 0; ring < 3; ring++) {
      const phase = t + ring * 0.9;
      const radius = base * (1 + ring * 0.22);
      context.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 60) {
        const wobble =
          1 +
          current.amp * Math.sin(a * 3 + phase) * 0.6 +
          current.amp * Math.sin(a * 5 - phase * 1.4) * 0.4;
        const r = radius * wobble;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (a === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      const alpha = 0.5 - ring * 0.14;
      context.strokeStyle = `rgba(${current.core.map(Math.round).join(',')},${alpha})`;
      context.lineWidth = ring === 0 ? 2 : 1;
      context.stroke();
    }

    // Core.
    const core = context.createRadialGradient(cx, cy, 0, cx, cy, base * 0.85);
    core.addColorStop(0, `rgba(${current.core.map(Math.round).join(',')},0.95)`);
    core.addColorStop(0.6, `rgba(${current.glow.map(Math.round).join(',')},0.45)`);
    core.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = core;
    context.beginPath();
    context.arc(cx, cy, base * 0.85, 0, Math.PI * 2);
    context.fill();
  }

  function loop() {
    frame++;
    draw();
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (reduceMotion?.matches) {
      // One static frame, redrawn only when the state changes.
      current = { ...PALETTE[state] };
      draw();
      return;
    }
    if (raf === null) loop();
  }

  function stop() {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  }

  // Honour a mid-session change to the OS motion preference.
  reduceMotion?.addEventListener?.('change', () => {
    stop();
    start();
  });

  start();

  return {
    setState(next) {
      if (!PALETTE[next] || next === state) return;
      state = next;
      if (reduceMotion?.matches) {
        current = { ...PALETTE[state] };
        draw();
      }
    },
    get state() {
      return state;
    },
    stop,
  };
}
