"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Notice } from "@/components/field";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { api, errorMessage, isUuid, newIdempotencyKey } from "@/lib/api";
import { formatTime } from "@/features/wallet/format";
import type { PageMeta } from "@/lib/types";

type Message = {
  id: string;
  conversationId: string;
  senderUserId: string;
  recipientUserId: string;
  content: string;
  createdAt: string;
};
type Conversation = {
  id: string;
  kind: "STUDENT_TUTOR" | "ADMIN_SUPPORT";
  lastMessage: Message | null;
  unreadCount: number;
  participants: Array<{ userId: string; displayName: string }>;
};
type ConversationPage = { items: Conversation[]; pagination: PageMeta };
type ThreadPage = {
  conversation: Conversation | null;
  items: Message[];
  nextCursor: string | null;
};

/** "11 Nov, 03:58" in Bangkok time, short enough for a chat bubble. */
function shortTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function Inbox() {
  const { account } = useAuth();
  const [view, setView] = useState<"STUDENT" | "TUTOR" | "ADMIN">("STUDENT");
  const [result, setResult] = useState<ConversationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setResult(
        await api<ConversationPage>(
          `/messages/inbox?page=1&pageSize=20&view=${view}`,
        ),
      );
    } catch (caught) {
      setResult(null);
      setError(errorMessage(caught, "Messages are unavailable right now."));
    } finally {
      setLoading(false);
    }
  }, [view]);
  useEffect(() => {
    void load();
  }, [load]);
  const views = [
    "STUDENT",
    account?.capabilities.includes("TUTOR") ? "TUTOR" : null,
    account?.capabilities.includes("ADMIN") ? "ADMIN" : null,
  ].filter(Boolean) as Array<"STUDENT" | "TUTOR" | "ADMIN">;
  return (
    <>
      <header className="page-heading">
        <h1>Messages</h1>
      </header>
      {views.length > 1 && (
        <div className="view-switch" role="group" aria-label="Message view">
          {views.map((value) => (
            <button
              key={value}
              className={`button ${view === value ? "" : "button-quiet"}`}
              onClick={() => setView(value)}
            >
              {value === "STUDENT"
                ? "As a student"
                : value === "TUTOR"
                  ? "As a tutor"
                  : "Support"}
            </button>
          ))}
        </div>
      )}
      {loading && <p role="status" className="tutor-card-meta">Loading conversations…</p>}
      {error && (
        <Notice kind="error">
          {error}{" "}
          <button className="button button-quiet" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      )}
      {result?.items.length === 0 && (
        <p className="tutor-card-meta">
          No conversations yet. Open a tutor profile to ask about a subject or lesson.
        </p>
      )}
      <div className="message-list">
        {result?.items.map((conversation) => {
          const other = conversation.participants.find(
            (participant) => participant.userId !== account?.id,
          );
          return (
            <Link
              className="message-row"
              key={conversation.id}
              href={`/messages/${other?.userId}?${new URLSearchParams({ view, ...(other?.displayName ? { name: other.displayName } : {}) })}`}
            >
              <span>
                <strong>{other?.displayName ?? "Conversation"}</strong>
                {conversation.lastMessage && (
                  <small>{conversation.lastMessage.content}</small>
                )}
              </span>
              <span>
                {conversation.unreadCount > 0 && (
                  <span
                    className="unread-badge"
                    aria-label={`${conversation.unreadCount} unread messages`}
                  >
                    {conversation.unreadCount}
                  </span>
                )}
                {conversation.lastMessage && (
                  <small>
                    {formatTime(conversation.lastMessage.createdAt)}
                  </small>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

export function MessagesPage() {
  return (
    <RequireAuth>
      <Inbox />
    </RequireAuth>
  );
}

function Thread({ userId }: { userId: string }) {
  const params = useSearchParams();
  const { account } = useAuth();
  const requestedView = params.get("view");
  const view =
    requestedView === "TUTOR" && account?.capabilities.includes("TUTOR")
      ? "TUTOR"
      : requestedView === "ADMIN" && account?.capabilities.includes("ADMIN")
        ? "ADMIN"
        : "STUDENT";
  const [thread, setThread] = useState<ThreadPage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [key, setKey] = useState(newIdempotencyKey());
  const scroller = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api<ThreadPage>(
        `/messages/thread/${userId}?view=${view}&limit=50`,
      );
      setThread(result);
      const latestUnread = [...result.items]
        .reverse()
        .find((message) => message.recipientUserId === account?.id);
      if (latestUnread)
        void api(`/messages/thread/${userId}/read?view=${view}`, {
          method: "PUT",
          body: { lastReadMessageId: latestUnread.id },
          idempotencyKey: newIdempotencyKey(),
        }).catch(() => setNotice("The conversation loaded, but its read status could not be updated."));
    } catch (caught) {
      setError(
        errorMessage(caught, "This conversation is unavailable right now."),
      );
    }
  }, [userId, view, account?.id]);
  useEffect(() => {
    if (isUuid(userId)) void load();
  }, [load, userId]);
  // Newest messages are at the bottom; keep them in view.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread?.items.length]);
  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const content = String(new FormData(form).get("content") ?? "").trim();
    if (!content) {
      setError("Write a message before sending.");
      form.querySelector("textarea")?.focus();
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api<Message>("/messages", {
        method: "POST",
        body: { recipientId: userId, view, content },
        idempotencyKey: key,
      });
      form.reset();
      setKey(newIdempotencyKey());
      await load();
    } catch (caught) {
      setError(errorMessage(caught, "We couldn’t send your message."));
    } finally {
      setPending(false);
    }
  }
  if (!isUuid(userId))
    return (
      <section className="panel">
        <h1 style={{ fontSize: 22 }}>We couldn’t find that conversation.</h1>
      </section>
    );
  const other = thread?.conversation?.participants.find(
    (participant) => participant.userId !== account?.id,
  );
  return (
    <>
      <header className="page-heading">
        <h1>{other?.displayName ?? params.get("name")?.slice(0, 80) ?? "Conversation"}</h1>
      </header>
      {error && (
        <Notice kind="error">
          {error}{" "}
          {!thread && (
            <button className="button button-quiet" onClick={() => void load()}>
              Try again
            </button>
          )}
        </Notice>
      )}
      {notice && <Notice kind="success">{notice}</Notice>}
      {!thread && !error && <p role="status" className="tutor-card-meta">Loading conversation…</p>}
      {thread && (
        <section className="panel chat">
          <div className="thread" ref={scroller} aria-live="polite">
            {thread.items.length === 0 && (
              <p className="chat-empty">No messages yet. Say hello below.</p>
            )}
            {thread.items.map((message) => (
              <article
                key={message.id}
                className={`message-bubble ${message.senderUserId === account?.id ? "own" : ""}`}
              >
                <p>{message.content}</p>
                <time dateTime={message.createdAt}>{shortTime(message.createdAt)}</time>
              </article>
            ))}
          </div>
          <form className="chat-composer" onSubmit={send}>
            <textarea
              id="content"
              name="content"
              aria-label="Message"
              placeholder="Write a message"
              rows={1}
              maxLength={2000}
              required
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button className="button" disabled={pending}>
              {pending ? "Sending…" : "Send"}
            </button>
          </form>
        </section>
      )}
    </>
  );
}

export function MessageThreadPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = use(params);
  return (
    <RequireAuth>
      <Thread userId={userId} />
    </RequireAuth>
  );
}
