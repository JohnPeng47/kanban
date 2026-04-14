┌─────────────────────────────────────────────────────────────────┐
│  Browser (web-ui)                                               │
│                                                                 │
│  App.tsx ──(?view=diagram)──→ DiagramViewer                     │
│                                   │                             │
│                        ┌──────────┼──────────┐                  │
│                        │          │          │                  │
│                   TreePanel  ContentArea  AgentPanel             │
│                        │          │          │                  │
│               useDiagramViewer  useDiagram  useDiagramAgentPanel│
│                   │                              │              │
│                   ▼                              ▼              │
│              TRPC Client                    ClineAgent          │
│                   │                                             │
└───────────────────┼─────────────────────────────────────────────┘
                    │ HTTP
┌───────────────────┼─────────────────────────────────────────────┐
│  Node.js Server   │                                             │
│                   ▼                                             │
│             TRPC Router (app-router.ts)                         │
│                   │                                             │
│             diagrams-api.ts                                     │l
│              ├── listDiagrams ──→ fs.readdir({workspace}/diagrams/)
│              ├── getDiagramContent ──→ fs.readFile (HTML, 5MB max)
│              ├── navigateToDiagramSource ──→ CodeVizClient       │
│              └── checkExtensionStatus ──→ CodeVizClient          │
│                                              │                  │
└──────────────────────────────────────────────┼──────────────────┘
                                               │ HTTP :24680
┌──────────────────────────────────────────────┼──────────────────┐
│  Code Viz VSCode Extension (optional)        │                  │
│                                              ▼                  │
│              /api/health  ← checkHealth()                       │
│              /api/workspaces ← checkWorkspace(path)             │
│              /api/navigate ← navigate(root, file, line, newTab) │
└─────────────────────────────────────────────────────────────────┘
