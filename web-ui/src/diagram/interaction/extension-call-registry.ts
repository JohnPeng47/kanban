import type { InteractiveElement } from "./interactive-registry";
import type { InteractiveCategory } from "../types";

export interface ExtensionCallEvent {
	trigger: "click" | "select" | "expand";
	elementId: string | null;
	metadata: Record<string, string> | null;
	interactiveElement: InteractiveElement | null;
	selectedIds: Set<string>;
	selectedElements: InteractiveElement[];
	domEvent: PointerEvent | null;
}

export interface ExtensionCall {
	name: string;
	trigger: "click" | "select" | "expand";
	categoryFilter?: InteractiveCategory[];
	handler: (event: ExtensionCallEvent) => void;
}

/** Registry for application-defined extension calls.
 *  Works with zero handlers — all fire() calls are no-ops on an empty registry. */
export class ExtensionCallRegistry {
	private calls = new Map<string, ExtensionCall>();

	register(call: ExtensionCall): void {
		this.calls.set(call.name, call);
	}

	unregister(name: string): void {
		this.calls.delete(name);
	}

	fire(trigger: "click" | "select" | "expand", event: ExtensionCallEvent): void {
		for (const call of this.calls.values()) {
			if (call.trigger !== trigger) continue;

			// Apply category filter if present
			if (call.categoryFilter && event.interactiveElement) {
				if (!call.categoryFilter.includes(event.interactiveElement.category)) {
					continue;
				}
			}

			call.handler(event);
		}
	}

	clear(): void {
		this.calls.clear();
	}
}
