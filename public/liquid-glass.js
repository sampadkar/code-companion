/* liquid-glass.js — reusable NSOffice glass primitives.
   Adds .glass surfaces a pointer-tracked sheen and builds the standard
   glass button/chip/panel classes used across NSOffice screens. */

export const GLASS_STYLES = `
.glass {
  position: relative;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--blur)) saturate(180%);
  backdrop-filter: blur(var(--blur)) saturate(180%);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.glass::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(
    600px circle at var(--mx, 50%) var(--my, 0%),
    rgba(255, 255, 255, 0.25),
    transparent 40%
  );
  opacity: 0;
  transition: opacity var(--duration) var(--ease);
}
.glass:hover::before { opacity: 1; }

.glass-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-family: var(--font);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 999px;
  padding: 12px 28px;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(45, 107, 255, 0.35);
  transition: transform var(--duration) var(--ease),
              background var(--duration) var(--ease),
              box-shadow var(--duration) var(--ease);
}
.glass-button:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: 0 10px 28px rgba(45, 107, 255, 0.45);
}
.glass-button:active:not(:disabled) { transform: translateY(0) scale(0.98); }
.glass-button:disabled { opacity: 0.45; cursor: default; }

.glass-button--secondary {
  color: var(--ink);
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-card);
}
.glass-button--secondary:hover:not(:disabled) {
  background: var(--glass-bg);
  box-shadow: var(--shadow-float);
}

.glass-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-2);
  background: var(--glass-bg-strong);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 6px 14px;
}
.glass-chip .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--ink-3);
}
.glass-chip.is-live { color: var(--accent); border-color: var(--accent-soft); }
.glass-chip.is-live .dot {
  background: var(--accent);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(45, 107, 255, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(45, 107, 255, 0); }
}
`;

let styleInjected = false;

export function ensureGlassStyles() {
  if (styleInjected) return;
  const style = document.createElement("style");
  style.dataset.liquidGlass = "true";
  style.textContent = GLASS_STYLES;
  document.head.appendChild(style);
  styleInjected = true;
}

// Pointer-tracked sheen on every .glass surface.
export function bindGlassSheen(root = document) {
  root.addEventListener("pointermove", (event) => {
    const target = event.target.closest?.(".glass");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    target.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    target.style.setProperty("--my", `${event.clientY - rect.top}px`);
  });
}
