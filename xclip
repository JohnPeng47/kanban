# Pi Extension System — Architecture Deep Dive

## Overview

Pi uses an **extension system** (not "plugins") to allow external code to hook into the coding agent. Extensions are TypeScript modules that declare capabilities and register callbacks — they never drive the system directly. The architecture enforces a **coupling boundary** between extensions and core internals through mediated API surfaces, two-phase initialization, and error isolation.

The core implementation lives in:
- [`packages/coding-agent/src/core/extensions/types.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) — all type definitions (~1400 lines)
- [`packages/coding-agent/src/core/extensions/loader.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts) — discovery, loading, `createExtensionAPI()`
- [`packages/coding-agent/src/core/extensions/runner.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts) — `ExtensionRunner`, lifecycle, event dispatch, `createContext()`

---

## Discovery and Loading

Extensions are auto-discovered from three locations:
1. **Global:** `~/.pi/agent/extensions/`
2. **Project-local:** `.pi/extensions/`
3. **Configured:** CLI flag `-e ./path.ts` or `settings.json`

Discovery rules (see [`loader.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts)):
- Direct files: `extensions/*.ts` or `*.js` → loaded immediately
- Subdirectories: `extensions/*/index.ts` or `index.js` → entry point
- Package manifests: `extensions/*/package.json` with `"pi"` field → follows declared paths

Extensions are loaded via `jiti` (TypeScript JIT compiler) — no build step required. The loader provides virtual modules so extensions can import `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`, etc. even in compiled Bun binaries.

See [`loader.ts:42-50`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts) for the virtual module map.

---

## The Extension Contract

Every extension exports a factory function:

```typescript
export default function (pi: ExtensionAPI) {
  // register tools, commands, event handlers, etc.
}
```

`ExtensionAPI` is defined at [`types.ts:988`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts). It is constructed per-extension by `createExtensionAPI()` at [`loader.ts:161`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts). The API has two categories of methods:

- **Registration methods** — write to the extension's isolated `Extension` object (its own `handlers` map, `tools` map, `commands` map, etc.)
- **Action methods** — delegate to a shared `ExtensionRuntime` object (`sendMessage`, `setModel`, `exec`, etc.)

The extension never holds a direct reference to `SessionManager`, `ModelRegistry`, the agent loop, or TUI internals.

---

## The Architectural Boundary

### What separates an extension from a core feature?

A core feature has direct access to `SessionManager`, `ModelRegistry`, TUI components, and the agent loop. An extension gets none of that — it gets the `ExtensionAPI` facade, which mediates all interaction.

This is **not primarily a security boundary** — extensions run in the same process with the same OS permissions. The real reasons are:

1. **The core can change without breaking extensions.** The facade is a versioning boundary. Internal refactors don't affect extensions as long as `ExtensionAPI` stays stable.

2. **Extensions can't accidentally break each other or the core.** Not maliciously — through bugs. An extension can't overwrite properties on internal objects, call methods in wrong order, or hold stale references. Error wrapping in the runner catches crashes without propagating them.

3. **Lifecycle ordering is the system's problem.** The two-phase stub trick means extensions load in any order, and the system activates everything at the right time.

4. **Non-interactive modes are free.** The `noOpUIContext` pattern means extension code works in interactive TUI, RPC, and print modes without conditionals.

### Two-Phase Initialization

When an extension factory runs, all action methods are **throwing stubs** ([`loader.ts:120-153`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts)):

```typescript
const notInitialized = () => {
  throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
};
```

Extensions can only **register** during load. They can't do anything yet. Later, `ExtensionRunner.bindCore()` ([`runner.ts:243`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts)) swaps the stubs with real implementations by mutating the shared `ExtensionRuntime`.

### `bindCore()` — The Wiring Moment

`bindCore` is called by `AgentSession` ([`agent-session.ts:2131`](../../../pi-mono/packages/coding-agent/src/core/agent-session.ts)). The core creates **closures over its own private state** and passes them as a bag of functions:

```typescript
runner.bindCore({
    sendMessage: (message, options) => {
      this.sendCustomMessage(message, options)...
    },
    appendEntry: (customType, data) => {
      this.sessionManager.appendCustomEntry(customType, data);
    },
    setSessionName: (name) => {
      this.sessionManager.appendSessionInfo(name);
    },
    getActiveTools: () => this.getActiveToolNames(),
    setModel: async (model) => {
      if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
      await this.setModel(model);
      return true;
    },
    // ...
}, {
    getModel: () => this.model,
    isIdle: () => !this.isStreaming,
    abort: () => this.abort(),
    // ...
})
```

The extension never gets `this.sessionManager` — it gets `(name) => this.sessionManager.appendSessionInfo(name)`. One narrow operation, not the whole object. Capability-based access through closures.

Similarly, `setUIContext()` ([`runner.ts:334`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts)) swaps the `noOpUIContext` for the real TUI context. Before this, all UI calls silently do nothing.

---

## The Three Integration Points

Extensions integrate with pi through three main callback patterns. Each has its own **registration interface** (how you declare it) and **calling interface** (what shape your handler takes when the system calls it).

### 1. Events

**Registration:** `pi.on(eventName, handler)`

**Calling interface:** `(event: E, ctx: ExtensionContext) => Promise<R | void>`

The lightest registration — just a name and a function. The system calls your handler when lifecycle moments occur. ~20+ event types including:

- **Session:** `session_start`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_tree`, `session_shutdown`
- **Agent:** `agent_start`, `agent_end`, `before_agent_start`, `before_provider_request`
- **Turns:** `turn_start`, `turn_end`
- **Messages:** `message_start`, `message_update`, `message_end`
- **Tools:** `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_end`
- **Input:** `input` (can transform or consume)
- **Resources:** `resources_discover`
- **Model:** `model_select`

Events share the `(event, ctx)` shape but are typed differently per event, with different return types. For example, `tool_call` handlers can return modifications, `input` handlers can transform input, `session_before_fork` can influence the fork.

See event type definitions starting at [`types.ts:407`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts).

### 2. Commands

**Registration:** `pi.registerCommand(name, { description?, handler, getArgumentCompletions? })`

**Calling interface:** `(args: string, ctx: ExtensionCommandContext) => Promise<void>`

User-facing slash commands (e.g., `/diff`, `/todos`). The handler receives `ExtensionCommandContext` ([`types.ts:300`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)), which extends `ExtensionContext` with session-control methods only safe in user-initiated contexts:

```typescript
interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  newSession(options?): Promise<{ cancelled: boolean }>;
  fork(entryId: string): Promise<{ cancelled: boolean }>;
  navigateTree(targetId, options?): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}
```

### 3. Tools

**Registration:** `pi.registerTool({ name, label, description, parameters, execute, renderCall?, renderResult?, promptSnippet?, promptGuidelines? })`

**Calling interface:** `(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback | undefined, ctx: ExtensionContext) => Promise<AgentToolResult>`

The heaviest registration shape — includes a TypeBox parameter schema, optional renderers, and prompt hints. The LLM decides when to invoke the tool; the system calls `execute` and passes `ctx` plus tool-specific arguments (`signal` for cancellation, `onUpdate` for streaming progress, typed `params`).

Tool definition type at [`types.ts:360`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts).

### Minor Integration Points

4. **Shortcuts** — `pi.registerShortcut(keyId, { handler })` — handler receives `ExtensionContext` on keypress
5. **Message renderers** — `pi.registerMessageRenderer(customType, renderer)` — passive rendering, no `ctx`
6. **Tool renderers** — `renderCall`/`renderResult` on tool definitions — passive rendering, no `ctx`
7. **Flags** — `pi.registerFlag(name, { type, default? })` — key-value config, read via `pi.getFlag(name)`
8. **Providers** — `pi.registerProvider(name, config)` — declarative AI provider registration

---

## `ExtensionContext` — The Runtime State

Defined as an interface at [`types.ts:265`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts). Constructed as a plain object literal by `ExtensionRunner.createContext()` at [`runner.ts:535`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts):

```typescript
createContext(): ExtensionContext {
    return {
        ui: this.uiContext,
        hasUI: this.hasUI(),
        cwd: this.cwd,
        sessionManager: this.sessionManager,    // ReadonlySessionManager
        modelRegistry: this.modelRegistry,
        get model() { return getModel(); },      // lazy getter
        isIdle: () => this.isIdleFn(),
        signal: this.getSignalFn(),
        abort: () => this.abortFn(),
        hasPendingMessages: () => this.hasPendingMessagesFn(),
        shutdown: () => this.shutdownHandler(),
        getContextUsage: () => this.getContextUsageFn(),
        compact: (options) => this.compactFn(options),
        getSystemPrompt: () => this.getSystemPromptFn(),
    };
}
```

Built fresh each time the runner dispatches an event. Every property delegates back to the runner's fields (set by `bindCore`). `model` is a lazy `get` so it reflects the current model at read time.

Note: `sessionManager` here is `ReadonlySessionManager` ([`session-manager.ts:183`](../../../pi-mono/packages/coding-agent/src/core/session-manager.ts)) — a `Pick<SessionManager, ...>` exposing only read methods (`getEntries`, `getBranch`, `getTree`, `getLabel`, etc.). Mutation goes through `pi.appendEntry()`, `pi.sendMessage()`, etc.

Where `pi` is "what the extension is" (stable for its lifetime), `ctx` is "what's happening now" (fresh per dispatch).

---

## The UI Layer

The UI is **not a separate integration point**. It's an action surface available via `ctx.ui` (`ExtensionUIContext`, [`types.ts:108`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) inside any event handler, command handler, or tool execute call.

### `ExtensionUIContext` — Full Interface

Defined at [`types.ts:108-242`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts):

```typescript
interface ExtensionUIContext {
    // === Ephemeral dialogs ===

    /** Show a selector and return the user's choice. */
    select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

    /** Show a confirmation dialog. */
    confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

    /** Show a text input dialog. */
    input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

    /** Show a notification to the user. */
    notify(message: string, type?: "info" | "warning" | "error"): void;

    /** Show a multi-line editor for text editing. */
    editor(title: string, prefill?: string): Promise<string | undefined>;

    /** Show a custom component with keyboard focus. */
    custom<T>(
        factory: (
            tui: TUI,
            theme: Theme,
            keybindings: KeybindingsManager,
            done: (result: T) => void,
        ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
        options?: {
            overlay?: boolean;
            overlayOptions?: OverlayOptions | (() => OverlayOptions);
            onHandle?: (handle: OverlayHandle) => void;
        },
    ): Promise<T>;

    // === Persistent layout mutations ===

    /** Set a custom footer component, or undefined to restore the built-in footer.
     *  Factory receives FooterDataProvider for git branch, extension statuses, etc. */
    setFooter(
        factory:
            | ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
            | undefined,
    ): void;

    /** Set a custom header component, or undefined to restore the built-in header. */
    setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

    /** Set a widget above or below the editor. Accepts string array or component factory. */
    setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
    setWidget(
        key: string,
        content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
        options?: ExtensionWidgetOptions,
    ): void;

    /** Replace the entire input editor, or undefined to restore the default.
     *  Extend CustomEditor from @mariozechner/pi-coding-agent for app keybinding support. */
    setEditorComponent(
        factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
    ): void;

    /** Set status text in the footer/status bar. Pass undefined to clear. */
    setStatus(key: string, text: string | undefined): void;

    /** Set the working/loading message shown during streaming. */
    setWorkingMessage(message?: string): void;

    /** Set the label shown for hidden thinking blocks. */
    setHiddenThinkingLabel(label?: string): void;

    /** Set the terminal window/tab title. */
    setTitle(title: string): void;

    // === Terminal input ===

    /** Listen to raw terminal input (interactive mode only). Returns unsubscribe function. */
    onTerminalInput(handler: TerminalInputHandler): () => void;

    // === Editor text manipulation ===

    /** Paste text into the editor, triggering paste handling. */
    pasteToEditor(text: string): void;

    /** Set the text in the core input editor. */
    setEditorText(text: string): void;

    /** Get the current text from the core input editor. */
    getEditorText(): string;

    // === Theme ===

    /** Get the current theme for styling. */
    readonly theme: Theme;

    /** Get all available themes with their names and file paths. */
    getAllThemes(): { name: string; path: string | undefined }[];

    /** Load a theme by name without switching to it. */
    getTheme(name: string): Theme | undefined;

    /** Set the current theme by name or Theme object. */
    setTheme(theme: string | Theme): { success: boolean; error?: string };

    // === Tool display ===

    /** Get current tool output expansion state. */
    getToolsExpanded(): boolean;

    /** Set tool output expansion state. */
    setToolsExpanded(expanded: boolean): void;
}
```

Dialog options support `signal` (AbortSignal for programmatic dismissal) and `timeout` (auto-dismiss with countdown). Widget placement is `"aboveEditor" | "belowEditor"` (defaults to above).

### Ephemeral vs Persistent vs Declarative

**Ephemeral** (shown then gone):
- `custom()` — overlay, dismissed when `done()` is called
- `select()`, `confirm()`, `input()`, `editor()` — dialogs, gone after user responds
- `notify()` — toast, disappears

**Persistent** (changes the default layout until explicitly reverted):
- `setFooter()`, `setHeader()`, `setWidget()`, `setEditorComponent()` — pass `undefined` to restore defaults
- `setStatus()`, `setWorkingMessage()`, `setHiddenThinkingLabel()`, `setTitle()` — pass `undefined` to clear

**Declarative** (on tool definitions, not on `ctx.ui`):
- `renderCall(args, theme, context) => Component` — how the tool call appears in the chat stream
- `renderResult(result, options, theme, context) => Component` — how the result appears

### Component Interface

Custom components returned from `ctx.ui.custom()` factories implement the TUI `Component` interface:
- `render(width: number): string[]` — return lines to paint
- `handleInput(data: string): void` — receive keypresses
- `invalidate(): void` — clear render cache

Components returned from persistent layout methods (`setFooter`, `setHeader`, `setWidget`) can also include a `dispose?(): void` method for cleanup.

### Mode Safety

Before `setUIContext()` is called, the runner holds a `noOpUIContext` ([`runner.ts:173`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts)) where every UI method silently does nothing. Extensions running in non-interactive modes (RPC, print) get this permanently. The `ctx.hasUI` boolean lets extensions check, but they don't have to — calling UI methods in non-interactive mode is safe (just no-ops).

---

## Flags

Defined at [`types.ts:1287`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts). Simple key-value state (boolean or string) stored on the shared `runtime.flagValues` map.

```typescript
pi.registerFlag("plan", {
  type: "boolean",
  default: false,
  description: "Start in plan mode",
});

// Read in any handler:
if (pi.getFlag("plan") === true) { ... }
```

Primary use case: CLI flags (`pi --flag plan=true`). Extensions accept configuration without inventing their own config parsing. An extension can only read flags it registered — `getFlag` checks ownership ([`loader.ts:216`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts)).

---

## Inversion of Control

Extensions never initiate — they register intent and the system calls them:

- An event handler says "when X happens, call me" — the runner decides when X happens
- A command says "when the user types /name, call me" — the system dispatches it
- A tool says "here's what I can do" — the LLM decides when to use it
- A component says "here's how I render and handle input" — the TUI render loop drives it

This is two layers of inversion:
1. **Extension → system**: "here's my handler" → system calls it at the right time
2. **Component → TUI**: "here's my render/handleInput" → TUI calls them during the render loop

---

## Late-Bound Method Injection — Walkthrough

The extension system uses **late-bound method injection**: the `ExtensionRuntime` object is created with throwing stubs, and `bindCore()` replaces them with real implementations by mutating the object's properties. Here's how that plays out concretely with the `modal-editor.ts` extension ([source](../../../pi-mono/packages/coding-agent/examples/extensions/modal-editor.ts)).

The entire extension:

```typescript
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
  });
}
```

### Step 1: Load phase

The loader discovers and imports the file via jiti, then calls the factory. `pi.on("session_start", handler)` stores the handler in the extension's `handlers` map ([`loader.ts:169`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts)):

```typescript
on(event: string, handler: HandlerFn): void {
    const list = extension.handlers.get(event) ?? [];
    list.push(handler);
    extension.handlers.set(event, list);
}
```

That's it. The handler is stored. The runtime is still all throwing stubs — but it doesn't matter, because no action methods were called. The extension only registered.

### Step 2: Bind phase

`AgentSession` calls `runner.bindCore(actions, contextActions)` ([`agent-session.ts:2131`](../../../pi-mono/packages/coding-agent/src/core/agent-session.ts)). The throwing stubs on `runtime` get replaced with real closures from the core. Still doesn't affect this extension — it hasn't tried to call any action methods.

Then `runner.setUIContext(uiContext)` ([`runner.ts:334`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts)) is called. The `noOpUIContext` is replaced with the real TUI-backed implementation. **This is the critical moment for modal-editor** — without it, `ctx.ui.setEditorComponent()` would silently no-op.

### Step 3: Session start — the handler fires

When a session starts, the runner dispatches the `session_start` event. It finds the handler registered in step 1 and calls:

```typescript
handler(event, this.createContext())
```

`createContext()` ([`runner.ts:535`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts)) builds a fresh `ExtensionContext`. The `ui` field is now the **real** UI context (not the no-op), because `setUIContext()` already ran in step 2:

```typescript
createContext(): ExtensionContext {
    return {
        ui: this.uiContext,   // ← real TUI context, late-bound during step 2
        hasUI: this.hasUI(),  // ← true
        // ...
    };
}
```

### Step 4: The handler executes

```typescript
(_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
}
```

`ctx.ui` is the real `ExtensionUIContext`. `setEditorComponent` receives a factory function and stores it. This is a **persistent layout mutation** — the default editor is now replaced.

### Step 5: The TUI calls the factory

The TUI needs to render the editor. It calls the stored factory:

```typescript
(tui, theme, kb) => new ModalEditor(tui, theme, kb)
```

This constructs a `ModalEditor` instance. From this point on, the TUI drives it — a second layer of inversion:

- **`render(width)`** — TUI calls this each render cycle. `ModalEditor` delegates to `super.render(width)` and appends the mode indicator (`NORMAL`/`INSERT`) to the bottom border.
- **`handleInput(data)`** — TUI calls this on every keypress. In insert mode, passes through to `super.handleInput(data)`. In normal mode, maps `hjkl` to cursor movements, `i`/`a` to switch to insert mode, etc.

### Why late binding matters here

At load time (step 1), the handler is just a function stored in a map. It closes over nothing real — `ctx` doesn't exist yet.

At dispatch time (step 3), `createContext()` reads `this.uiContext`, which was swapped from no-op to real during step 2. The `ctx` the handler receives has a live `ui` because the runner's internal field was late-bound.

If `setUIContext()` hadn't been called (e.g., in RPC mode), `this.uiContext` would still be `noOpUIContext`, and `setEditorComponent` would silently do nothing. **The extension code is identical in both cases** — the late binding absorbs the difference. The extension doesn't need to know what mode it's running in.

---

## Error Isolation

The `ExtensionRunner` wraps all handler calls with error catching and routes failures to error listeners ([`runner.ts:209`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts)) rather than crashing the host. A buggy extension cannot take down the session.

---

## Lifecycle Summary

1. **Load** — factory executes, registrations write to isolated `Extension` objects, action methods are throwing stubs, provider registrations are queued
2. **Bind** — `bindCore()` swaps stubs with real closures from `AgentSession`, provider registrations flushed to `ModelRegistry`
3. **UI Bind** — `setUIContext()` swaps `noOpUIContext` with real TUI context
4. **Command Bind** — `bindCommandContext()` wires session-control actions (`fork`, `navigateTree`, etc.)
5. **Runtime** — event handlers fire, tools callable by LLM, commands accessible via `/name`
6. **Shutdown** — `session_shutdown` event emitted, extensions perform cleanup

---

## Included Extensions

### Project-local (`.pi/extensions/` — active in this repo)
- `diff.ts` — git diff viewer with VS Code integration
- `files.ts` — file browser/manager
- `prompt-url-widget.ts` — widget for URL-based prompts
- `redraws.ts` — redraw performance monitoring
- `tps.ts` — tokens-per-second tracking

### Examples (`packages/coding-agent/examples/extensions/` — ~65 demos)
Notable examples:
- `hello.ts` — minimal tool registration
- `todo.ts` — tool + command + custom overlay + tool renderers + session state
- `git-checkpoint.ts` — multi-event lifecycle hooks + interactive UI + shell execution
- `modal-editor.ts` — custom editor replacement (event-based, persistent UI)
- `dynamic-tools.ts` — runtime tool creation via commands
- `snake.ts`, `space-invaders.ts` — games as TUI overlays
- `custom-provider-anthropic/` — AI provider registration
- `plan-mode/` — flags + tools + commands for a plan/execute workflow

### Recommended Reading

To understand the system comprehensively, read these two extensions together:

1. **`todo.ts`** ([source](../../../pi-mono/packages/coding-agent/examples/extensions/todo.ts)) — covers the registration surface: tools, commands, custom UI overlays, custom tool renderers, session-based state management, `ctx.hasUI` guards
2. **`git-checkpoint.ts`** ([source](../../../pi-mono/packages/coding-agent/examples/extensions/git-checkpoint.ts)) — covers the event surface: reacting to lifecycle moments (`tool_result`, `turn_start`, `session_before_fork`, `agent_end`), cross-event state, conditional interactive UI, shell execution via `pi.exec()`

Together they demonstrate every major pattern in the extension system.

---

## Key Source Files

| File | Purpose |
|------|---------|
| [`extensions/types.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | All type definitions — `ExtensionAPI`, `ExtensionContext`, `ToolDefinition`, events, UI context |
| [`extensions/loader.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts) | Discovery, jiti loading, `createExtensionRuntime()`, `createExtensionAPI()` |
| [`extensions/runner.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts) | `ExtensionRunner` — lifecycle, `bindCore()`, `createContext()`, event dispatch, error isolation |
| [`extensions/wrapper.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts) | Tool wrapping for agent integration |
| [`extensions/index.ts`](../../../pi-mono/packages/coding-agent/src/core/extensions/index.ts) | Public API exports |
| [`agent-session.ts:2131`](../../../pi-mono/packages/coding-agent/src/core/agent-session.ts) | Where `bindCore()` is called — the core hands closures to the extension runner |
| [`session-manager.ts:183`](../../../pi-mono/packages/coding-agent/src/core/session-manager.ts) | `ReadonlySessionManager` type definition |
