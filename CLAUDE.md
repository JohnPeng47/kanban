@AGENTS.md

## Building

The global `kanban` binary is symlinked to this repo via `npm link`. Every time you need to build, run the full build so changes are reflected in the global binary:

```
cd /home/john/kanban && npm run build
```

This compiles TypeScript, builds the web-ui with Vite, and bundles the CLI — all in one step. Do not skip this or run partial builds.

If there are any root-owned folders in this directory just run chown to change to your current user