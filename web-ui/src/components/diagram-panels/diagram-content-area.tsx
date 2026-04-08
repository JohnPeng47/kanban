import { FileText } from "lucide-react";
import type { ReactElement } from "react";

import { Spinner } from "@/components/ui/spinner";

export function DiagramContentArea({
	content,
	isLoading,
	error,
	selectedPath,
}: {
	content: string | null;
	isLoading: boolean;
	error: string | null;
	selectedPath: string | null;
}): ReactElement {
	if (!selectedPath) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-1 text-text-tertiary">
				<FileText size={40} />
				<span className="text-xs">Select a diagram from the tree</span>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-1">
				<Spinner size={24} />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface-1">
				<span className="text-sm text-status-red">{error}</span>
			</div>
		);
	}

	if (!content) {
		return <div className="flex flex-1 bg-surface-1" />;
	}

	return (
		<div className="flex flex-1 min-w-0 min-h-0 bg-surface-1">
			<iframe srcDoc={content} sandbox="allow-scripts" title="Diagram preview" className="flex-1 border-none" />
		</div>
	);
}
