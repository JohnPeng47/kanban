import * as vscode from "vscode";
import { registerAnchorCache } from "./anchor-cache";
import { registerCopyProvider } from "./copy-provider";
import { DiagramDefinitionProvider } from "./definition-provider";
import { DiagramHoverProvider } from "./hover-provider";
import { DiagramLinkProvider } from "./link-provider";
import { showStatusPage } from "./status-page";

const TXT_SELECTOR: vscode.DocumentSelector = { language: "plaintext", scheme: "file" };

export function activate(context: vscode.ExtensionContext): void {
	registerAnchorCache(context);

	context.subscriptions.push(
		vscode.languages.registerDocumentLinkProvider(TXT_SELECTOR, new DiagramLinkProvider()),
		vscode.languages.registerDefinitionProvider(TXT_SELECTOR, new DiagramDefinitionProvider()),
		vscode.languages.registerHoverProvider(TXT_SELECTOR, new DiagramHoverProvider()),
		vscode.commands.registerCommand("diagfren.statusPage", () => showStatusPage(context.extensionUri)),
	);

	registerCopyProvider(context);
}

export function deactivate(): void {}
