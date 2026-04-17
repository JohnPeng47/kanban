import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): vscode.Uri {
	const folders = vscode.workspace.workspaceFolders;
	assert.ok(folders && folders.length > 0, "No workspace folder");
	return folders[0]!.uri;
}

async function waitUntil(
	predicate: () => Promise<boolean> | boolean,
	timeoutMs = 10000,
	intervalMs = 200,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

async function readFile(uri: vscode.Uri): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return Buffer.from(bytes).toString("utf-8");
}

async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
}

async function deleteFile(uri: vscode.Uri): Promise<void> {
	await vscode.workspace.fs.delete(uri);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function uri(...segments: string[]): vscode.Uri {
	return vscode.Uri.joinPath(getWorkspaceRoot(), ...segments);
}

/** Copy a file within the workspace. */
async function copyFile(src: vscode.Uri, dest: vscode.Uri): Promise<void> {
	const content = await readFile(src);
	await writeFile(dest, content);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_DIAGRAM = `\`\`\`diagram
┌─ Viewport ─────────────────────────┐
│                                     │
│  transformDiv (CSS transform)       │
│  OverLayer (absolute, z:10)         │
│    resolveAnchor(anchor, t, scene)  │
│                                     │
└─────────────────────────────────────┘
\`\`\`
`;

const SAMPLE_ANCHORS = `# anchor-text                          code-ref                                                  label
Viewport                                src/example.ts:1-10                                        Viewport component
transformDiv                            src/example.ts:3-5                                         transformDiv element
OverLayer                               src/example.ts:7-10                                        OverLayer component
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diagfren Extension", () => {
	let ext: vscode.Extension<unknown>;

	before(async () => {
		ext = vscode.extensions.getExtension("kanban.diagfren")!;
		assert.ok(ext, "Extension not found — check publisher.name in package.json");
		if (!ext.isActive) {
			await ext.activate();
		}
		// Give watchers a moment to initialize
		await new Promise((r) => setTimeout(r, 500));
	});

	// Restore sample fixture after each test in case a test mutated it
	afterEach(async () => {
		const sampleTxt = uri("diagrams", "sample.txt");
		const sampleAnchors = uri(".diagfren", "diagrams", "sample.anchors");
		await writeFile(sampleTxt, SAMPLE_DIAGRAM);
		await writeFile(sampleAnchors, SAMPLE_ANCHORS);
		// Small delay for watchers to settle
		await new Promise((r) => setTimeout(r, 300));
	});

	// ------------------------------------------------------------------
	// #12 — Orphan pruning on delete
	// ------------------------------------------------------------------
	describe("Orphan pruning on delete", () => {
		it("deletes the .diagfren/ sidecar when the .txt file is deleted", async () => {
			const tempTxt = uri("diagrams", "temp-delete.txt");
			const tempAnchors = uri(".diagfren", "diagrams", "temp-delete.anchors");

			// Create temp diagram + sidecar
			await writeFile(tempTxt, SAMPLE_DIAGRAM);
			await writeFile(tempAnchors, SAMPLE_ANCHORS);
			assert.ok(await fileExists(tempAnchors), "Sidecar should exist before delete");

			// Let the file watcher register the new file
			await new Promise((r) => setTimeout(r, 1000));

			// Delete the diagram
			await deleteFile(tempTxt);

			// Wait for watcher to clean up the sidecar
			await waitUntil(async () => !(await fileExists(tempAnchors)), 15000);
			assert.ok(!(await fileExists(tempAnchors)), "Sidecar should be deleted after .txt deletion");
		});
	});

	// ------------------------------------------------------------------
	// #13 & #14 — Stale anchor pruning on edit
	// ------------------------------------------------------------------
	describe("Stale anchor pruning on edit", () => {
		it("removes anchors whose text no longer appears in the diagram", async () => {
			const tempTxt = uri("diagrams", "temp-edit.txt");
			const tempAnchors = uri(".diagfren", "diagrams", "temp-edit.anchors");

			await writeFile(tempTxt, SAMPLE_DIAGRAM);
			await writeFile(tempAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 300));

			// Remove "OverLayer" from the diagram but keep Viewport and transformDiv
			const edited = SAMPLE_DIAGRAM.replace(
				"│  OverLayer (absolute, z:10)         │",
				"│  SomeOtherThing (absolute, z:10)    │",
			);
			await writeFile(tempTxt, edited);

			// Wait for watcher to prune
			await waitUntil(async () => {
				const content = await readFile(tempAnchors);
				return !content.includes("OverLayer");
			});

			const result = await readFile(tempAnchors);
			assert.ok(result.includes("Viewport"), "Viewport anchor should survive");
			assert.ok(result.includes("transformDiv"), "transformDiv anchor should survive");
			assert.ok(!result.includes("OverLayer"), "OverLayer anchor should be pruned");

			// Cleanup
			await deleteFile(tempTxt);
			await waitUntil(async () => !(await fileExists(tempAnchors)));
		});

		it("keeps survivors when only some anchors become stale", async () => {
			const tempTxt = uri("diagrams", "temp-partial.txt");
			const tempAnchors = uri(".diagfren", "diagrams", "temp-partial.anchors");

			await writeFile(tempTxt, SAMPLE_DIAGRAM);
			await writeFile(tempAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 300));

			// Remove both OverLayer and transformDiv, keep only Viewport
			const edited = SAMPLE_DIAGRAM
				.replace("│  OverLayer (absolute, z:10)         │", "│  Replaced1 (absolute, z:10)         │")
				.replace("│  transformDiv (CSS transform)       │", "│  Replaced2 (CSS transform)          │");
			await writeFile(tempTxt, edited);

			await waitUntil(async () => {
				const content = await readFile(tempAnchors);
				return !content.includes("OverLayer") && !content.includes("transformDiv");
			});

			const result = await readFile(tempAnchors);
			assert.ok(result.includes("Viewport"), "Viewport anchor should survive");
			assert.ok(!result.includes("transformDiv"), "transformDiv should be pruned");
			assert.ok(!result.includes("OverLayer"), "OverLayer should be pruned");

			// Cleanup
			await deleteFile(tempTxt);
			await waitUntil(async () => !(await fileExists(tempAnchors)));
		});
	});

	// ------------------------------------------------------------------
	// #15 — Sidecar deletion only when diagram block is removed
	// ------------------------------------------------------------------
	describe("Sidecar lifecycle with diagram block", () => {
		it("keeps the sidecar when all anchor text is removed but diagram block exists", async () => {
			const tempTxt = uri("diagrams", "temp-allgone.txt");
			const tempAnchors = uri(".diagfren", "diagrams", "temp-allgone.anchors");

			await writeFile(tempTxt, SAMPLE_DIAGRAM);
			await writeFile(tempAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 300));

			// Replace all anchor text but keep the diagram block
			const edited = SAMPLE_DIAGRAM
				.replace("Viewport", "AAAA")
				.replace("transformDiv", "BBBB")
				.replace("OverLayer", "CCCC");
			await writeFile(tempTxt, edited);

			// Wait for pruning to complete
			await waitUntil(async () => {
				const content = await readFile(tempAnchors);
				return !content.includes("Viewport");
			});

			// Sidecar should still exist (just no data anchors)
			assert.ok(await fileExists(tempAnchors), "Sidecar should NOT be deleted when diagram block still exists");

			// Cleanup
			await deleteFile(tempTxt);
			await waitUntil(async () => !(await fileExists(tempAnchors)));
		});

		it("deletes the sidecar when the diagram block itself is removed", async () => {
			const tempTxt = uri("diagrams", "temp-noblock.txt");
			const tempAnchors = uri(".diagfren", "diagrams", "temp-noblock.anchors");

			await writeFile(tempTxt, SAMPLE_DIAGRAM);
			await writeFile(tempAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 300));

			// Remove the entire diagram block
			await writeFile(tempTxt, "This file no longer has a diagram block.\n");

			await waitUntil(async () => !(await fileExists(tempAnchors)));
			assert.ok(!(await fileExists(tempAnchors)), "Sidecar should be deleted when diagram block is removed");

			// Cleanup
			await deleteFile(tempTxt);
		});
	});

	// ------------------------------------------------------------------
	// #16 — Startup orphan sweep
	// ------------------------------------------------------------------
	describe("Startup orphan sweep", () => {
		it("pruneOrphanedSidecars deletes sidecars with no matching .txt", async () => {
			const { pruneOrphanedSidecars } = await import("../anchor-cache");

			// Create an orphaned sidecar with no matching .txt
			const orphanAnchors = uri(".diagfren", "diagrams", "nonexistent.anchors");
			await writeFile(orphanAnchors, SAMPLE_ANCHORS);
			assert.ok(await fileExists(orphanAnchors), "Orphan sidecar should exist before sweep");

			// Run the sweep
			await pruneOrphanedSidecars();

			assert.ok(!(await fileExists(orphanAnchors)), "Orphaned sidecar should be deleted after sweep");
		});

		it("pruneOrphanedSidecars preserves sidecars with matching .txt", async () => {
			const { pruneOrphanedSidecars } = await import("../anchor-cache");

			// sample.txt exists and has a sidecar — it should survive
			const sampleAnchors = uri(".diagfren", "diagrams", "sample.anchors");
			assert.ok(await fileExists(sampleAnchors), "Sample sidecar should exist before sweep");

			await pruneOrphanedSidecars();

			assert.ok(await fileExists(sampleAnchors), "Sample sidecar should survive the sweep");
		});
	});

	// ------------------------------------------------------------------
	// #18 — Commits ago
	// ------------------------------------------------------------------
	describe("Commits ago", () => {
		it("reports correct commit distance for a tracked file", async () => {
			// The test workspace has 3 commits:
			// 1. "initial: add example source" (src/example.ts)
			// 2. "add sample diagram with anchors" (diagrams/sample.txt)
			// 3. "update example source" (src/example.ts)
			//
			// So diagrams/sample.txt was last touched 1 commit ago.
			// We can't call getCommitsAgo directly (it's not exported from the extension),
			// but we can verify via child_process the same way the status page does.
			const cp = await import("child_process");
			const util = await import("util");
			const execFile = util.promisify(cp.execFile);

			const cwd = getWorkspaceRoot().fsPath;
			const { stdout: lastHash } = await execFile("git", ["log", "-1", "--format=%H", "--", "diagrams/sample.txt"], { cwd });
			assert.ok(lastHash.trim(), "Should find a commit for diagrams/sample.txt");

			const { stdout: countStr } = await execFile("git", ["rev-list", "--count", `${lastHash.trim()}..HEAD`], { cwd });
			const count = parseInt(countStr.trim(), 10);
			assert.strictEqual(count, 1, "diagrams/sample.txt should be 1 commit ago");
		});

		it("returns empty hash for untracked files", async () => {
			const cp = await import("child_process");
			const util = await import("util");
			const execFile = util.promisify(cp.execFile);

			const cwd = getWorkspaceRoot().fsPath;
			const { stdout: lastHash } = await execFile("git", ["log", "-1", "--format=%H", "--", "diagrams/does-not-exist.txt"], { cwd });
			assert.strictEqual(lastHash.trim(), "", "Untracked file should have no commit hash");
		});
	});

	// ------------------------------------------------------------------
	// #21 — FileSystemWatcher on .diagfren/
	// ------------------------------------------------------------------
	describe("FileSystemWatcher on .diagfren/", () => {
		it("cache updates when a .anchors sidecar is modified", async () => {
			const tempTxt = uri("diagrams", "temp-watch.txt");
			const tempAnchors = uri(".diagfren", "diagrams", "temp-watch.anchors");

			// Create diagram + sidecar with 1 anchor
			await writeFile(tempTxt, SAMPLE_DIAGRAM);
			await writeFile(tempAnchors, `# anchor-text  code-ref          label\nViewport        src/example.ts:1  Viewport\n`);
			await new Promise((r) => setTimeout(r, 500));

			// Open the diagram to trigger cache load
			const doc = await vscode.workspace.openTextDocument(tempTxt);
			await vscode.window.showTextDocument(doc);
			await new Promise((r) => setTimeout(r, 500));

			// Now add another anchor to the sidecar
			await writeFile(tempAnchors, SAMPLE_ANCHORS);

			// The watcher should refresh the cache. Verify by requesting links.
			// We can check by opening the document and getting definition results.
			await waitUntil(async () => {
				// Re-fetch links — the provider reads from cache
				const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
					"vscode.executeLinkProvider",
					doc.uri,
				);
				// Original had only Viewport occurrences, now should also have transformDiv + OverLayer
				return (links?.length ?? 0) >= 3;
			}, 10000);

			const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
				"vscode.executeLinkProvider",
				doc.uri,
			);
			assert.ok((links?.length ?? 0) >= 3, `Expected >=3 links after sidecar update, got ${links?.length ?? 0}`);

			// Cleanup
			await vscode.commands.executeCommand("workbench.action.closeAllEditors");
			await deleteFile(tempTxt);
			await waitUntil(async () => !(await fileExists(tempAnchors)));
		});
	});

	// ------------------------------------------------------------------
	// File rename handling
	// ------------------------------------------------------------------
	describe("File rename handling", () => {
		it("moves sidecar when a diagram .txt file is renamed", async () => {
			const oldTxt = uri("diagrams", "temp-rename-src.txt");
			const newTxt = uri("diagrams", "temp-rename-dst.txt");
			const oldAnchors = uri(".diagfren", "diagrams", "temp-rename-src.anchors");
			const newAnchors = uri(".diagfren", "diagrams", "temp-rename-dst.anchors");

			// Create diagram + sidecar
			await writeFile(oldTxt, SAMPLE_DIAGRAM);
			await writeFile(oldAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 500));

			assert.ok(await fileExists(oldAnchors), "Old sidecar should exist before rename");

			// Rename via the workspace API (fires onDidRenameFiles)
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(oldTxt, newTxt);
			await vscode.workspace.applyEdit(edit);

			// Wait for the sidecar to move
			await waitUntil(async () => await fileExists(newAnchors), 10000);
			assert.ok(await fileExists(newAnchors), "New sidecar should exist after rename");
			assert.ok(!(await fileExists(oldAnchors)), "Old sidecar should be gone after rename");

			// Verify content survived the move
			const content = await readFile(newAnchors);
			assert.ok(content.includes("Viewport"), "Sidecar content should be preserved");

			// Cleanup
			await deleteFile(newTxt);
			await waitUntil(async () => !(await fileExists(newAnchors)));
		});

		it("updates code-refs in sidecars when a referenced source file is renamed", async () => {
			const tempTxt = uri("diagrams", "temp-coderef.txt");
			const tempAnchors = uri(".diagfren", "diagrams", "temp-coderef.anchors");

			// Create diagram + sidecar referencing src/example.ts
			await writeFile(tempTxt, SAMPLE_DIAGRAM);
			await writeFile(tempAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 500));

			// Verify initial refs point to src/example.ts
			const before = await readFile(tempAnchors);
			assert.ok(before.includes("src/example.ts:"), "Should reference src/example.ts before rename");

			// Create a temp source file and rename it to simulate the rename event
			const oldSrc = uri("src", "temp-rename-target.ts");
			const newSrc = uri("src", "temp-rename-result.ts");

			// Update the sidecar to reference the temp source file
			const withTempRef = before.replaceAll("src/example.ts:", "src/temp-rename-target.ts:");
			await writeFile(tempAnchors, withTempRef);
			await writeFile(oldSrc, "// temp file\n");
			await new Promise((r) => setTimeout(r, 500));

			// Rename the source file via workspace API
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(oldSrc, newSrc);
			await vscode.workspace.applyEdit(edit);

			// Wait for code-refs to update
			await waitUntil(async () => {
				const content = await readFile(tempAnchors);
				return content.includes("src/temp-rename-result.ts:");
			}, 10000);

			const after = await readFile(tempAnchors);
			assert.ok(after.includes("src/temp-rename-result.ts:"), "Code-refs should point to new path");
			assert.ok(!after.includes("src/temp-rename-target.ts:"), "Old path should not remain");

			// Cleanup
			await deleteFile(newSrc);
			await deleteFile(tempTxt);
			await waitUntil(async () => !(await fileExists(tempAnchors)));
		});

		it("moves all sidecars and rewrites refs when a directory is renamed", async () => {
			// Setup: directory diagrams/dir-rename-old/ with two diagrams + sidecars
			const oldDir = uri("diagrams", "dir-rename-old");
			const newDir = uri("diagrams", "dir-rename-new");
			const oldTxt1 = uri("diagrams", "dir-rename-old", "a.txt");
			const oldTxt2 = uri("diagrams", "dir-rename-old", "b.txt");
			const oldAnchors1 = uri(".diagfren", "diagrams", "dir-rename-old", "a.anchors");
			const oldAnchors2 = uri(".diagfren", "diagrams", "dir-rename-old", "b.anchors");
			const newAnchors1 = uri(".diagfren", "diagrams", "dir-rename-new", "a.anchors");
			const newAnchors2 = uri(".diagfren", "diagrams", "dir-rename-new", "b.anchors");

			// a.txt has cross-ref to b.txt using the old directory path
			const anchorsA = `# anchor-text  code-ref                                   label\nViewport        diagrams/dir-rename-old/b.txt:1             Cross ref to b\n`;
			const anchorsB = SAMPLE_ANCHORS;

			await writeFile(oldTxt1, SAMPLE_DIAGRAM);
			await writeFile(oldTxt2, SAMPLE_DIAGRAM);
			await writeFile(oldAnchors1, anchorsA);
			await writeFile(oldAnchors2, anchorsB);
			await new Promise((r) => setTimeout(r, 500));

			// Rename the directory via workspace API
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(oldDir, newDir);
			await vscode.workspace.applyEdit(edit);

			// Wait for sidecars to move
			await waitUntil(async () => await fileExists(newAnchors1) && await fileExists(newAnchors2), 10000);

			assert.ok(await fileExists(newAnchors1), "Sidecar a.anchors should be at new path");
			assert.ok(await fileExists(newAnchors2), "Sidecar b.anchors should be at new path");
			assert.ok(!(await fileExists(oldAnchors1)), "Old sidecar a.anchors should be gone");
			assert.ok(!(await fileExists(oldAnchors2)), "Old sidecar b.anchors should be gone");

			// Cross-ref in a.anchors should now point to new directory
			const contentA = await readFile(newAnchors1);
			assert.ok(contentA.includes("diagrams/dir-rename-new/b.txt:"), `Cross-ref should use new dir, got: ${contentA}`);
			assert.ok(!contentA.includes("diagrams/dir-rename-old/"), "Old dir path should be gone from cross-refs");

			// Cleanup
			await deleteFile(uri("diagrams", "dir-rename-new", "a.txt"));
			await deleteFile(uri("diagrams", "dir-rename-new", "b.txt"));
			await deleteFile(newAnchors1);
			await deleteFile(newAnchors2);
			try { await vscode.workspace.fs.delete(newDir, { recursive: true }); } catch { /* ok */ }
		});
	});

	// ------------------------------------------------------------------
	// Startup reconciliation — out-of-session moves
	// ------------------------------------------------------------------
	describe("Startup reconciliation (pruneOrphanedSidecars)", () => {
		it("relocates an orphaned sidecar to a moved diagram matched by basename + anchor identity", async () => {
			const { pruneOrphanedSidecars } = await import("../anchor-cache");

			// Simulate: diagram was at diagrams/recon-move.txt, now at docs/recon-move.txt
			// Sidecar is still at old location
			const movedTxt = uri("docs", "recon-move.txt");
			const oldAnchors = uri(".diagfren", "diagrams", "recon-move.anchors");
			const newAnchors = uri(".diagfren", "docs", "recon-move.anchors");

			await writeFile(movedTxt, SAMPLE_DIAGRAM);
			await writeFile(oldAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 300));

			assert.ok(await fileExists(oldAnchors), "Old sidecar should exist before reconciliation");
			assert.ok(!(await fileExists(newAnchors)), "New sidecar should not exist yet");

			await pruneOrphanedSidecars();

			assert.ok(await fileExists(newAnchors), "Sidecar should be relocated to new path");
			assert.ok(!(await fileExists(oldAnchors)), "Old sidecar should be gone");

			// Verify content survived
			const content = await readFile(newAnchors);
			assert.ok(content.includes("Viewport"), "Anchor content should be preserved");

			// Cleanup
			await deleteFile(movedTxt);
			await deleteFile(newAnchors);
		});

		it("does NOT relocate when basename matches but anchor text does not", async () => {
			const { pruneOrphanedSidecars } = await import("../anchor-cache");

			// Orphaned sidecar with anchors that don't match the candidate diagram
			const differentTxt = uri("docs", "recon-nomatch.txt");
			const orphanAnchors = uri(".diagfren", "diagrams", "recon-nomatch.anchors");
			const wouldBeAnchors = uri(".diagfren", "docs", "recon-nomatch.anchors");

			// Diagram has completely different content than what the anchors reference
			const differentDiagram = `\`\`\`diagram
┌─ SomethingElse ────────────────────┐
│  completelyDifferentFunction()      │
└─────────────────────────────────────┘
\`\`\`
`;
			await writeFile(differentTxt, differentDiagram);
			await writeFile(orphanAnchors, SAMPLE_ANCHORS); // references Viewport, transformDiv, OverLayer
			await new Promise((r) => setTimeout(r, 300));

			await pruneOrphanedSidecars();

			// Orphan should be deleted, not relocated
			assert.ok(!(await fileExists(orphanAnchors)), "Orphan should be deleted (no identity match)");
			assert.ok(!(await fileExists(wouldBeAnchors)), "Should NOT create sidecar at new path");

			// Cleanup
			await deleteFile(differentTxt);
		});

		it("does NOT relocate when multiple candidates match the same basename", async () => {
			const { pruneOrphanedSidecars } = await import("../anchor-cache");

			// Two diagrams with same basename and same content — ambiguous
			const txt1 = uri("docs", "recon-ambig.txt");
			const txt2 = uri("src", "recon-ambig.txt");
			const orphanAnchors = uri(".diagfren", "diagrams", "recon-ambig.anchors");

			await writeFile(txt1, SAMPLE_DIAGRAM);
			await writeFile(txt2, SAMPLE_DIAGRAM);
			await writeFile(orphanAnchors, SAMPLE_ANCHORS);
			await new Promise((r) => setTimeout(r, 300));

			await pruneOrphanedSidecars();

			// Ambiguous — orphan should be deleted, neither candidate gets a sidecar
			assert.ok(!(await fileExists(orphanAnchors)), "Orphan should be deleted (ambiguous match)");
			assert.ok(!(await fileExists(uri(".diagfren", "docs", "recon-ambig.anchors"))), "Should not create sidecar for candidate 1");
			assert.ok(!(await fileExists(uri(".diagfren", "src", "recon-ambig.anchors"))), "Should not create sidecar for candidate 2");

			// Cleanup
			await deleteFile(txt1);
			await deleteFile(txt2);
		});

		it("rewrites cross-diagram code-refs after relocating sidecars", async () => {
			const { pruneOrphanedSidecars } = await import("../anchor-cache");

			// Setup: a moved diagram + an existing sidecar that cross-references it
			const movedTxt = uri("docs", "recon-xref-target.txt");
			const oldAnchors = uri(".diagfren", "diagrams", "recon-xref-target.anchors");

			// Another sidecar that references the old path in its code-refs
			const refererTxt = uri("diagrams", "recon-xref-referer.txt");
			const refererAnchors = uri(".diagfren", "diagrams", "recon-xref-referer.anchors");
			const refererAnchorsContent = `# anchor-text  code-ref                                  label
Viewport        diagrams/recon-xref-target.txt:1          Cross-ref to target
`;
			const refererDiagram = `\`\`\`diagram
┌─ Viewport ─┐
└─────────────┘
\`\`\`
`;

			await writeFile(movedTxt, SAMPLE_DIAGRAM);
			await writeFile(oldAnchors, SAMPLE_ANCHORS);
			await writeFile(refererTxt, refererDiagram);
			await writeFile(refererAnchors, refererAnchorsContent);
			await new Promise((r) => setTimeout(r, 300));

			await pruneOrphanedSidecars();

			// The cross-ref should now point to the new path
			const refContent = await readFile(refererAnchors);
			assert.ok(
				refContent.includes("docs/recon-xref-target.txt:"),
				`Cross-ref should point to new path, got: ${refContent}`,
			);
			assert.ok(
				!refContent.includes("diagrams/recon-xref-target.txt:"),
				"Old cross-ref path should be gone",
			);

			// Cleanup
			await deleteFile(movedTxt);
			await deleteFile(uri(".diagfren", "docs", "recon-xref-target.anchors"));
			await deleteFile(refererTxt);
			await deleteFile(refererAnchors);
		});
	});
});
