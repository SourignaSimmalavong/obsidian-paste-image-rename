/* TODOs:
 * - [x] check name existence when saving
 * - [x] imageNameKey in frontmatter
 * - [x] after renaming, cursor should be placed after the image file link
 * - [x] handle image insert from drag'n drop
 * - [ ] select text when opening the renaming modal, make this an option
 * - [ ] add button for use the current file name, imageNameKey, last input name,
 *       segments of last input name
 * - [x] batch rename all pasted images in a file
 * - [ ] add rules for moving matched images to destination folder
 */
import {
	App,
	FileSystemAdapter,
	HeadingCache,
	ListedFiles,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from 'obsidian';

import { ImageBatchRenameModal } from './batch';
import { renderTemplate } from './template';
import {
	createElementTree,
	DEBUG,
	debugLog,
	escapeRegExp,
	lockInputMethodComposition,
	NameObj,
	path,
	sanitizer,
	getDirectoryPath,
	getListedFiles,
} from './utils';
import * as fs from "fs";

interface PluginSettings {
	// {{imageNameKey}}-{{DATE:YYYYMMDD}}
	imageNamePattern: string
	dupNumberAtStart: boolean
	dupNumberDelimiter: string
	dupNumberAlways: boolean
	autoRename: boolean
	handleAllAttachments: boolean
	excludeExtensionPattern: string
	disableRenameNotice: boolean
	rootDirPhysical: string
	rootDirView: string
}

const DEFAULT_SETTINGS: PluginSettings = {
	imageNamePattern: '{{fileName}}',
	dupNumberAtStart: false,
	dupNumberDelimiter: '-',
	dupNumberAlways: false,
	autoRename: false,
	handleAllAttachments: false,
	excludeExtensionPattern: '',
	disableRenameNotice: false,
	rootDirPhysical: '',
	rootDirView: ''
}

const PASTED_IMAGE_PREFIX = 'Pasted image '


export default class PasteImageRenamePlugin extends Plugin {
	settings: PluginSettings
	modals: Modal[] = []
	excludeExtensionRegex: RegExp

	async onload() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const pkg = require('../package.json')
		console.log(`Plugin loading: ${pkg.name} ${pkg.version} BUILD_ENV=${process.env.BUILD_ENV}`)
		await this.loadSettings();

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				// debugLog('file created', file)
				if (!(file instanceof TFile))
					return
				const timeGapMs = (new Date().getTime()) - file.stat.ctime
				// if the file is created more than 1 second ago, the event is most likely be fired on vault initialization when starting Obsidian app, ignore it
				if (timeGapMs > 1000)
					return
				// always ignore markdown file creation
				if (isMarkdownFile(file))
					return
				if (isPastedImage(file)) {
					debugLog('pasted image created', file)
					this.startRenameProcess(file, this.settings.autoRename)
				} else {
					if (this.settings.handleAllAttachments) {
						debugLog('handleAllAttachments for file', file)
						if (this.testExcludeExtension(file)) {
							debugLog('excluded file by ext', file)
							return
						}
						this.startRenameProcess(file, this.settings.autoRename)
					}
				}
			})
		)

		const startBatchRenameProcess = () => {
			this.openBatchRenameModal()
		}
		this.addCommand({
			id: 'batch-rename-embeded-files',
			name: 'Batch rename embeded files (in the current file)',
			callback: startBatchRenameProcess,
		})
		if (DEBUG) {
			this.addRibbonIcon('wand-glyph', 'Batch rename embeded files', startBatchRenameProcess)
		}

		const batchRenameAllImages = () => {
			this.batchRenameAllImages()
		}
		this.addCommand({
			id: 'batch-rename-all-images',
			name: 'Batch rename all images instantly (in the current file)',
			callback: batchRenameAllImages,
		})
		if (DEBUG) {
			this.addRibbonIcon('wand-glyph', 'Batch rename all images instantly (in the current file)', batchRenameAllImages)
		}

		// add settings tab
		this.addSettingTab(new SettingTab(this.app, this));

	}

	async startRenameProcess(file: TFile, autoRename = false) {
		// get active file first
		const activeFile = this.getActiveFile()
		if (!activeFile) {
			new Notice('Error: No active file found.')
			return
		}

		const { stem, newName, isMeaningful } = this.generateNewName(file, activeFile)
		debugLog('generated newName:', newName, isMeaningful)

		if (!isMeaningful || !autoRename) {
			this.openRenameModal(file, isMeaningful ? stem : '', activeFile.path)
			return
		}
		this.renameFile(file, newName, activeFile.path, true)
	}

	async renameFile(file: TFile, inputNewName: string, sourcePath: string, replaceCurrentLine?: boolean) {
		// deduplicate name
		const { name: newName } = await this.deduplicateNewName(inputNewName, file)
		debugLog('deduplicated newName:', newName)
		const originName = file.name

		// generate linkText using Obsidian API, linkText is either  ![](filename.png) or ![[filename.png]] according to the "Use [[Wikilinks]]" setting.
		const linkText = this.app.fileManager.generateMarkdownLink(file, sourcePath)

		// file system operation: rename the file
		// const newPath = path.join(file.parent.path, newName)
		try {
			// get directory part of new path
			const newPathDirectory = path.directory(newName)
			if (this.settings.rootDirPhysical == '') {
				// check if directory exists
				const newPathDirectoryExists = await this.app.vault.adapter.exists(newPathDirectory)
				// create directory
				if (!newPathDirectoryExists) await this.app.vault.createFolder(newPathDirectory)
				// execute rename
				await this.app.fileManager.renameFile(file, newName)
			} else {
				if (!fs.existsSync(newPathDirectory)) {
					fs.mkdirSync(newPathDirectory, { recursive: true });
				}
				const vaultBasePath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
				const srcPath = fs.realpathSync(path.join(vaultBasePath, file.path))
				const targetPath = path.join(this.settings.rootDirPhysical, newName)
				if (!fs.existsSync(srcPath)) {
					new Notice(`Source path does not exist. Something went wrong!\nSource path: ${sourcePath}`)
					throw new Error(`Source path does not exist. Something went wrong!\nSource path: ${sourcePath}`)
				} else if (fs.existsSync(targetPath)) {
					new Notice(`Target path already exists. Something went wrong!\nTarget path: ${targetPath}`)
					throw new Error(`Target path already exists. Something went wrong!\nTarget path: ${targetPath}`)
				}
				else {
					const targetDir = path.directory(targetPath);
					// Ensure the target parent directory exists
					if (!fs.existsSync(targetDir)) {
						fs.mkdirSync(targetDir, { recursive: true });
						console.log(`Created target parent directory: ${targetDir}`);
					}
					fs.renameSync(srcPath, targetPath)
				}
			}

		} catch (err) {
			new Notice(`Failed to rename ${newName}: ${err}`)
			throw err
		}

		if (!replaceCurrentLine) {
			return
		}

		// in case fileManager.renameFile may not update the internal link in the active file,
		// we manually replace the current line by manipulating the editor

		let newLinkText = '';
		if (this.settings.rootDirPhysical == '') {
			newLinkText = this.app.fileManager.generateMarkdownLink(file, sourcePath)
		}
		else {
			const extension = path.extension(newName).toLowerCase()
			const viewPath = sanitizer.link(path.join(this.settings.rootDirView, newName))
			if (IMAGE_EXTS.contains(extension)) {
				newLinkText = `![${path.basename(newName)}](${viewPath})`
			} else if (VIDEO_EXTS.contains(extension)) {
				newLinkText = `<video controls src="${viewPath}" style />`
			} else {
				new Notice(`Unhandled attachment type: ${extension}`)

			}
		}
		debugLog('replace text', linkText, newLinkText)

		const editor = this.getActiveEditor()
		if (!editor) {
			new Notice(`Failed to rename ${newName}: no active editor`)
			return
		}

		const cursor = editor.getCursor()
		const line = editor.getLine(cursor.line)
		const replacedLine = line.replace(linkText, newLinkText)
		debugLog('current line -> replaced line', line, replacedLine)
		// console.log('editor context', cursor, )
		editor.transaction({
			changes: [
				{
					from: { ...cursor, ch: 0 },
					to: { ...cursor, ch: line.length },
					text: replacedLine,
				}
			]
		})

		if (!this.settings.disableRenameNotice) {
			new Notice(`Renamed ${originName} to ${newName}`)
		}
	}

	openRenameModal(file: TFile, newName: string, sourcePath: string) {
		const modal = new ImageRenameModal(
			this.app, file as TFile, newName, this.settings.rootDirPhysical, this.settings.rootDirView,
			(confirmedName: string) => {
				debugLog('confirmedName:', confirmedName)
				this.renameFile(file, confirmedName, sourcePath, true)
			},
			() => {
				this.modals.splice(this.modals.indexOf(modal), 1)
			}
		)
		this.modals.push(modal)
		modal.open()
		debugLog('modals count', this.modals.length)
	}

	openBatchRenameModal() {
		const activeFile = this.getActiveFile()
		const modal = new ImageBatchRenameModal(
			this.app,
			activeFile,
			async (file: TFile, name: string) => {
				await this.renameFile(file, name, activeFile.path)
			},
			() => {
				this.modals.splice(this.modals.indexOf(modal), 1)
			}
		)
		this.modals.push(modal)
		modal.open()
	}

	async batchRenameAllImages() {
		const activeFile = this.getActiveFile()
		const fileCache = this.app.metadataCache.getFileCache(activeFile)
		if (!fileCache || !fileCache.embeds) return
		const extPatternRegex = /jpe?g|png|gif|tiff|webp/i

		for (const embed of fileCache.embeds) {
			const file = this.app.metadataCache.getFirstLinkpathDest(embed.link, activeFile.path)
			if (!file) {
				console.warn('file not found', embed.link)
				return
			}
			// match ext
			const m0 = extPatternRegex.exec(file.extension)
			if (!m0) return

			// rename
			const { newName, isMeaningful } = this.generateNewName(file, activeFile)
			debugLog('generated newName:', newName, isMeaningful)
			if (!isMeaningful) {
				new Notice('Failed to batch rename images: the generated name is not meaningful')
				break;
			}

			await this.renameFile(file, newName, activeFile.path, false)
		}
	}

	// returns a new name for the input file, with extension
	generateNewName(file: TFile, activeFile: TFile) {
		let imageNameKey = ''
		let firstHeading = ''
		let frontmatter
		const fileCache = this.app.metadataCache.getFileCache(activeFile)
		if (fileCache) {
			debugLog('frontmatter', fileCache.frontmatter)
			frontmatter = fileCache.frontmatter
			imageNameKey = frontmatter?.imageNameKey || ''
			firstHeading = getFirstHeading(fileCache.headings)
		} else {
			console.warn('could not get file cache from active file', activeFile.name)
		}

		const dirPath = getDirectoryPath(activeFile.parent)

		const stem = renderTemplate(
			this.settings.imageNamePattern,
			{
				imageNameKey,
				fileName: activeFile.basename,
				dirName: activeFile.parent.name,
				dirPath,
				firstHeading,
			},
			frontmatter)
		const meaninglessRegex = new RegExp(`[${this.settings.dupNumberDelimiter}\\s]`, 'gm')

		return {
			stem,
			newName: stem + '.' + file.extension,
			isMeaningful: stem.replace(meaninglessRegex, '') !== '',
		}
	}

	// newName: foo.ext
	async deduplicateNewName(newName: string, file: TFile): Promise<NameObj> {
		// confirmed new file path
		newName = newName.replace('\\', '/')
		let newFilePath = "";
		let listed: false | ListedFiles = false;
		if (this.settings.rootDirPhysical == '') {
			// list files in dir
			newFilePath = path.join(getDirectoryPath(file.parent), newName)
			const dir = path.directory(newFilePath) // file.parent.path
			const dirExists = await this.app.vault.adapter.exists(dir)
			listed = dirExists && await this.app.vault.adapter.list(dir)
		}
		else {
			// list files in dir
			newFilePath = path.join(this.settings.rootDirPhysical, newName)
			const dir = path.directory(newFilePath)
			const dirExists = await fs.existsSync(dir)
			listed = dirExists && await getListedFiles(dir)
		}

		// parse newName
		const newNameExt = path.extension(newName),
			newNameStem = newFilePath.slice(0, newFilePath.length - newNameExt.length - 1),
			newNameStemEscaped = escapeRegExp(newNameStem),
			delimiter = this.settings.dupNumberDelimiter,
			delimiterEscaped = escapeRegExp(delimiter)

		let dupNameRegex
		if (this.settings.dupNumberAtStart) {
			dupNameRegex = new RegExp(
				`^(?<number>\\d+)${delimiterEscaped}(?<name>${newNameStemEscaped})\\.${newNameExt}$`)
		} else {
			dupNameRegex = new RegExp(
				`^(?<name>${newNameStemEscaped})${delimiterEscaped}(?<number>\\d+)\\.${newNameExt}$`)
		}
		debugLog('dupNameRegex', dupNameRegex)

		const dupNameNumbers: number[] = []
		let isNewNameExist = false
		if (listed) {
			for (const sibling of listed.files) {
				const siblingBasename = path.basename(sibling)
				if (siblingBasename == path.basename(newName)) {
					isNewNameExist = true
					continue
				}

				// match dupNames
				const m = dupNameRegex.exec(sibling)
				if (!m) continue
				// parse int for m.groups.number
				dupNameNumbers.push(parseInt(m.groups.number))
			}
		}

		if (isNewNameExist || this.settings.dupNumberAlways) {
			// get max number
			const newNumber = dupNameNumbers.length > 0 ? Math.max(...dupNameNumbers) + 1 : 1
			// change newName
			if (this.settings.rootDirPhysical == '') {
				if (this.settings.dupNumberAtStart) {
					newName = `${newNumber}${delimiter}${newNameStem}.${newNameExt}`
				} else {
					newName = `${newNameStem}${delimiter}${newNumber}.${newNameExt}`
				}
			} else {
				const dir = path.directory(newNameStem)
				const basename = path.basename(newNameStem)
				if (this.settings.dupNumberAtStart) {
					newName = `${newNumber}${delimiter}${basename}.${newNameExt}`
				} else {
					newName = `${basename}${delimiter}${newNumber}.${newNameExt}`
				}
				newName = path.relative(this.settings.rootDirPhysical, path.join(dir, newName))
			}
		}

		return {
			name: newName,
			stem: newName.slice(0, newName.length - newNameExt.length - 1),
			extension: newNameExt,
		}
	}

	getActiveFile() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		const file = view?.file
		debugLog('active file', file?.path)
		return file
	}
	getActiveEditor() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		return view?.editor
	}

	onunload() {
		this.modals.map(modal => modal.close())
	}

	testExcludeExtension(file: TFile): boolean {
		const pattern = this.settings.excludeExtensionPattern
		if (!pattern) return false
		return new RegExp(pattern).test(file.extension)
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

function getFirstHeading(headings?: HeadingCache[]) {
	if (headings && headings.length > 0) {
		for (const heading of headings) {
			if (heading.level === 1) {
				return heading.heading
			}
		}
	}
	return ''
}

function isPastedImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (file.name.startsWith(PASTED_IMAGE_PREFIX)) {
			return true
		}
	}
	return false
}

function isMarkdownFile(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (file.extension === 'md') {
			return true
		}
	}
	return false
}

const IMAGE_EXTS = [
	'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg',
]

const VIDEO_EXTS = [
	'mpg', 'avi', 'mov', 'mkv', 'mp4',
]

function isImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (IMAGE_EXTS.contains(file.extension.toLowerCase())) {
			return true
		}
	}
	return false
}

class ImageRenameModal extends Modal {
	src: TFile
	stem: string
	rootDirPhysical: string
	rootDirView: string
	renameFunc: (path: string) => void
	onCloseExtra: () => void

	constructor(app: App, src: TFile, stem: string, rootDirPhysical: string, rootDirView: string, renameFunc: (path: string) => void, onClose: () => void) {
		super(app);
		this.src = src
		this.stem = stem
		this.rootDirPhysical = rootDirPhysical
		this.rootDirView = rootDirView
		this.renameFunc = renameFunc
		this.onCloseExtra = onClose
	}

	onOpen() {
		this.containerEl.addClass('image-rename-modal')
		const { contentEl, titleEl } = this;
		titleEl.setText('Rename image')

		const imageContainer = contentEl.createDiv({
			cls: 'image-container',
		})
		imageContainer.createEl('img', {
			attr: {
				src: this.app.vault.getResourcePath(this.src),
			}
		})

		let stem = this.stem
		const ext = this.src.extension
		const getNewName = (stem: string) => stem + '.' + ext
		const rootDirPhysical = this.rootDirPhysical
		const rootDirView = this.rootDirView
		const getNewPath = (stem: string, is_physical: boolean) => {
			if (rootDirPhysical == '') {
				return path.join(this.src.parent.path, getNewName(stem))
			}
			else {
				if (is_physical) {
					return path.join(rootDirPhysical, getNewName(stem))
				} else {
					return path.join(rootDirView, getNewName(stem))
				}
			}
		}

		const infoET = createElementTree(contentEl, {
			tag: 'ul',
			cls: 'info',
			children: [
				{
					tag: 'li',
					children: [
						{
							tag: 'span',
							text: 'Origin path',
						},
						{
							tag: 'span',
							text: this.src.path,
						}
					],
				},
				{
					tag: 'li',
					children: [
						{
							tag: 'span',
							text: 'New path',
						},
						{
							tag: 'span',
							text: getNewPath(stem, true),
						}
					],
				},
				{
					tag: 'li',
					children: [
						{
							tag: 'span',
							text: 'New display link',
						},
						{
							tag: 'span',
							text: sanitizer.link(getNewPath(stem, false)),
						}
					],
				}

			]
		})

		const doRename = async () => {
			debugLog('doRename', `stem=${stem}`)
			this.renameFunc(getNewName(stem))
		}

		const nameSetting = new Setting(contentEl)
			.setName('New name')
			.setDesc('Please input the new name for the image (without extension)')
			.addText(text => text
				.setValue(stem)
				.onChange(async (value) => {
					if (rootDirPhysical == '') {
						stem = sanitizer.filename(value)
					}
					else {
						stem = sanitizer.fs_filename(value)
					}
					infoET.children[1].children[1].el.innerText = getNewPath(stem, true)
					infoET.children[2].children[1].el.innerText = sanitizer.link(getNewPath(stem, false))
				}
				))

		const nameInputEl = nameSetting.controlEl.children[0] as HTMLInputElement
		nameInputEl.focus()
		const nameInputState = lockInputMethodComposition(nameInputEl)
		nameInputEl.addEventListener('keydown', async (e) => {
			// console.log('keydown', e.key, `lock=${nameInputState.lock}`)
			if (e.key === 'Enter' && !nameInputState.lock) {
				e.preventDefault()
				if (!stem) {
					errorEl.innerText = 'Error: "New name" could not be empty'
					errorEl.style.display = 'block'
					return
				}
				doRename()
				this.close()
			}
		})

		const errorEl = contentEl.createDiv({
			cls: 'error',
			attr: {
				style: 'display: none;',
			}
		})

		new Setting(contentEl)
			.addButton(button => {
				button
					.setButtonText('Rename')
					.onClick(() => {
						doRename()
						this.close()
					})
			})
			.addButton(button => {
				button
					.setButtonText('Cancel')
					.onClick(() => { this.close() })
			})
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.onCloseExtra()
	}
}

const imageNamePatternDesc = `
The pattern indicates how the new name should be generated.

Available variables:
- {{fileName}}: name of the active file, without ".md" extension.
- {{dirName}}: name of the directory which contains the document (the root directory of vault results in an empty variable).
- {{dirPath}}: full path of the directory which contains the document
- {{imageNameKey}}: this variable is read from the markdown file's frontmatter, from the same key "imageNameKey".
- {{DATE:$FORMAT}}: use "$FORMAT" to format the current date, "$FORMAT" must be a Moment.js format string, e.g. {{DATE:YYYY-MM-DD}}.

Here are some examples from pattern to image names (repeat in sequence), variables: fileName = "My note", imageNameKey = "foo":
- {{fileName}}: My note, My note-1, My note-2
- {{imageNameKey}}: foo, foo-1, foo-2
- {{imageNameKey}}-{{DATE:YYYYMMDD}}: foo-20220408, foo-20220408-1, foo-20220408-2
`

class SettingTab extends PluginSettingTab {
	plugin: PasteImageRenamePlugin;

	constructor(app: App, plugin: PasteImageRenamePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Image name pattern')
			.setDesc(imageNamePatternDesc)
			.setClass('long-description-setting-item')
			.addText(text => text
				.setPlaceholder('{{imageNameKey}}')
				.setValue(this.plugin.settings.imageNamePattern)
				.onChange(async (value) => {
					this.plugin.settings.imageNamePattern = value;
					await this.plugin.saveSettings();
				}
				));

		new Setting(containerEl)
			.setName('Duplicate number at start (or end)')
			.setDesc(`If enabled, duplicate number will be added at the start as prefix for the image name, otherwise it will be added at the end as suffix for the image name.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dupNumberAtStart)
				.onChange(async (value) => {
					this.plugin.settings.dupNumberAtStart = value
					await this.plugin.saveSettings()
				}
				))

		new Setting(containerEl)
			.setName('Duplicate number delimiter')
			.setDesc(`The delimiter to generate the number prefix/suffix for duplicated names. For example, if the value is "-", the suffix will be like "-1", "-2", "-3", and the prefix will be like "1-", "2-", "3-". Only characters that are valid in file names are allowed.`)
			.addText(text => text
				.setValue(this.plugin.settings.dupNumberDelimiter)
				.onChange(async (value) => {
					this.plugin.settings.dupNumberDelimiter = sanitizer.delimiter(value);
					await this.plugin.saveSettings();
				}
				));

		new Setting(containerEl)
			.setName('Always add duplicate number')
			.setDesc(`If enabled, duplicate number will always be added to the image name. Otherwise, it will only be added when the name is duplicated.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dupNumberAlways)
				.onChange(async (value) => {
					this.plugin.settings.dupNumberAlways = value
					await this.plugin.saveSettings()
				}
				))

		new Setting(containerEl)
			.setName('Auto rename')
			.setDesc(`By default, the rename modal will always be shown to confirm before renaming, if this option is set, the image will be auto renamed after pasting.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoRename)
				.onChange(async (value) => {
					this.plugin.settings.autoRename = value;
					await this.plugin.saveSettings();
				}
				));

		new Setting(containerEl)
			.setName('Handle all attachments')
			.setDesc(`By default, the plugin only handles images that starts with "Pasted image " in name,
			which is the prefix Obsidian uses to create images from pasted content.
			If this option is set, the plugin will handle all attachments that are created in the vault.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.handleAllAttachments)
				.onChange(async (value) => {
					this.plugin.settings.handleAllAttachments = value;
					await this.plugin.saveSettings();
				}
				));

		new Setting(containerEl)
			.setName('Exclude extension pattern')
			.setDesc(`This option is only useful when "Handle all attachments" is enabled.
			Write a Regex pattern to exclude certain extensions from being handled. Only the first line will be used.`)
			.setClass('single-line-textarea')
			.addTextArea(text => text
				.setPlaceholder('docx?|xlsx?|pptx?|zip|rar')
				.setValue(this.plugin.settings.excludeExtensionPattern)
				.onChange(async (value) => {
					this.plugin.settings.excludeExtensionPattern = value;
					await this.plugin.saveSettings();
				}
				));

		new Setting(containerEl)
			.setName('Disable rename notice')
			.setDesc(`Turn off this option if you don't want to see the notice when renaming images.
			Note that Obsidian may display a notice when a link has changed, this option cannot disable that.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.disableRenameNotice)
				.onChange(async (value) => {
					this.plugin.settings.disableRenameNotice = value;
					await this.plugin.saveSettings();
				}
				));


		const rootDirPhysicalDescr =
			`Files are saved in <physical_root_directory>/<relative_dir_of_active_note>/<image_name>.
This allows for attachments storage outside of the vault. Leave it empty to store attachments in default folder.
If on Windows, whether use slashes or properly escape the backslash.
e.g. \`C:\\\\myVaultServer\\\\\`
     \`C:/myVaultServer/\``
		new Setting(containerEl)
			.setName('Physical root directory')
			.setDesc(rootDirPhysicalDescr)
			.setClass('long-description-setting-item')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.rootDirPhysical)
				.onChange(async (value) => {
					this.plugin.settings.rootDirPhysical = value;
					await this.plugin.saveSettings();
				}
				));
		const rootDirViewDescr =
			`When using Root directory, files are displayed as \`![](<root_dir_view>/<relative_dir_of_active_note>/<image_name>)\`.
This allows for attachments storage outside of the vault.`
		new Setting(containerEl)
			.setName('Root directory view')
			.setDesc(rootDirViewDescr)
			.setClass('long-description-setting-item')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.rootDirView)
				.onChange(async (value) => {
					this.plugin.settings.rootDirView = value;
					await this.plugin.saveSettings();
				}
				));

	}
}

