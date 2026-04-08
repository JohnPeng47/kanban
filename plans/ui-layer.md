# UI Layer - Diagram Viewer

## Overview

Component breakdown for the diagram viewer page, maximizing reuse of existing kanban UI primitives.

---

## 1. Page Layout

```
+------------------------------------------------------------------+
|  TopBar  [... existing buttons ...]  [Diagram toggle button]     |
+------------------------------------------------------------------+
|  Diagram Tree Panel  |  ResizeHandle  |  Diagram Content Area    |
|  (left, ~250px)      |  (draggable)   |  (fills remaining)       |
|                      |                |                           |
|  layout3/            |                |  [DiagramRenderer]        |
|    scheduler-detail/ |                |  (iframe for HTML/SVG     |
|      base.html *     |                |   or <pre> for ASCII)     |
|      message-ch..    |                |                           |
|    commit-phases/    |                |                           |
|      01-begin..      |                |                           |
|    dom-tree.txt      |                |                           |
|    fiber-tree.txt    |                |                           |
+------------------------------------------------------------------+
```

**When an error/fallback state is active**, the tree + resize + content area are replaced entirely by a centered fallback (see Section 3.5).

---

## 2. Component Tree

```
<DiagramViewer>                          # Page root (new)
  {hasFallback ? (
    <DiagramViewerFallback />            # Full-area error state (new)
  ) : (
    <div className="flex flex-1">
      <DiagramTreePanel />               # Left panel (new)
      <ResizeHandle />                   # REUSE from @/resize/resize-handle
      <DiagramContentArea />             # Right panel (new, placeholder for now)
    </div>
  )}
</DiagramViewer>
```

---

## 3. Component Details

### 3.1 `DiagramViewer` (page root)

**File**: `web-ui/src/components/diagram-viewer.tsx`

**Props**:
```ts
{
  workspaceId: string;
  diagramViewer: UseDiagramViewerResult; // from the single hook
}
```

**Behavior**:
- Checks for fallback conditions first (no diagrams dir, extension unavailable)
- If fallback: renders `<DiagramViewerFallback reason={...} />`
- Otherwise: horizontal flex layout with tree panel, resize handle, content area
- Uses `useDiagramViewerLayout()` for persisted panel ratios (called inside the hook)

**Reuses**:
- `ResizeHandle` from `@/resize/resize-handle`
- `useResizeDrag` from `@/resize/use-resize-drag`
- Layout persistence via `local-storage-store.ts`

---

### 3.2 `DiagramTreePanel` (left sidebar)

**File**: `web-ui/src/components/diagram-panels/diagram-tree-panel.tsx`

**Props**:
```ts
{
  tree: RuntimeDiagramNode[];
  selectedPath: string | null;
  expandedFolders: Set<string>;
  onSelectPath: (path: string) => void;
  onToggleFolder: (path: string) => void;
  isLoading: boolean;
  panelFlex?: string;
}
```

**Behavior**:
- Renders a recursive tree of diagram files/folders
- Folders are **collapsible** (click toggles expand/collapse) - improves on the existing `FileTreePanel` which always shows all children
- Files are selectable (highlight + load content)
- Partial tree: only shows the `diagrams/` subtree, not the full repo

**Styling** (reuses existing patterns):
- Background: `bg-surface-0` (matches `FileTreePanel`)
- Selected row: `bg-accent text-white` (matches `kb-file-tree-row-selected`)
- Hover: `bg-surface-3`
- Icons: `Folder` / `FolderOpen` / `FileText` from `lucide-react` (same as `FileTreePanel`)
- Additional icons: `ChevronRight` / `ChevronDown` for folder expand indicators
- Depth indentation: `paddingLeft: depth * 16 + 8` (slightly more than the 12px in FileTreePanel for the chevron)

**Reuses**:
- `Folder`, `FolderOpen`, `FileText`, `ChevronRight`, `ChevronDown` from `lucide-react`
- `Spinner` from `@/components/ui/spinner` for loading state
- `cn` from `@/components/ui/cn` for conditional classes
- File type detection pattern from `buildFileTree` in `@/utils/file-tree`

**Empty state**: Same pattern as `FileTreePanel` - centered `FolderOpen` icon with tertiary text "No diagrams found"

---

### 3.3 `DiagramTreeRow` (recursive tree node)

**Inline in** `diagram-tree-panel.tsx` (not exported, same pattern as `FileTreeRow` in `file-tree-panel.tsx`)

**Renders**:
```tsx
<button className={rowClassName} style={{ paddingLeft: depth * 16 + 8 }}>
  {isDirectory && (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
  {isDirectory ? (isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />) : <FileText size={14} />}
  <span className="truncate">{node.name}</span>
  {contentTypeTag}  {/* small badge: "HTML" / "SVG" / "TXT" */}
</button>
```

**Content type badge**: Small `text-[10px]` tag showing the file type. Uses:
- `text-status-blue` for HTML
- `text-status-purple` for SVG
- `text-text-tertiary` for TXT

---

### 3.4 `DiagramContentArea` (right panel - placeholder)

**File**: `web-ui/src/components/diagram-panels/diagram-content-area.tsx`

This is the **placeholder** for the actual diagram renderer that will be implemented separately. For now:

**States**:
1. **No selection**: Centered empty state with icon + "Select a diagram from the tree"
2. **Loading**: Centered `<Spinner size={24} />`
3. **Error**: Inline error display (`text-status-red`, centered) for file-not-found or size errors
4. **Content loaded**: Delegates to the diagram renderer (future component)

**Temporary implementation**:
- For HTML/SVG content: render in a sandboxed `<iframe srcDoc={content} />` with appropriate styles
- For TXT content: render in a `<pre>` block with `font-mono text-sm text-text-primary bg-surface-1 p-4 overflow-auto`

**Reuses**:
- `Spinner` from `@/components/ui/spinner`
- Surface/text design tokens for styling

---

### 3.5 `DiagramViewerFallback` (full-area error/empty states)

**File**: `web-ui/src/components/diagram-panels/diagram-viewer-fallback.tsx`

Replaces the **entire diagram viewer content area** (tree + resize handle + content) when a blocking condition is detected. Follows the visual pattern established by `RuntimeDisconnectedFallback` and `KanbanAccessBlockedFallback`.

**Props**:
```ts
{
  reason: "no-diagrams-dir" | "extension-unavailable" | "workspace-not-registered";
}
```

**Layout**: Centered flex container filling the viewer slot. Matches `KanbanAccessBlockedFallback` structure exactly:
```tsx
<div className="flex flex-1 items-center justify-center bg-surface-0 p-6">
  <div className="flex max-w-2xl flex-col items-center gap-3 text-center">
    <Icon size={48} className={iconColor} />
    <h3 className="text-base font-semibold text-text-primary">{title}</h3>
    <p className="text-sm text-text-secondary">{subtitle}</p>
  </div>
</div>
```

**States**:

| Reason | Icon | Icon Color | Title | Subtitle |
|---|---|---|---|---|
| `no-diagrams-dir` | `FolderOpen` | `text-text-tertiary` | "No diagrams directory" | "Create a `diagrams/` folder in your workspace to get started." |
| `extension-unavailable` | `Unplug` | `text-status-orange` | "Code Viz extension is not running" | "Start the Code Viz extension in VSCode to enable diagram navigation." |
| `workspace-not-registered` | `AlertCircle` | `text-status-orange` | "Workspace not open in VSCode" | "Open this workspace in VSCode with the Code Viz extension active." |

**Priority in `DiagramViewer`**: Checked in order — `no-diagrams-dir` first (if there are no diagrams, extension status is irrelevant), then extension status.

**Note**: Extension-related fallbacks (`extension-unavailable`, `workspace-not-registered`) should NOT block viewing diagrams entirely. If the user just wants to browse ASCII diagrams without click-to-navigate, the tree + content should still work. These fallbacks should instead render as a **dismissible banner** at the top of the viewer, not a full replacement. The `no-diagrams-dir` fallback remains full-area since there's nothing to show.

---

## 4. Existing Components Reused

| Component | From | Used For |
|---|---|---|
| `Button` | `@/components/ui/button` | TopBar toggle button, potential toolbar actions |
| `Tooltip` | `@/components/ui/tooltip` | Button tooltips in top bar |
| `Spinner` | `@/components/ui/spinner` | Loading states (tree + content) |
| `cn` | `@/components/ui/cn` | Conditional class composition |
| `ResizeHandle` | `@/resize/resize-handle` | Draggable divider between tree and content |
| `useResizeDrag` | `@/resize/use-resize-drag` | Resize interaction logic |
| `showAppToast` | `@/components/app-toaster` | Navigate error toasts |

---

## 5. Lucide Icons Used

| Icon | Purpose |
|---|---|
| `Network` or `LayoutDashboard` | TopBar toggle button (diagram viewer) |
| `Folder` / `FolderOpen` | Directory nodes in tree + no-diagrams fallback |
| `FileText` | File nodes in tree |
| `ChevronRight` / `ChevronDown` | Expand/collapse indicators |
| `Unplug` | Extension unavailable fallback |
| `AlertCircle` | Workspace not registered fallback |

---

## 6. CSS / Styling Notes

- **No new CSS classes in globals.css needed** - everything is achievable with Tailwind utilities + existing design tokens
- Tree row hover/selected states use `cn()` for conditional classes rather than CSS overrides
- The existing `kb-file-tree-row` / `kb-file-tree-row-selected` classes from `globals.css` can be reused directly if we want visual consistency with the file tree in card detail view, or we can use Tailwind equivalents for a slightly different feel (recommended: Tailwind for new code)
- Panel background: `bg-surface-0` (consistent with existing panels)
- Content area background: `bg-surface-1` (raised, like the git history diff panel)
- Fallback states: `bg-surface-0` with centered content (matches existing full-page fallbacks)

---

## 7. Responsive Behavior

- Tree panel has a minimum width (~180px) enforced by the resize clamp function
- Content area fills remaining space with `flex: 1`
- Tree text truncates with `truncate` class on long file names
- Content area scrolls independently (both axes for diagrams)
