import { FolderOpen } from "lucide-react";
import type { ReactElement } from "react";

type DiagramViewerFallbackReason = "no-diagrams-dir";

export function DiagramViewerFallback({ reason }: { reason: DiagramViewerFallbackReason }): ReactElement {
	const config = FALLBACK_CONFIG[reason];

	return (
		<div className="flex flex-1 items-center justify-center bg-surface-0 p-6">
			<div className="flex max-w-2xl flex-col items-center gap-3 text-center">
				<config.icon size={48} className={config.iconColor} />
				<h3 className="text-base font-semibold text-text-primary">{config.title}</h3>
				<p className="text-sm text-text-secondary">{config.subtitle}</p>
			</div>
		</div>
	);
}

const FALLBACK_CONFIG = {
	"no-diagrams-dir": {
		icon: FolderOpen,
		iconColor: "text-text-tertiary",
		title: "No diagrams directory",
		subtitle: "Create a diagrams/ folder in your workspace to get started.",
	},
} as const satisfies Record<
	DiagramViewerFallbackReason,
	{ icon: typeof FolderOpen; iconColor: string; title: string; subtitle: string }
>;
