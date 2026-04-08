import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
	RuntimeDiagramContentRequest,
	RuntimeDiagramContentResponse,
	RuntimeDiagramListRequest,
	RuntimeDiagramListResponse,
	RuntimeDiagramNavigateRequest,
	RuntimeDiagramNavigateResponse,
	RuntimeDiagramExtensionStatusResponse,
	RuntimeDiagramNode,
} from "../core/api-contract";
import { codeVizClient } from "../diagram-providers/code-viz-client";

const MAX_DIAGRAM_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

function resolveDiagramsRoot(workspacePath: string): string {
	return path.join(workspacePath, "diagrams");
}

function isPathSafe(resolvedPath: string, boundary: string): boolean {
	const normalizedResolved = path.resolve(resolvedPath);
	const normalizedBoundary = path.resolve(boundary);
	return normalizedResolved.startsWith(normalizedBoundary + path.sep) || normalizedResolved === normalizedBoundary;
}

function hasUnsafeSegments(inputPath: string): boolean {
	return inputPath.includes("\0") || inputPath.split(path.sep).some((segment) => segment === "..");
}

async function buildDiagramTree(dirPath: string, relativeTo: string): Promise<RuntimeDiagramNode[]> {
	const entries = await readdir(dirPath, { withFileTypes: true });
	const nodes: RuntimeDiagramNode[] = [];

	for (const entry of entries) {
		const entryPath = path.join(dirPath, entry.name);
		const relPath = path.relative(relativeTo, entryPath);

		if (entry.isDirectory()) {
			const children = await buildDiagramTree(entryPath, relativeTo);
			if (children.length > 0) {
				nodes.push({
					name: entry.name,
					path: relPath,
					type: "directory",
					children,
				});
			}
		} else if (entry.isFile() && entry.name.endsWith(".html")) {
			nodes.push({
				name: entry.name,
				path: relPath,
				type: "file",
				children: [],
			});
		}
	}

	nodes.sort((a, b) => {
		if (a.type === b.type) {
			return a.name.localeCompare(b.name);
		}
		return a.type === "directory" ? -1 : 1;
	});

	return nodes;
}

export async function listDiagrams(
	workspacePath: string,
	input: RuntimeDiagramListRequest,
): Promise<RuntimeDiagramListResponse> {
	const diagramsRoot = resolveDiagramsRoot(workspacePath);

	try {
		const rootStat = await stat(diagramsRoot);
		if (!rootStat.isDirectory()) {
			return { diagramsRoot, diagramsRootExists: false, tree: [] };
		}
	} catch {
		return { diagramsRoot, diagramsRootExists: false, tree: [] };
	}

	const targetDir = input.root ? path.join(diagramsRoot, input.root) : diagramsRoot;

	if (input.root) {
		if (hasUnsafeSegments(input.root)) {
			throw new Error("Invalid path");
		}
		if (!isPathSafe(targetDir, diagramsRoot)) {
			throw new Error("Invalid path");
		}
	}

	const tree = await buildDiagramTree(targetDir, diagramsRoot);
	return { diagramsRoot, diagramsRootExists: true, tree };
}

export async function getDiagramContent(
	workspacePath: string,
	input: RuntimeDiagramContentRequest,
): Promise<RuntimeDiagramContentResponse> {
	if (hasUnsafeSegments(input.path)) {
		throw new Error("Invalid path");
	}

	const diagramsRoot = resolveDiagramsRoot(workspacePath);
	const fullPath = path.join(diagramsRoot, input.path);

	if (!isPathSafe(fullPath, diagramsRoot)) {
		throw new Error("Invalid path");
	}

	const fileStat = await stat(fullPath);
	if (!fileStat.isFile()) {
		throw new Error("Not a file");
	}
	if (fileStat.size > MAX_DIAGRAM_FILE_SIZE) {
		throw new Error("File too large");
	}

	const content = await readFile(fullPath, "utf-8");
	return { path: input.path, contentType: "html", content };
}

export async function navigateToDiagramSource(
	input: RuntimeDiagramNavigateRequest,
): Promise<RuntimeDiagramNavigateResponse> {
	return codeVizClient.navigate(input);
}

export async function checkDiagramExtensionStatus(
	workspacePath: string,
): Promise<RuntimeDiagramExtensionStatusResponse> {
	const health = await codeVizClient.checkHealth();
	if (!health) {
		return { available: false, workspaceRegistered: false };
	}

	const registered = await codeVizClient.checkWorkspace(workspacePath);
	return {
		available: true,
		workspaceRegistered: registered,
		error: registered
			? undefined
			: "This workspace is not open in a VSCode window with Code Viz active.",
	};
}
