import { App, Menu, Notice, Plugin, SuggestModal, TFile } from "obsidian";

type Attrs<T extends keyof HTMLElementTagNameMap> = Partial<
	HTMLElementTagNameMap[T] | Record<string, unknown>
>;
function h<T extends keyof HTMLElementTagNameMap>(
	tag: T | ((attrs: Attrs<T>) => HTMLElement),
	attributes: Attrs<T> = {},
	...children: (Node | string)[]
) {
	const el: HTMLElement =
		typeof tag === "function"
			? tag(attributes)
			: Object.assign(document.createElement(tag), attributes);
	el.append(...children);
	return el;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface NCSettings {
	// TODO: codes in quick switcher optionally?
	// codesInQuickSwitcher: boolean;
}

const DEFAULT_SETTINGS: NCSettings = {
	// codesInQuickSwitcher: false,
};

// we use Crockford's Base32 alphabet that avoids similar-looking characters
const jsBase32Alphabet = "0123456789abcdefghijklmnopqrstuv";
const base32Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHABET_LENGTH = base32Alphabet.length;
const jsBase32Mapping = Object.fromEntries(
	jsBase32Alphabet.split("").map((char, index) => [char, base32Alphabet[index]]),
);
const base32Mapping: Record<string, string> = {
	O: "0",
	L: "1",
	I: "1",
	U: "V",
};

const encoder = new TextEncoder();
async function hashString(string: string): Promise<string> {
	const data = encoder.encode(string);
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));

	// 1,048,576 possible hashes
	const num = ((bytes[0] << 16) | (bytes[1] << 8) | (bytes[2] << 0)) % ALPHABET_LENGTH ** 4;

	const [a, b, c, d] = num
		.toString(ALPHABET_LENGTH)
		.padStart(4, "0")
		.split("")
		.map(char => jsBase32Mapping[char]);

	return `${a}${b}-${c}${d}`;
}

type Entry = { hash: string; path: string };
function formatHash(hash: string): string {
	hash = hash
		.toUpperCase()
		.split("")
		.map(c => base32Mapping[c] ?? c)
		.filter(c => base32Alphabet.includes(c))
		.slice(0, 4)
		.join("");

	if (hash.length > 2) {
		hash = hash.slice(0, 2) + "-" + hash.slice(2);
	}

	return hash;
}

class NCSuggestModal extends SuggestModal<Entry> {
	plugin: NoteCodes;

	constructor(app: App, plugin: NoteCodes) {
		super(app);
		this.plugin = plugin;

		this.setPlaceholder("__-__");
		this.inputEl.classList.add("note-code");
	}

	renderSuggestion({ hash, path }: Entry, el: HTMLElement): void {
		el.append(
			h("div", {}, path),
			h(
				"small",
				{ className: "note-code" },

				h("strong", {}, this.inputEl.value),
				hash.slice(this.inputEl.value.length),
			),
		);
	}

	getSuggestions(query: string): Entry[] {
		query = formatHash(query);
		this.inputEl.value = query; // Update the input value to match the formatted query

		const results: Entry[] = [];

		for (const [hash, path] of this.plugin.hashesToPaths.entries()) {
			if (hash.startsWith(query)) {
				results.push({ hash, path });
			}
		}
		return results;
	}

	onChooseSuggestion({ hash, path }: Entry, evt: MouseEvent | KeyboardEvent): void {
		this.plugin.openNoteForHash(hash);
	}
}

export default class NoteCodes extends Plugin {
	settings: NCSettings;

	hashesToPaths = new Map<string, string>();
	pathsToHashes = new Map<string, string>();

	async addPath(path: string) {
		const hash = await hashString(path);
		this.hashesToPaths.set(hash, path);
		this.pathsToHashes.set(path, hash);
		return hash;
	}

	async removePath(path: string) {
		const hash = this.pathsToHashes.get(path);
		if (hash) {
			this.hashesToPaths.delete(hash);
			this.pathsToHashes.delete(path);
		}
	}

	async getHashForPath(path: string): Promise<string> {
		const hash = this.pathsToHashes.get(path);
		if (hash) {
			return hash;
		} else {
			return await this.addPath(path);
		}
	}

	menu: Menu = (() => {
		const menu = new Menu();
		menu.addItem(item =>
			item
				.setTitle("Copy note code")
				.setIcon("binary")
				.onClick(() => this.copyNoteCode()),
		);

		menu.addItem(item =>
			item
				.setTitle("Copy note code URL")
				.setIcon("link")
				.onClick(() => this.copyNoteCodeURL()),
		);

		menu.addItem(item =>
			item
				.setTitle("Search note codes")
				.setIcon("search")
				.onClick(() => this.openSearchModal()),
		);

		return menu;
	})();

	async getHashForActiveFile(): Promise<string | undefined> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			return;
		}
		return this.getHashForPath(file.path);
	}

	async copyNoteCode(): Promise<void> {
		const hash = await this.getHashForActiveFile();
		if (hash) {
			navigator.clipboard.writeText(hash);
		}
	}

	async copyNoteCodeURL(): Promise<void> {
		const hash = await this.getHashForActiveFile();
		if (hash) {
			navigator.clipboard.writeText(`obsidian://note-codes/open?code=${hash}`);
		}
	}

	async openNoteForHash(hash: string): Promise<void> {
		hash = formatHash(hash);
		const path = this.hashesToPaths.get(hash);
		if (!path) {
			const fragment = new DocumentFragment();
			fragment.append(
				h(
					"span",
					{},
					"No such note code: ",
					h("strong", { className: "note-code" }, hash.padEnd(5, "_")),
				),
			);
			new Notice(fragment);
			return;
		}
		const file = path && this.app.vault.getFileByPath(path);
		if (file) {
			this.app.workspace.getLeaf().openFile(file);
		} else {
			new Notice(`File not found: ${path}`);
		}
	}

	statusBarItemEl: HTMLElement;

	async setStatusBar(file: TFile | null) {
		let hash = "__-__";
		if (file) {
			hash = await this.getHashForPath(file.path);
		}
		this.statusBarItemEl.setText(hash);

		// add to drawer on mobile
		const drawerFileName = document.querySelector(
			`.is-mobile .workspace-drawer:not(:has(.side-dock-ribbon)) .workspace-drawer-header-name`,
		);

		if (!drawerFileName) {
			return;
		}

		document
			.querySelectorAll(".workspace-drawer-header-name .note-code")
			.forEach(el => el.remove());

		const el = h("div", { className: "note-code clickable-icon" }, hash);
		drawerFileName.append(el);

		this.registerDomEvent(el, "click", ev => this.openSearchModal());
		this.registerDomEvent(el, "contextmenu", ev => this.menu.showAtMouseEvent(ev));
	}

	openSearchModal() {
		new NCSuggestModal(this.app, this).open();
	}

	async onload() {
		await this.loadSettings();

		// initial load of hashes
		for (const file of this.app.vault.getFiles()) {
			this.addPath(file.path);
		}

		// register events
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.removePath(oldPath);
				this.addPath(file.path);
				this.setStatusBar(this.app.workspace.getActiveFile());
			}),
		);
		this.registerEvent(this.app.vault.on("create", file => this.addPath(file.path)));
		this.registerEvent(this.app.vault.on("delete", file => this.removePath(file.path)));

		this.registerEvent(this.app.workspace.on("file-open", file => this.setStatusBar(file)));

		// add status bar item
		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.addClass("mod-clickable");
		this.statusBarItemEl.addClass("note-code");
		this.registerDomEvent(this.statusBarItemEl, "click", () => this.openSearchModal());
		this.registerDomEvent(this.statusBarItemEl, "contextmenu", ev => {
			this.menu.showAtMouseEvent(ev);
		});
		this.setStatusBar(this.app.workspace.getActiveFile());

		// register commands
		this.addCommand({
			id: "search",
			name: "Search for note codes",
			callback: () => this.openSearchModal(),
		});
		this.addCommand({
			id: "copy",
			name: "Copy note code",
			callback: () => this.copyNoteCode(),
		});
		this.addCommand({
			id: "copy-url",
			name: "Copy note code URL",
			callback: () => this.copyNoteCodeURL(),
		});

		// register obsidian:// handler
		this.registerObsidianProtocolHandler("note-codes/open", async ({ action, code: hash }) => {
			this.openNoteForHash(hash);
		});
	}

	onunload() {
		document
			.querySelectorAll(".workspace-drawer-header-name .note-code")
			.forEach(el => el.remove());
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
