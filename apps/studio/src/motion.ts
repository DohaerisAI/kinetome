import { useEffect, type DependencyList, type RefObject } from 'react';
import { animate, stagger } from 'animejs';

/**
 * Motion for the whole studio, on anime.js: short, eased-out entrances that make screens
 * feel alive without slowing anyone down. Everything is skipped under reduced motion.
 */
export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fades and lifts the matching children of `root` in, one after another. */
export function enter(root: Element | null, selector = '[data-enter]', opts: { y?: number; delay?: number; step?: number } = {}) {
  if (!root || reducedMotion()) return;
  const els = root.querySelectorAll(selector);
  if (!els.length) return;
  animate(els, { opacity: [0, 1], translateY: [opts.y ?? 12, 0], duration: 560, delay: stagger(opts.step ?? 45, { start: opts.delay ?? 0 }), ease: 'outExpo' });
}

/** Runs `enter` whenever `deps` change (a new screen, a new list). */
export function useEnter(ref: RefObject<Element | null>, deps: DependencyList, selector = '[data-enter]', opts?: { y?: number; delay?: number; step?: number }) {
  useEffect(() => { enter(ref.current, selector, opts); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A whole view easing in (tab changes). */
export function viewIn(el: Element | null) {
  if (!el || reducedMotion()) return;
  animate(el, { opacity: [0, 1], translateY: [6, 0], duration: 420, ease: 'outQuart' });
}

/** Slides a highlight to sit exactly under `target` (the nav's active pill). */
export function slideTo(indicator: HTMLElement | null, target: HTMLElement | null, instant = false) {
  if (!indicator || !target) return;
  const x = target.offsetLeft, width = target.offsetWidth;
  if (instant || reducedMotion()) { indicator.style.transform = `translateX(${x}px)`; indicator.style.width = `${width}px`; indicator.style.opacity = '1'; return; }
  animate(indicator, { translateX: x, width, opacity: 1, duration: 520, ease: 'outBack(1.1)' });
}

/** A small pop for things that just appeared (toasts, badges). */
export function pop(el: Element | null) {
  if (!el || reducedMotion()) return;
  animate(el, { opacity: [0, 1], translateY: [14, 0], scale: [0.96, 1], duration: 480, ease: 'outBack(1.4)' });
}
