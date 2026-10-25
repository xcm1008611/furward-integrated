/** One vibration vocabulary, so each event can be told apart by touch alone. Values are on/off milliseconds. */
export const HAPTICS = {
  tap: 25,
  start: [80, 60, 80, 60, 220],
  stop: 400,
  obstacle: [300, 120, 300],
  detourStart: [150, 80, 150, 80, 150],
  detourEnd: [60, 60, 200],
  turnLeft: [90, 90, 90],
  turnRight: [90, 90, 90, 90, 90],
  progress: 40,
  arrived: [120, 80, 120, 80, 400],
  cancelled: [200, 100, 60],
  confirm: [40, 60, 40],
  listenStart: 50,
  listenStop: [30, 50, 30],
  failure: [200, 100, 200],
  disconnected: [500, 200, 500],
} satisfies Record<string, number | number[]>;
export type Haptic = keyof typeof HAPTICS;

let enabled = true;
export function setHapticsEnabled(value: boolean) { enabled = value; }

/** True when the page can vibrate: the Vibration API (Android), or the iOS 18+ switch-control tick. */
export function hapticsSupported() {
  return typeof navigator !== 'undefined' && (typeof navigator.vibrate === 'function' || /iP(hone|ad|od)/.test(navigator.userAgent));
}

let iosSwitch: HTMLLabelElement | null = null;
/** Safari has no Vibration API; toggling a native <input switch> gives one system tick per toggle on iOS 18+. */
function iosTick() {
  if (!iosSwitch) {
    iosSwitch = document.createElement('label');
    iosSwitch.setAttribute('aria-hidden', 'true');
    iosSwitch.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-10px;top:0';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    iosSwitch.appendChild(input);
    document.body.appendChild(iosSwitch);
  }
  iosSwitch.click();
}

export function vibrate(haptic: Haptic) {
  if (!enabled || typeof navigator === 'undefined') return;
  const pattern = HAPTICS[haptic];
  try {
    if (typeof navigator.vibrate === 'function') { navigator.vibrate(pattern); return; }
    // iOS: one tick per "on" segment, capped so longer patterns stay short.
    const pulses = Math.min(3, Array.isArray(pattern) ? Math.ceil(pattern.length / 2) : 1);
    for (let index = 0; index < pulses; index++) window.setTimeout(iosTick, index * 140);
  } catch { /* Vibration is a bonus; never block navigation on it. */ }
}
