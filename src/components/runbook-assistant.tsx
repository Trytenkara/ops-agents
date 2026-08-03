"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// In-app Ops assistant: a launcher (sidebar footer) + a right-side drawer that
// streams answers from /api/assistant. The route grounds the model in the ops
// docs and answers live questions via org-scoped read-only tools.

type Msg = { role: "user" | "assistant"; content: string };

const EXAMPLES = [
  "What's waiting for me right now?",
  "Which leads are ready to send?",
  "Where do I export a CSV?",
  "Why can't I promote this lead?",
];

export function RunbookAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    const next: Msg[] = [...messages, { role: "user", content: trimmed }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => "");
        throw new Error(err || `request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
      }
      if (!acc.trim()) {
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: "assistant", content: "(no response)" };
          return copy;
        });
      }
    } catch (e: any) {
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: "assistant", content: `Sorry — ${e?.message ?? "something went wrong"}.` };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the Ops assistant"
          className="group fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary backdrop-blur-md shadow-[0_0_25px_-3px_hsl(var(--primary)/0.55)] transition-all hover:bg-primary/20 hover:shadow-[0_0_34px_-2px_hsl(var(--primary)/0.8)]"
        >
          <span className="absolute inset-0 -z-10 rounded-full bg-primary/20 blur-md animate-pulse" aria-hidden="true" />
          <Sparkles className="h-4 w-4" />
          Assistant
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Ops assistant">
          <div className="flex-1 bg-foreground/20" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <HelpGlyph className="h-4 w-4" />
                <span className="font-serif text-lg">Ops assistant</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close assistant"
              >
                ✕
              </button>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Ask how Control Room works, what a status means, or what's waiting for you. Answers about your work are scoped to your clients.
                  </p>
                  <div className="space-y-1.5">
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => send(ex)}
                        className="block w-full rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-secondary"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="rounded-lg border border-border bg-background px-3.5 py-2.5">
                      {m.content ? (
                        <AssistantMarkdown text={m.content} />
                      ) : (
                        <span className="text-muted-foreground">{busy && i === messages.length - 1 ? "…" : ""}</span>
                      )}
                    </div>
                  )
                )
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-center gap-2 border-t border-border p-3"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask a question…"
                disabled={busy}
                className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy ? "…" : "Send"}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// Minimal, dependency-free, XSS-safe markdown for assistant replies: renders
// **bold**, `code`, headings, and bullet/numbered lists as React nodes (never
// innerHTML). Enough to make the model's output readable.
function inlineMd(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={k++} className="rounded bg-secondary px-1 py-0.5 text-[0.85em]">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function AssistantMarkdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inlineMd(it)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={key++} className="ml-4 list-decimal space-y-1">{items}</ol>
      ) : (
        <ul key={key++} className="ml-4 list-disc space-y-1">{items}</ul>
      )
    );
    list = null;
  };

  for (const line of text.split(/\n/)) {
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    const h = line.match(/^\s*(#{1,3})\s+(.*)/);
    if (ul) {
      if (!list || list.ordered) flush();
      (list ??= { ordered: false, items: [] }).items.push(ul[1]);
    } else if (ol) {
      if (!list || !list.ordered) flush();
      (list ??= { ordered: true, items: [] }).items.push(ol[1]);
    } else {
      flush();
      if (h) blocks.push(<div key={key++} className="mt-2 font-semibold">{inlineMd(h[2])}</div>);
      else if (line.trim()) blocks.push(<p key={key++}>{inlineMd(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>;
}

function HelpGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9.5 9.2a2.5 2.5 0 1 1 3.3 2.4c-.7.3-1.3.8-1.3 1.6v.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="16.5" r="0.9" fill="currentColor" />
    </svg>
  );
}
