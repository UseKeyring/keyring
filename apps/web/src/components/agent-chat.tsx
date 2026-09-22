"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@keyring/ui/components/button";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import { useMyOrganization } from "@/hooks/useOrganization";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type AgentChatProps = {
  context: "role" | "action" | "user";
  onActionComplete?: (data: { intent: string; data: unknown }) => void;
  className?: string;
  embedded?: boolean;
};

const PLACEHOLDERS: Record<AgentChatProps["context"], string> = {
  role: "Describe the role and who should have it…",
  action: "Describe the action and how it should be grouped…",
  user: "Describe the user to add…",
};

/*
 * Cloned from Polar's AIProductChat:
 * clients/apps/web/src/app/(main)/dashboard/[organization]/(header)/products/new/ai/AIProductChat.tsx
 * - rounded-3xl chat card, message list only once messages exist
 * - auto-growing textarea (min-h-[72px]) with Create/Send pill button
 * - user messages right-aligned bubbles, assistant messages full-width plain text
 */
export function AgentChat({ context, onActionComplete, className = "", embedded = false }: AgentChatProps) {
  const { orgId } = useMyOrganization();
  const [isOpen, setIsOpen] = useState(embedded);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea like Polar
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  // Scroll the message list itself — never scrollIntoView(), which yanks
  // every scrollable ancestor (dashboard main, page) and pushes content up.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading || !orgId) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);

    try {
      // Forward the short-lived access token: the server route builds a
      // per-request user-scoped client from it (localStorage sessions never
      // reach cookies, so the route can't see them otherwise).
      const { data: sessionData } = await getSupabaseBrowserClient().auth.getSession();
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          organizationId: orgId,
          context,
          conversationHistory: messages,
          accessToken: sessionData.session?.access_token ?? undefined,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);

        if (data.intent && onActionComplete) {
          onActionComplete({ intent: data.intent, data: data.data });
        }
      } else if (response.status === 401) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response ?? "You're signed out — please refresh the page and sign in again." },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Sorry, something went wrong: ${data.error}` },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I couldn't process that request. Please try again." },
      ]);
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) sendMessage();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) sendMessage();
    }
  };

  if (!isOpen) {
    return (
      <Button
        onClick={() => setIsOpen(true)}
        className={`fixed bottom-6 right-6 z-50 rounded-full shadow-lg ${className}`}
        size="lg"
      >
        <SolarIcon name="wand" className="h-5 w-5" />
        <span className="ml-2">Create with AI</span>
      </Button>
    );
  }

  const containerClass = embedded
    ? `w-full ${className}`
    : `fixed bottom-6 right-6 z-50 w-full max-w-md ${className}`;

  return (
    <div className={containerClass}>
      <div className="flex flex-col gap-y-4">
        <div
          className={`flex flex-col overflow-hidden rounded-3xl bg-white dark:bg-polar-900 ${
            embedded ? "" : "shadow-xl"
          }`}
        >
          {(messages.length > 0 || isLoading) && (
            <div
              ref={messagesRef}
              className="flex max-h-[640px] min-h-0 flex-1 flex-col gap-y-6 overflow-y-auto rounded-t-3xl border border-b-0 border-hairline p-6 dark:border-polar-700"
            >
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`flex flex-col gap-y-1 ${
                    message.role === "user" ? "items-end" : "items-start"
                  }`}
                >
                  {message.role === "user" ? (
                    <div className="rounded-2xl bg-pillar px-4 py-2 text-sm text-ink dark:bg-polar-800 dark:text-white">
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    </div>
                  ) : (
                    <div className="w-full text-sm text-ink dark:text-white">
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    </div>
                  )}
                </div>
              ))}
              {isLoading && (
                <div className="flex flex-col items-start gap-y-1">
                  <div className="w-full text-sm text-ink-muted">Thinking…</div>
                </div>
              )}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="flex shrink-0 flex-col gap-3 overflow-hidden rounded-b-3xl border border-hairline first:rounded-t-3xl dark:border-polar-700"
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              placeholder={messages.length === 0 ? PLACEHOLDERS[context] : "Reply…"}
              rows={1}
              className="max-h-[240px] min-h-[72px] resize-none overflow-y-auto border-none bg-transparent px-6 pt-5 pb-0 text-sm text-ink shadow-none outline-none placeholder:text-ink-muted focus:outline-none focus-visible:outline-none disabled:opacity-50 dark:text-white"
            />
            <div className="flex items-center justify-end gap-2 px-4 pb-4">
              <Button type="submit" disabled={isLoading || !input.trim()}>
                {isLoading ? "Creating…" : messages.length === 0 ? "Create" : "Send"}
                <SolarIcon name="arrowUpRight" className="h-4 w-4" />
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
