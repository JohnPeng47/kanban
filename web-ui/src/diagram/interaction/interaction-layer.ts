import type { InteractiveElement, InteractiveElementRegistry } from "./interactive-registry";
import type { Scene } from "../rendering/scene";
import { isExpandable } from "../rendering/scene";
import type { Point } from "../types";
import { type ExtensionCallEvent, ExtensionCallRegistry } from "./extension-call-registry";

const DRAG_THRESHOLD = 4;
const ZOOM_SENSITIVITY = 0.002;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;

export class InteractionLayer {
	private scene: Scene | null = null;
	private interactiveRegistry: InteractiveElementRegistry | null = null;
	readonly extensionCalls = new ExtensionCallRegistry();

	private selectedIds = new Set<string>();
	private container: HTMLElement | null = null;

	// Pointer tracking
	private pointerDownPos: Point | null = null;
	private didDrag = false;
	private isPanning = false;
	private panStartTransform = { tx: 0, ty: 0, scale: 1 };

	// Selection rectangle
	private selectionRect: HTMLDivElement | null = null;

	// Bound handlers (for removal)
	private boundOnPointerDown: ((e: PointerEvent) => void) | null = null;
	private boundOnPointerMove: ((e: PointerEvent) => void) | null = null;
	private boundOnPointerUp: ((e: PointerEvent) => void) | null = null;
	private boundOnWheel: ((e: WheelEvent) => void) | null = null;

	initialize(scene: Scene, interactiveRegistry: InteractiveElementRegistry): void {
		this.scene = scene;
		this.interactiveRegistry = interactiveRegistry;
		this.container = scene.getRenderElement();

		this.boundOnPointerDown = this.onPointerDown.bind(this);
		this.boundOnPointerMove = this.onPointerMove.bind(this);
		this.boundOnPointerUp = this.onPointerUp.bind(this);
		this.boundOnWheel = this.onWheel.bind(this);

		this.container.addEventListener("pointerdown", this.boundOnPointerDown);
		this.container.addEventListener("pointermove", this.boundOnPointerMove);
		this.container.addEventListener("pointerup", this.boundOnPointerUp);
		this.container.addEventListener("wheel", this.boundOnWheel, { passive: false });
	}

	destroy(): void {
		if (this.container) {
			if (this.boundOnPointerDown) this.container.removeEventListener("pointerdown", this.boundOnPointerDown);
			if (this.boundOnPointerMove) this.container.removeEventListener("pointermove", this.boundOnPointerMove);
			if (this.boundOnPointerUp) this.container.removeEventListener("pointerup", this.boundOnPointerUp);
			if (this.boundOnWheel) this.container.removeEventListener("wheel", this.boundOnWheel);
		}
		this.removeSelectionRect();
		this.extensionCalls.clear();
		this.selectedIds.clear();
		this.scene = null;
		this.interactiveRegistry = null;
		this.container = null;
	}

	getSelectedIds(): Set<string> {
		return new Set(this.selectedIds);
	}

	getSelectedElements(): InteractiveElement[] {
		if (!this.interactiveRegistry) return [];
		return Array.from(this.selectedIds)
			.map((id) => this.interactiveRegistry!.get(id))
			.filter((el): el is InteractiveElement => el != null);
	}

	// ─── Pointer Events ──────────────────────────────────────

	private onPointerDown(event: PointerEvent): void {
		if (!this.scene || !this.container) return;
		if (event.button !== 0) return; // left button only

		this.pointerDownPos = { x: event.clientX, y: event.clientY };
		this.didDrag = false;

		// Check if we hit a scene element
		const scenePoint = this.scene.screenToScene({ x: event.clientX, y: event.clientY });
		const hitId = this.scene.hitTest(scenePoint);

		if (hitId) {
			// Clicked on an element — prepare for click or drag
			this.isPanning = false;
		} else {
			// Clicked on empty space — start panning
			this.isPanning = true;
			this.panStartTransform = { ...this.scene.getRoot().transform };
			this.container.setPointerCapture(event.pointerId);
		}
	}

	private onPointerMove(event: PointerEvent): void {
		if (!this.scene || !this.container || !this.pointerDownPos) return;

		const dx = event.clientX - this.pointerDownPos.x;
		const dy = event.clientY - this.pointerDownPos.y;
		const distance = Math.sqrt(dx * dx + dy * dy);

		if (!this.didDrag && distance > DRAG_THRESHOLD) {
			this.didDrag = true;

			// If not panning (started on an element), start selection instead
			if (!this.isPanning) {
				this.isPanning = true;
				this.panStartTransform = { ...this.scene.getRoot().transform };
				this.container.setPointerCapture(event.pointerId);
			}
		}

		if (this.didDrag && this.isPanning) {
			this.scene.setTransform("root", {
				tx: this.panStartTransform.tx + dx,
				ty: this.panStartTransform.ty + dy,
				scale: this.panStartTransform.scale,
			});
		}
	}

	private onPointerUp(event: PointerEvent): void {
		if (!this.scene || !this.container) {
			this.pointerDownPos = null;
			return;
		}

		if (this.isPanning) {
			this.container.releasePointerCapture(event.pointerId);
		}

		// If it was a click (not a drag), handle element interaction
		if (!this.didDrag && this.pointerDownPos) {
			const scenePoint = this.scene.screenToScene({ x: event.clientX, y: event.clientY });
			const hitId = this.scene.hitTest(scenePoint);
			this.handleClick(hitId, event);
		}

		this.pointerDownPos = null;
		this.didDrag = false;
		this.isPanning = false;
	}

	private handleClick(elementId: string | null, event: PointerEvent): void {
		if (!this.scene || !this.interactiveRegistry) return;

		if (!elementId) {
			// Clicked empty space — clear selection
			this.clearSelection();
			return;
		}

		const element = this.scene.getElement(elementId);
		const interactive = this.interactiveRegistry.get(elementId);

		// Update selection
		if (interactive) {
			if (event.shiftKey) {
				this.toggleSelection(elementId);
			} else {
				this.selectOnly(elementId);
			}
		} else {
			this.clearSelection();
		}

		// Build event
		const callEvent = this.buildCallEvent("click", elementId, event);

		// Fire click extension calls
		this.extensionCalls.fire("click", callEvent);

		// Fire expand if applicable
		if (element && isExpandable(element)) {
			this.extensionCalls.fire("expand", { ...callEvent, trigger: "expand" });
		}
	}

	// ─── Wheel Zoom ──────────────────────────────────────────

	private onWheel(event: WheelEvent): void {
		if (!this.scene || !this.container) return;
		event.preventDefault();

		const root = this.scene.getRoot();
		const { tx, ty, scale } = root.transform;

		// Compute new scale
		const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : ZOOM_SENSITIVITY);
		const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (1 + delta)));

		// Zoom toward cursor position
		const containerRect = this.container.getBoundingClientRect();
		const cursorX = event.clientX - containerRect.left;
		const cursorY = event.clientY - containerRect.top;

		// The point under the cursor should stay fixed
		const newTx = cursorX - (cursorX - tx) * (newScale / scale);
		const newTy = cursorY - (cursorY - ty) * (newScale / scale);

		this.scene.setTransform("root", { tx: newTx, ty: newTy, scale: newScale });
	}

	// ─── Selection Management ────────────────────────────────

	private selectOnly(id: string): void {
		const changed = this.selectedIds.size !== 1 || !this.selectedIds.has(id);
		this.clearSelectionVisuals();
		this.selectedIds.clear();
		this.selectedIds.add(id);
		this.applySelectionVisual(id, true);
		if (changed) this.fireSelectionChange();
	}

	private toggleSelection(id: string): void {
		if (this.selectedIds.has(id)) {
			this.selectedIds.delete(id);
			this.applySelectionVisual(id, false);
		} else {
			this.selectedIds.add(id);
			this.applySelectionVisual(id, true);
		}
		this.fireSelectionChange();
	}

	private clearSelection(): void {
		if (this.selectedIds.size === 0) return;
		this.clearSelectionVisuals();
		this.selectedIds.clear();
		this.fireSelectionChange();
	}

	private applySelectionVisual(id: string, selected: boolean): void {
		const renderEl = this.scene?.getRenderElement();
		if (!renderEl) return;
		const selector = `[data-reflow-group="${id}"], [data-interactive="${id}"], [data-arrow]`;
		const g = renderEl.querySelector(selector);
		if (g) {
			g.classList.toggle("selected", selected);
		}
	}

	private clearSelectionVisuals(): void {
		for (const id of this.selectedIds) {
			this.applySelectionVisual(id, false);
		}
	}

	private fireSelectionChange(): void {
		const callEvent = this.buildCallEvent("select", null, null);
		this.extensionCalls.fire("select", callEvent);
	}

	// ─── Selection Rectangle (for future drag-select) ──────

	private removeSelectionRect(): void {
		if (this.selectionRect) {
			this.selectionRect.remove();
			this.selectionRect = null;
		}
	}

	// ─── Helpers ─────────────────────────────────────────────

	private buildCallEvent(
		trigger: "click" | "select" | "expand",
		elementId: string | null,
		domEvent: PointerEvent | null,
	): ExtensionCallEvent {
		const element = elementId ? this.scene?.getElement(elementId) : null;
		const interactive = elementId ? (this.interactiveRegistry?.get(elementId) ?? null) : null;

		return {
			trigger,
			elementId,
			metadata: element?.metadata ?? null,
			interactiveElement: interactive,
			selectedIds: new Set(this.selectedIds),
			selectedElements: this.getSelectedElements(),
			domEvent,
		};
	}
}
