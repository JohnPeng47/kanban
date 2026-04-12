import type { Scene } from "./rendering/scene";

/** Stub — reflow execution is not yet implemented on unified SceneElement.
 *  Returns null. Callers should check before accessing. */
export function useReflowEngine(_scene: Scene | null): null {
	return null;
}
