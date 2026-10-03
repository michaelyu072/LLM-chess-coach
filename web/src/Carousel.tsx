import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  label: string;
  items: T[];
  selected: string;
  getId: (item: T) => string;
  getName: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onSelect: (id: string) => void;
}

/** Horizontal, snap-scrolling picker with prev/next arrows. */
export function Carousel<T>({ label, items, selected, getId, getName, renderItem, onSelect }: Props<T>) {
  const track = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const updateArrows = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setCanPrev(el.scrollLeft > 1);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Keep the selected item in view (on mount and whenever it changes).
  useEffect(() => {
    const el = track.current;
    const item = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (el && item) {
      const left = item.offsetLeft; // track is position: relative
      if (left < el.scrollLeft || left + item.offsetWidth > el.scrollLeft + el.clientWidth)
        el.scrollTo({ left: left - (el.clientWidth - item.offsetWidth) / 2 });
    }
    updateArrows();
  }, [selected, updateArrows]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateArrows]);

  const page = (dir: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  const current = items.find(i => getId(i) === selected);

  return (
    <div className="carousel">
      <div className="carousel-head">
        <span>{label}</span>
        <span className="carousel-current">{current ? getName(current) : ''}</span>
        <span className="carousel-count">{items.length}</span>
      </div>
      <div className="carousel-body">
        <button className="carousel-arrow" onClick={() => page(-1)} disabled={!canPrev} aria-label={`Previous ${label}`}>
          ‹
        </button>
        <div className="carousel-track" ref={track} onScroll={updateArrows}>
          {items.map(item => {
            const id = getId(item);
            return (
              <button
                key={id}
                className="carousel-item"
                aria-pressed={id === selected}
                title={getName(item)}
                onClick={() => onSelect(id)}
              >
                {renderItem(item)}
              </button>
            );
          })}
        </div>
        <button className="carousel-arrow" onClick={() => page(1)} disabled={!canNext} aria-label={`Next ${label}`}>
          ›
        </button>
      </div>
    </div>
  );
}
