import type { Scene } from "./rendering/scene";
import type { Rect } from "./types";

// ─── Source spans ──────────────────────────────────────────

/** A range in the source text (line/col, 0-based). */
export interface SourceSpan {
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
}

/** Parse a "startLine:startCol-endLine:endCol" string into a SourceSpan. */
export function parseSourceSpan(raw: string): SourceSpan | null {
	const match = raw.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
	if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
	return {
		startLine: Number.parseInt(match[1], 10),
		startCol: Number.parseInt(match[2], 10),
		endLine: Number.parseInt(match[3], 10),
		endCol: Number.parseInt(match[4], 10),
	};
}

// ─── Diagram metadata (parsed from data-* attrs on SVG) ───

export type EntityKind = "box" | "text";

/** A named entity from the diagram's entities block. */
export interface DiagramEntity {
	/** Entity ID, e.g. "EPO". */
	id: string;
	/** Human-readable name, e.g. "popup-overlay". */
	name: string;
	/** Whether this entity is a box or inline text. */
	kind: EntityKind;
	/** Description from the entities block. */
	description: string;
	/** Parent entity ID for hierarchy, or null if top-level. */
	parentId: string | null;
	/** Explicit link to the corresponding code-ref ID, e.g. "CPO". */
	codeRefId: string | null;
	/** Position of this entity in the ASCII source diagram. */
	sourceSpan: SourceSpan;
}

/** A directed connection between two entities. */
export interface DiagramArrow {
	/** Source entity ID (supports dotted sub-targets, e.g. "EPO.content"). */
	sourceId: string;
	/** Target entity ID. */
	targetId: string;
	/** Description of the connection. */
	description: string;
	/** Position of the drawn path in the ASCII source diagram. */
	sourceSpan: SourceSpan;
}

/** A source code reference mapped from the code-refs block. */
export interface DiagramCodeRef {
	/** Code-ref ID, e.g. "CPO". */
	id: string;
	/** File path relative to repo root. */
	filePath: string;
	/** Start line in the source file. */
	startLine: number;
	/** End line in the source file. */
	endLine: number;
	/** Human-readable label, e.g. "PopupDiagramOverlay component". */
	label: string;
}

/** A cross-diagram reference from the links block. */
export interface DiagramCrossLink {
	/** Local entity ID that links outward. */
	localId: string;
	/** Target diagram file path. */
	targetFile: string;
	/** Target entity ID on the other diagram. */
	targetId: string;
	/** Description of the link. */
	description: string;
}

/** All structured metadata for a diagram, assembled from SceneElement data-* attrs. */
export interface DiagramMetadata {
	entities: ReadonlyMap<string, DiagramEntity>;
	arrows: readonly DiagramArrow[];
	codeRefs: ReadonlyMap<string, DiagramCodeRef>;
	crossLinks: readonly DiagramCrossLink[];
	notes: readonly string[];
}

// ─── Open diagram (runtime, per-viewer) ────────────────────

/** A diagram that has been loaded and is available for interaction. */
export interface OpenDiagram {
	/** Relative path from diagrams root. */
	path: string;

	/** Raw ASCII source text (the diagram block only). */
	asciiSource: string;

	/** Parsed metadata from data-* attributes. */
	metadata: DiagramMetadata;

	/** Entity ID → SVG world bounds, populated after Scene is built. */
	svgBounds: ReadonlyMap<string, Rect>;
}

// ─── Assembly from Scene ───────────────────────────────────

const VALID_ENTITY_KINDS = new Set<EntityKind>(["box", "text"]);

function parseEntityKind(raw: string | undefined): EntityKind {
	if (raw && VALID_ENTITY_KINDS.has(raw as EntityKind)) {
		return raw as EntityKind;
	}
	return "text";
}

/** Parse a code-ref string like "src/foo.ts:10-50" into a DiagramCodeRef. */
function parseCodeRef(id: string, ref: string, label: string): DiagramCodeRef {
	const colonIndex = ref.lastIndexOf(":");
	if (colonIndex === -1) {
		return { id, filePath: ref, startLine: 1, endLine: 1, label };
	}
	const filePath = ref.slice(0, colonIndex);
	const lineSpec = ref.slice(colonIndex + 1);
	const dashIndex = lineSpec.indexOf("-");
	if (dashIndex === -1) {
		const line = Number.parseInt(lineSpec, 10);
		const l = Number.isFinite(line) ? line : 1;
		return { id, filePath, startLine: l, endLine: l, label };
	}
	const startLine = Number.parseInt(lineSpec.slice(0, dashIndex), 10);
	const endLine = Number.parseInt(lineSpec.slice(dashIndex + 1), 10);
	return {
		id,
		filePath,
		startLine: Number.isFinite(startLine) ? startLine : 1,
		endLine: Number.isFinite(endLine) ? endLine : 1,
		label,
	};
}

/**
 * Assemble DiagramMetadata by walking all SceneElements in a Scene.
 *
 * Reads the data-* attributes that the LLM embedded during ASCII→SVG conversion:
 * - data-entity-name, data-entity-kind, data-entity-desc, data-entity-parent, data-code-ref-id
 * - data-arrow-src, data-arrow-target, data-arrow-desc
 * - data-link-target-file, data-link-target-id, data-link-desc
 * - data-source-span
 */
export function assembleDiagramMetadata(scene: Scene): DiagramMetadata {
	const entities = new Map<string, DiagramEntity>();
	const arrows: DiagramArrow[] = [];
	const codeRefs = new Map<string, DiagramCodeRef>();
	const crossLinks: DiagramCrossLink[] = [];

	for (const [id, el] of scene.getAllElements()) {
		const m = el.metadata;

		// Entities: elements with data-entity-name
		if (m["entity-name"] && el.sourceSpan) {
			const entity: DiagramEntity = {
				id,
				name: m["entity-name"],
				kind: parseEntityKind(m["entity-kind"]),
				description: m["entity-desc"] ?? "",
				parentId: m["entity-parent"] ?? null,
				codeRefId: m["code-ref-id"] ?? null,
				sourceSpan: el.sourceSpan,
			};
			entities.set(id, entity);
		}

		// Code refs: elements with data-code-ref-id and data-ref
		if (m["code-ref-id"] && m.ref) {
			const label = m.label ?? id;
			codeRefs.set(m["code-ref-id"], parseCodeRef(m["code-ref-id"], m.ref, label));
		}

		// Arrows: elements with data-arrow-src and data-arrow-target
		if (m["arrow-src"] && m["arrow-target"] && el.sourceSpan) {
			arrows.push({
				sourceId: m["arrow-src"],
				targetId: m["arrow-target"],
				description: m["arrow-desc"] ?? "",
				sourceSpan: el.sourceSpan,
			});
		}

		// Cross-links: elements with data-link-target-file
		if (m["link-target-file"]) {
			crossLinks.push({
				localId: id,
				targetFile: m["link-target-file"],
				targetId: m["link-target-id"] ?? "",
				description: m["link-desc"] ?? "",
			});
		}
	}

	return { entities, arrows, codeRefs, crossLinks, notes: [] };
}

/** Build the svgBounds map for all entities in the metadata. */
export function buildSvgBoundsMap(scene: Scene, metadata: DiagramMetadata): ReadonlyMap<string, Rect> {
	const bounds = new Map<string, Rect>();
	for (const id of metadata.entities.keys()) {
		const el = scene.getElement(id);
		if (el) {
			bounds.set(id, scene.getWorldBounds(id));
		}
	}
	return bounds;
}
