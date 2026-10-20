import { useEffect, useRef, type KeyboardEvent } from 'react';

/**
 * Hand-held barcode scanners behave like a keyboard: they type the code very fast and finish with Enter (some with
 * Tab). These helpers tell a scan apart from a person typing by that speed.
 */

/** People rarely type two keys within this many milliseconds; scanners always do. */
const SCAN_KEY_GAP_MS = 50;
/** Shortest code treated as a scan (EAN-8 is 8; leave room for short internal codes). */
const MIN_SCAN_LENGTH = 4;

const isTerminator = (key: string) => key === 'Enter' || key === 'Tab';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(type);
}

/**
 * Tracks key timing inside one text box, so its Enter/Tab handler can tell whether the text just arrived from a
 * scanner. Call `track(e)` from onKeyDown before checking `endsScan(e)`.
 */
export function useScanTiming() {
  const last = useRef({ at: 0, fastRun: 0 });
  return {
    track(e: KeyboardEvent<HTMLInputElement>) {
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      const now = performance.now();
      last.current = { at: now, fastRun: now - last.current.at < SCAN_KEY_GAP_MS ? last.current.fastRun + 1 : 1 };
    },
    /** Enter always ends an entry; Tab only right after a fast burst (a scanner configured with a Tab suffix). */
    endsScan(e: KeyboardEvent<HTMLInputElement>): boolean {
      if (e.key === 'Enter') return true;
      if (e.key !== 'Tab') return false;
      const recent = performance.now() - last.current.at < SCAN_KEY_GAP_MS * 2;
      return recent && last.current.fastRun >= MIN_SCAN_LENGTH;
    },
  };
}

/**
 * Catches scans made while no text box has the focus (the cashier last clicked a button or the page) and hands the
 * code to `onScan`. Typing in a text box is left alone: those boxes handle their own input.
 */
export function useGlobalScanner(onScan: (code: string) => void, enabled = true) {
  const handler = useRef(onScan);
  useEffect(() => {
    handler.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;
    let buffer = '';
    let lastAt = 0;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) {
        buffer = '';
        return;
      }
      const now = performance.now();
      const fast = now - lastAt < SCAN_KEY_GAP_MS;
      if (isTerminator(e.key)) {
        if (fast && buffer.length >= MIN_SCAN_LENGTH) {
          e.preventDefault();
          e.stopPropagation();
          handler.current(buffer);
        }
        buffer = '';
        return;
      }
      if (e.key.length !== 1) return;
      buffer = fast ? buffer + e.key : e.key;
      lastAt = now;
      // A scanned character must not press the focused button (e.g. a space).
      if (buffer.length > 1) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}

/**
 * For text boxes that hold barcodes (product forms): a scanner's Enter must not submit the form. It separates codes
 * with ", " instead, so several can be scanned in a row.
 */
export function barcodeFieldKeyDown(e: KeyboardEvent<HTMLInputElement>, setValue: (value: string) => void) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const value = e.currentTarget.value.replace(/[\s,]+$/, '');
  if (value) setValue(`${value}, `);
}

let audio: AudioContext | undefined;

/** A short low tone, so a cashier who is not watching the screen notices a failed scan. */
export function errorBeep() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = 220;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.25);
  } catch {
    // No audio (blocked or unsupported): the on-screen message still shows.
  }
}
