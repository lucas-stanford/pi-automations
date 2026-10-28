// Reading what a pi session said: the reply arrives as `agent_end.messages`.
/** The last assistant message's text blocks, joined. */
export function lastAssistantText(messages) {
    if (!Array.isArray(messages))
        return "";
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== "assistant")
            continue;
        const content = m.content;
        if (typeof content === "string")
            return content;
        if (!Array.isArray(content))
            continue;
        const text = content
            .filter((c) => !!c && typeof c === "object" && c.type === "text")
            .map((c) => c.text)
            .join("\n");
        if (text.trim() !== "")
            return text;
    }
    return "";
}
//# sourceMappingURL=session.js.map