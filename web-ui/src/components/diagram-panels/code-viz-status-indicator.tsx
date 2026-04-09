import * as RadixPopover from "@radix-ui/react-popover";
import { Circle, Plug, PlugZap } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import type { CodeVizConnectionState } from "@/hooks/use-code-viz-status";

const stateConfig: Record<CodeVizConnectionState, { label: string; dotClass: string; description: string }> = {
	connected: {
		label: "Code Viz",
		dotClass: "text-status-green",
		description: "Connected — click-to-navigate is active.",
	},
	"workspace-not-registered": {
		label: "Code Viz",
		dotClass: "text-status-orange",
		description: "Extension is running but this workspace is not open in a VSCode window with Code Viz active.",
	},
	disconnected: {
		label: "Code Viz",
		dotClass: "text-text-tertiary",
		description: "Extension is not reachable. Click-to-navigate is unavailable.",
	},
};

export function CodeVizStatusIndicator({ state }: { state: CodeVizConnectionState }): ReactElement {
	const config = stateConfig[state];
	const Icon = state === "connected" ? PlugZap : Plug;

	return (
		<RadixPopover.Root>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary",
						"hover:bg-surface-3 transition-colors",
					)}
				>
					<Icon size={13} className={config.dotClass} />
					<span>{config.label}</span>
					<Circle size={6} className={cn("fill-current", config.dotClass)} />
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="end"
					sideOffset={6}
					className="z-50 w-72 rounded-lg border border-border bg-surface-2 p-3 shadow-lg"
				>
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							<Circle size={8} className={cn("fill-current shrink-0", config.dotClass)} />
							<span className="text-xs font-medium text-text-primary">
								{state === "connected"
									? "Connected"
									: state === "workspace-not-registered"
										? "Workspace Not Registered"
										: "Disconnected"}
							</span>
						</div>
						<p className="text-xs text-text-secondary leading-relaxed">{config.description}</p>
						{state === "disconnected" && (
							<p className="text-xs text-text-tertiary leading-relaxed">
								Install the Code Viz Navigator extension in VSCode and ensure the server is running.
							</p>
						)}
						{state === "workspace-not-registered" && (
							<p className="text-xs text-text-tertiary leading-relaxed">
								Open this project folder in VSCode with the Code Viz extension enabled.
							</p>
						)}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
