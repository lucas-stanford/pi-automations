interface AgentEndLike {
    type?: string;
    messages?: Array<{
        role?: string;
        content?: unknown;
    }>;
}
/** The last assistant message's text blocks, joined. */
export declare function lastAssistantText(messages: AgentEndLike["messages"]): string;
export {};
