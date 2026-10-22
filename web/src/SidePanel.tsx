import { useEffect, useRef, useState, type ReactNode } from 'react';

const Chevron = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * The side column beside the board. It scrolls when its sections outgrow the
 * board's height; a faint fade with a caret marks the edge that has more.
 */
export function SidePanel({ children }: { children: ReactNode }) {
  const el = useRef<HTMLElement>(null);
  const [more, setMore] = useState({ up: false, down: false });

  useEffect(() => {
    const side = el.current;
    if (!side) return;
    const update = () => {
      const up = side.scrollTop > 2;
      const down = side.scrollTop + side.clientHeight < side.scrollHeight - 2;
      setMore(m => (m.up === up && m.down === down ? m : { up, down }));
    };
    // Content changes size as sections open and close, not only on scroll.
    const ro = new ResizeObserver(update);
    const observeChildren = () => [side, ...side.children].forEach(c => ro.observe(c));
    observeChildren();
    const mo = new MutationObserver(() => (observeChildren(), update()));
    mo.observe(side, { childList: true });
    side.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      ro.disconnect();
      mo.disconnect();
      side.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div className="side-wrap">
      <aside className="side" ref={el}>
        {children}
      </aside>
      <div className={`scroll-hint up${more.up ? ' shown' : ''}`} aria-hidden="true">
        <Chevron />
      </div>
      <div className={`scroll-hint down${more.down ? ' shown' : ''}`} aria-hidden="true">
        <Chevron />
      </div>
    </div>
  );
}
