// Reading what a pi session said: the reply arrives as `agent_end.messages`.

interface AgentEndLike {
  type?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
}

/** The last assistant message's text blocks, joined. */
export function lastAssistantText(messages: AgentEndLike["messages"]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;

    const content = m.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;

    const text = content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c && typeof c === "object" && (c as { type?: string }).type === "text",
      )
      .map((c) => c.text)
      .join("\n");
    if (text.trim() !== "") return text;
  }
  return "";
}