import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { TurnWireEvent } from "./pi/ui-stream.ts";

// Vulpin page images are model evidence, not transcript previews. Its tool has
// no custom image renderer: the generic trace already displays this notice.
// Keep the full vision evidence in the store/agent; send only the existing
// presentation to browsers. Other plugins' image-renderer contracts stay intact.
const PAGE_IMAGE_TOOL = "vulpin_read_pages";

function browserPageResult<T extends { content: (TextContent | ImageContent)[] }>(result: T): T {
	if (!Array.isArray(result?.content) || !result.content.some(block => block.type === "image")) return result;
	return {
		...result,
		content: result.content.map(block => block.type === "image"
			? { type: "text" as const, text: `[Image attached to the model: ${block.mimeType}]` }
			: block),
	};
}

export function browserMessage<T extends AgentMessage>(message: T): T {
	if (message.role !== "toolResult" || message.toolName !== PAGE_IMAGE_TOOL) return message;
	return browserPageResult(message as T & { content: (TextContent | ImageContent)[] });
}

export function browserMessages<T extends AgentMessage>(messages: readonly T[]): T[] {
	return messages.map(message => browserMessage(message));
}

/** Project only at HTTP/SSE serialization; never change the turn's native log. */
export function browserTurnEvent(event: TurnWireEvent): TurnWireEvent {
	switch (event.type) {
		case "message_start":
		case "message_update":
		case "message_end":
			return { ...event, message: browserMessage(event.message) };
		case "tool_execution_update":
			return event.toolName === PAGE_IMAGE_TOOL
				? { ...event, partialResult: browserPageResult(event.partialResult) } : event;
		case "tool_execution_end":
			return event.toolName === PAGE_IMAGE_TOOL
				? { ...event, result: browserPageResult(event.result) } : event;
		case "turn_end":
			return { ...event, message: browserMessage(event.message), toolResults: browserMessages(event.toolResults) };
		case "agent_end":
			return { ...event, messages: browserMessages(event.messages) };
		default:
			return event;
	}
}
