┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Browser (web-ui)                                                                                        │
│                                                                                                          │
│  App.tsx ──(?view=diagram)──→ DiagramViewer                                                              │
│                                   │                                                                      │
│                        ┌──────────┼──────────┐                                                           │
│                        │          │          │                                                           │
│                   TreePanel  ContentArea  AgentPanel                                                      │
│                        │          │          │                                                           │
│               useDiagramViewer    │    useDiagramAgentPanel                                               │
│                   │               │          │                                                           │
│                   │    ┌──────────┴──────────────────────────────────────────────────────────────┐        │
│                   │    │  DiagramContentArea                                                     │        │
│                   │    │                                                                         │        │
│                   │    │  props: content, isLoading, error, selectedPath,                        │        │
│                   │    │         workspaceId, workspacePath, onRequestJump,                      │        │
│                   │    │         pendingJumpElementId, onJumpConsumed                            │        │
│                   │    │                                                                         │        │
│                   │    │         useDiagram(content) ──→ Scene                                   │        │
│                   │    │                                   │                                     │        │
│                   │    │              ┌────────────────────┤  (or: empty / loading / error)       │        │
│                   │    │              ▼                    │                                     │        │
│                   │    │         DiagramScene              │                                     │        │
│                   │    │              │                    │                                     │        │
│                   │    │   ┌──────────┼──────────────┐     │                                     │        │
│                   │    │   │          │              │     │                                     │        │
│                   │    │  SceneInput  PopupOverlay  ContextMenu                                  │        │
│                   │    │   │           │             └─ add badge                                │        │
│                   │    │   ├─ Viewport │                                                         │        │
│                   │    │   ├─ hit test ├─ backdrop                                               │        │
│                   │    │   ├─ select   ├─ PopupScene ──→ SceneInput                              │        │
│                   │    │   ├─ tooltip  └─ (stacked)                                              │        │
│                   │    │   └─ badges                                                             │        │
│                   │    │                                                                         │        │
│                   │    │  Navigation: Alt+click/default → fireCodeJump ──┐                       │        │
│                   │    │              modal → openPopup                  │                       │        │
│                   │    │              link  → executeJump                │                       │        │
│                   │    └────────────────────────────────────────────────┼──────────────────────┘        │
│                   │                                                     │                              │
│                   ▼                                                     ▼                              │
│              TRPC Client ◄──────────────────────────────────────────────┘                              │
│                   │                                                                                    │
│                   │                                                  ClineAgent ◄── useDiagramAgentPanel│
│                   │                                                                                    │
└───────────────────┼────────────────────────────────────────────────────────────────────────────────────┘
                    │ HTTP
┌───────────────────┼─────────────────────────────────────────────────────┐
│  Node.js Server   │                                                     │
│                   ▼                                                     │
│             TRPC Router (app-router.ts)                                 │
│                   │                                                     │
│             diagrams-api.ts                                             │
│              ├── listDiagrams ──→ fs.readdir({workspace}/diagrams/)     │
│              ├── getDiagramContent ──→ fs.readFile (HTML, 5MB max)      │
│              ├── navigateToDiagramSource ──→ CodeVizClient              │
│              └── checkExtensionStatus ──→ CodeVizClient                 │
│                                              │                          │
└──────────────────────────────────────────────┼──────────────────────────┘
                                               │ HTTP :24680
┌──────────────────────────────────────────────┼──────────────────────────┐
│  Code Viz VSCode Extension (optional)        │                          │
│                                              ▼                          │
│              /api/health  ← checkHealth()                               │
│              /api/workspaces ← checkWorkspace(path)                     │
│              /api/navigate ← navigate(root, file, line, newTab)         │
└─────────────────────────────────────────────────────────────────────────┘
