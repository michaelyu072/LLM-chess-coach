const cache = new Map<string, HTMLAudioElement>();

export function playSound(name: 'Move' | 'Capture' | 'Check' | 'Error' | 'Confirmation' | 'Victory'): void {
  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(`/lila/sound/${name}.mp3`);
    audio.volume = 0.7;
    cache.set(name, audio);
  }
  audio.currentTime = 0;
  audio.play().catch(() => {}); // autoplay may be blocked before first interaction
}

export function soundForSan(san: string) {
  if (san.includes('+') || san.includes('#')) return 'Check' as const;
  return san.includes('x') ? ('Capture' as const) : ('Move' as const);
}
