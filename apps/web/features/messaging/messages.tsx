"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
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
      <header className="section-heading">
        <p className="eyebrow">CONVERSATIONS</p>
        <h1>Messages</h1>
        <p>Keep lesson questions and tutor conversations together.</p>
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
      {loading && <p role="status">Loading conversations…</p>}
      {error && (
        <Notice kind="error">
          {error}{" "}
          <button className="button button-quiet" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      )}
      {result?.items.length === 0 && (
        <section className="empty-state">
          <h2>No conversations yet</h2>
          <p>Open a tutor profile to ask about a subject or lesson.</p>
          <Link className="button" href="/discover">
            Find a tutor
          </Link>
        </section>
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
              href={`/messages/${other?.userId}?view=${view}`}
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
      setNotice("Message sent.");
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
        <h1>We couldn’t find that conversation.</h1>
        <Link className="button" href="/messages">
          Back to messages
        </Link>
      </section>
    );
  const other = thread?.conversation?.participants.find(
    (participant) => participant.userId !== account?.id,
  );
  return (
    <>
      <p>
        <Link className="text-link" href="/messages">
          ← All messages
        </Link>
      </p>
      <header className="section-heading">
        <p className="eyebrow">CONVERSATION</p>
        <h1>{other?.displayName ?? "New conversation"}</h1>
        <p>Messages are visible only to the participants in this thread.</p>
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
      {!thread && !error && <p role="status">Loading conversation…</p>}
      {thread && (
        <section className="panel">
          <div className="thread" aria-live="polite">
            {thread.items.length === 0 && (
              <p className="empty-state">
                No messages yet. Start the conversation below.
              </p>
            )}
            {thread.items.map((message) => (
              <article
                key={message.id}
                className={`message-bubble ${message.senderUserId === account?.id ? "own" : ""}`}
              >
                <p>{message.content}</p>
                <time dateTime={message.createdAt}>
                  {formatTime(message.createdAt)}
                </time>
              </article>
            ))}
          </div>
          <form className="form" onSubmit={send}>
            <div className="field">
              <label htmlFor="content">Message</label>
              <textarea
                id="content"
                name="content"
                rows={4}
                maxLength={2000}
                required
              />
            </div>
            <button className="button" disabled={pending}>
              {pending ? "Sending…" : "Send message"}
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
