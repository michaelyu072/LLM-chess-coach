import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { CoachConversation, contextLabel, describeError, isAbort, type ChatMessage, type CoachContext } from './coach';
import { Markdown } from './Markdown';

const SUGGESTIONS: Record<CoachContext['source'], string[]> = {
  puzzle: ['Give me a hint', 'What should I be looking for?', 'Why was my move wrong?'],
  board: ['What’s the plan here?', 'Who is better and why?', 'Explain the engine’s top move'],
};

let nextId = 1;

/** Floating chat panel (bottom-right) about whatever position is on screen. */
export function CoachChat({ context }: { context: CoachContext | null }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const conversation = useRef(new CoachConversation());
  const listEl = useRef<HTMLDivElement>(null);
  const inputEl = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController>();

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const el = listEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, streaming, status, open]);

  useEffect(() => {
    if (open) inputEl.current?.focus();
  }, [open]);

  // Grow the textarea with its content (up to the CSS max-height).
  useLayoutEffect(() => {
    const el = inputEl.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, open]);

  useEffect(() => () => abort.current?.abort(), []);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || pending || !context) return;
    const userMsg: ChatMessage = { id: nextId++, role: 'user', text: question, contextLabel: contextLabel(context) };
    setMessages(m => [...m, userMsg]);
    setDraft('');
    setPending(true);
    setStreaming('');
    abort.current = new AbortController();
    const convo = conversation.current;
    try {
      const reply = await convo.send(question, context, {
        signal: abort.current.signal,
        onText: setStreaming,
        onStatus: setStatus,
      });
      if (convo === conversation.current) setMessages(m => [...m, { id: nextId++, role: 'coach', text: reply }]);
    } catch (e) {
      if (!isAbort(e) && convo === conversation.current)
        setMessages(m => [...m, { id: nextId++, role: 'coach', text: describeError(e) }]);
    } finally {
      if (convo === conversation.current) {
        setPending(false);
        setStreaming('');
        setStatus(null);
      }
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  const newChat = () => {
    abort.current?.abort();
    conversation.current = new CoachConversation();
    setPending(false);
    setStreaming('');
    setStatus(null);
    setMessages([]);
    setDraft('');
    inputEl.current?.focus();
  };

  if (!open)
    return (
      <button className="coach-launcher" onClick={() => setOpen(true)} aria-label="Open the coach chat">
        <span aria-hidden="true">💬</span> Ask the coach
      </button>
    );

  return (
    <section
      className="coach-panel"
      role="dialog"
      aria-label="Coach chat"
      onKeyDown={e => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <header className="coach-head">
        <div>
          <p className="coach-title">Coach</p>
          <p className="coach-context">{context ? contextLabel(context) : 'No position'}</p>
        </div>
        <div className="coach-head-actions">
          <button onClick={newChat} disabled={!messages.length && !pending} title="Start a new conversation">
            New chat
          </button>
          <button onClick={() => setOpen(false)} aria-label="Close" title="Close (Esc)">
            ×
          </button>
        </div>
      </header>

      <div className="coach-messages" ref={listEl} aria-live="polite">
        {!messages.length && (
          <div className="coach-empty">
            <p>Ask about the position on your board. The coach sees what you see.</p>
            {context && (
              <div className="coach-suggestions">
                {SUGGESTIONS[context.source].map(s => (
                  <button key={s} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`coach-msg ${m.role}`}>
            {m.role === 'user' && m.contextLabel && <span className="coach-msg-context">{m.contextLabel}</span>}
            {m.role === 'coach' ? (
              <div className="coach-bubble md">
                <Markdown text={m.text} />
              </div>
            ) : (
              <div className="coach-bubble">{m.text}</div>
            )}
          </div>
        ))}
        {pending &&
          (streaming ? (
            <div className="coach-msg coach">
              <div className="coach-bubble md">
                <Markdown text={streaming} />
              </div>
              {status && <span className="coach-status">{status}</span>}
            </div>
          ) : (
            <div className="coach-msg coach">
              <div className="coach-bubble coach-typing" aria-label="Coach is thinking">
                <span />
                <span />
                <span />
              </div>
              {status && <span className="coach-status">{status}</span>}
            </div>
          ))}
      </div>

      <form className="coach-input" onSubmit={onSubmit}>
        <textarea
          ref={inputEl}
          rows={1}
          value={draft}
          placeholder={context ? 'Ask the coach…' : 'Open a puzzle or a position first'}
          disabled={!context}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        <button type="submit" disabled={!draft.trim() || pending || !context} aria-label="Send">
          ➤
        </button>
      </form>
    </section>
  );
}
