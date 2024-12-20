import {
	App,
	Vault,
	TFolder,
	ListedFiles,
} from 'obsidian';
import * as fs from "fs";
import * as path2 from "path"

export const DEBUG = !(process.env.BUILD_ENV === 'production')
if (DEBUG) console.log('DEBUG is enabled')

export function debugLog(...args: any[]) {
	if (DEBUG) {
		console.log((new Date()).toISOString().slice(11, 23), ...args)
	}
}

interface ElementTreeOptions extends DomElementInfo {
	tag: keyof HTMLElementTagNameMap
	children?: ElementTreeOptions[]
}

interface ElementTree {
	el: HTMLElement
	children: ElementTree[]
}

export function createElementTree(rootEl: HTMLElement, opts: ElementTreeOptions): ElementTree {
	const result: ElementTree = {
		el: rootEl.createEl(opts.tag, opts as DomElementInfo),
		children: [],
	}
	const children = opts.children || []
	for (const child of children) {
		result.children.push(createElementTree(result.el, child))
	}
	return result
}

export const path = {
	// Credit: @creationix/path.js
	join(...partSegments: string[]): string {
		// Split the inputs into a list of path commands.
		let parts: string[] = []
		for (let i = 0, l = partSegments.length; i < l; i++) {
			parts = parts.concat(partSegments[i].split('/'))
		}
		// Interpret the path commands to get the new resolved path.
		const newParts = []
		for (let i = 0, l = parts.length; i < l; i++) {
			const part = parts[i]
			// Remove leading and trailing slashes
			// Also remove "." segments
			if (!part || part === '.') continue
			// Push new path segments.
			else newParts.push(part)
		}
		// Preserve the initial slash if there was one.
		if (parts[0] === '') newParts.unshift('')
		// Turn back into a single string path.
		return newParts.join('/')
	},

	// returns the last part of a path, e.g. 'foo.jpg'
	basename(fullpath: string): string {
		const sp = fullpath.split('/')
		return sp[sp.length - 1]
	},

	/**
	 * get the parent directory part of a file or directory
	 * @param fullpath - full path of a file or directory
	 * @returns the directory part of a path,
	 * @example
	 */
	directory(fullpath: string): string {
		const sp = fullpath.split('/')
		return sp.slice(0, sp.length - 1).join('/')
	},

	// return extension without dot, e.g. 'jpg'
	extension(fullpath: string): string {
		const positions = [...fullpath.matchAll(new RegExp('\\.', 'gi'))].map(a => a.index)
		return fullpath.slice(positions[positions.length - 1] + 1)
	},

	relative(baseDir: string, targetPath: string): string {
		let rel: string = path2.relative(baseDir, targetPath)
		rel = rel.replace(/\\/g, '/')

		return rel
	}
}

export async function getListedFiles(directory: string): Promise<ListedFiles> {
	try {
		// Read the files in the specified directory
		const entries = await fs.promises.readdir(directory);

		// Process entries to separate files and folders
		const files: string[] = [];
		const folders: string[] = [];

		await Promise.all(
			entries.map(async entry => {
				const fullPath = path.join(directory, entry);
				const stats = await fs.promises.stat(fullPath); // Check file stats

				if (stats.isFile()) {
					files.push(fullPath); // Add to files array
				} else if (stats.isDirectory()) {
					folders.push(fullPath); // Add to folders array
				}
			})
		);

		// Create the ListedFiles object
		const listedFiles: ListedFiles = {
			folders: folders, // Array of folder paths
			files: files,  // Array of file paths
		};

		return listedFiles;
	} catch (error) {
		throw new Error(`Failed to list files in directory "${directory}": ${error.message}`);
	}
}

/**
 * get the full path of given folder object
 * @param tFolder - a folder object
 * @returns the full path of directory
 */
export const getDirectoryPath = (tFolder: TFolder): string => {
	if (tFolder.parent.name === '') return tFolder.name
	return `${getDirectoryPath(tFolder.parent)}/${tFolder.name}`
}

const filenameNotAllowedChars = /[^\p{L}0-9~`!@$&*()\-_=+{};'",<.>? ]/ug
const fsFilenameNotAllowedChars = /[^\p{L}0-9~`!@$&*()\-_=+{};'",<.>? :/]/ug

export const sanitizer = {
	filename(s: string): string {
		return s.replace(filenameNotAllowedChars, '').trim()
	},

	fs_filename(s: string): string {
		return s.replace(fsFilenameNotAllowedChars, '').trim()
	},

	link(s: string): string {
		debugLog(`original string: ${s}`)
		debugLog(`encodeURI: ${encodeURI(s)}`)
		return encodeURI(s)
	},

	delimiter(s: string): string {
		s = this.filename(s)
		// use default '-' if no valid chars found
		if (!s) s = '-'
		return s
	}
}

// ref: https://stackoverflow.com/a/6969486/596206
export function escapeRegExp(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


interface CompositionState {
	lock: boolean
}

export function lockInputMethodComposition(el: HTMLInputElement): CompositionState {
	const state: CompositionState = {
		lock: false,
	}
	el.addEventListener('compositionstart', () => {
		state.lock = true
	})
	el.addEventListener('compositionend', () => {
		state.lock = false
	})
	return state
}


interface VaultConfig {
	useMarkdownLinks?: boolean
}

interface VaultWithConfig extends Vault {
	config?: VaultConfig,
}

export function getVaultConfig(app: App): VaultConfig | null {
	const vault = app.vault as VaultWithConfig
	return vault.config
}

export interface NameObj {
	name: string
	stem: string
	extension: string
}
