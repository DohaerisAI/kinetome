import { ThinkingOrb, type OrbState } from 'thinking-orbs';

/** Claude's thinking orb, tinted in Claude's color (canvas, paused offscreen, reduced-motion aware). */
export function Orb({ state = 'working', size = 20, color = '#e0885a', label }: { state?: OrbState; size?: 20 | 32 | 64; color?: string; label?: string }) {
  return <ThinkingOrb state={state} size={size} theme="dark" color={color} aria-label={label ?? 'Claude is thinking'} role="img" style={{ flex: 'none' }} />;
}
