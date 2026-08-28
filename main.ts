import { App, Plugin, PluginSettingTab, Setting, Notice, WorkspaceLeaf, MarkdownRenderer, ItemView, setIcon, Modal, TextAreaComponent, TextComponent } from 'obsidian';

// 数据接口
interface Flashcard {
    id: string;
    name: string;           // 闪卡名称
    content: string;        // 闪卡内容
    createTime: string;     // 分配日期 (YYYY-MM-DD)
    nextReviewTime: string; // 下次复习日期 (YYYY-MM-DD)
    reviewCount: number;    // 已使用的间隔次数
}

interface VflacardSettings {
    dailyLimit: number;
    openaiBaseUrl: string;  // OpenAI 兼容 API 基础地址
    openaiApiKey: string;   // API Key
    openaiModel: string;    // 模型名
}

const DEFAULT_SETTINGS: VflacardSettings = {
    dailyLimit: 10,
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: '',
    openaiModel: 'gpt-4o-mini',
};

// 艾宾浩斯复习间隔（天数）
const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30, 60];

export default class VflacardPlugin extends Plugin {
    settings: VflacardSettings;
    flashcards: Flashcard[] = [];
    reviewProgress: { currentIndex: number; date: string } = { currentIndex: 0, date: '' };

    async onload() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
        this.flashcards = data?.flashcards || [];
        this.reviewProgress = data?.reviewProgress || { currentIndex: 0, date: '' };

        // 兼容旧数据：为没有 name 字段的卡片补全名称
        this.flashcards.forEach(card => {
            if (!card.name) {
                card.name = card.content.slice(0, 10) + (card.content.length > 10 ? '...' : '');
            }
        });

        await this.advanceExpiredCards();

        this.addCommand({
            id: 'create-flashcard',
            name: '制成展示闪卡',
            callback: () => this.createFlashcard(),
        });
        this.addCommand({
            id: 'create-multiple-flashcards',
            name: '为选区创建多个闪卡',
            callback: () => this.createMultipleFlashcards(),
        });
        this.addCommand({
            id: 'open-manager',
            name: '打开闪卡管理器',
            callback: () => this.openView('vflacard-manager'),
        });
        this.addCommand({
            id: 'open-review',
            name: '打开今日复习闪卡',
            callback: () => this.openView('vflacard-review'),
        });

        this.addRibbonIcon('layers', '制成展示闪卡', () => this.createFlashcard());
        this.addRibbonIcon('refresh-cw', '打开今日复习闪卡', () => this.openView('vflacard-review'));

        this.registerView('vflacard-manager', (leaf) => new ManagerView(leaf, this));
        this.registerView('vflacard-review', (leaf) => new ReviewView(leaf, this));

        this.addSettingTab(new VflacardSettingTab(this.app, this));
    }

    onunload() {}

    async saveAll() {
        await this.saveData({
            flashcards: this.flashcards,
            reviewProgress: this.reviewProgress,
            settings: this.settings,
        });
    }

    // 刷新所有已打开的视图
    refreshViews() {
        const { workspace } = this.app;
        for (const leaf of workspace.getLeavesOfType('vflacard-manager')) {
            if (leaf.view instanceof ManagerView) {
                leaf.view.refresh();
            }
        }
        for (const leaf of workspace.getLeavesOfType('vflacard-review')) {
            if (leaf.view instanceof ReviewView) {
                leaf.view.refresh();
            }
        }
    }

    // 创建单张闪卡
    async createFlashcard() {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            new Notice('请先打开一个编辑器并选择文本');
            return;
        }
        const selection = editor.getSelection();
        if (!selection) {
            new Notice('请先选中要制成闪卡的文本');
            return;
        }

        const today = this.formatDate(new Date());
        const assignedDate = this.assignDate(today);
        const card: Flashcard = {
            id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: selection.slice(0, 10) + (selection.length > 10 ? '...' : ''),
            content: selection,
            createTime: assignedDate,
            nextReviewTime: assignedDate,
            reviewCount: 0,
        };
        this.flashcards.push(card);
        await this.saveAll();
        new Notice(`闪卡创建成功，首次复习日期：${assignedDate}`);
        this.refreshViews();
    }

    // 批量创建闪卡
    async createMultipleFlashcards() {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            new Notice('请先打开一个编辑器并选择文本');
            return;
        }
        const selection = editor.getSelection();
        if (!selection) {
            new Notice('请先选中要拆分为多个闪卡的文本');
            return;
        }

        if (!this.settings.openaiBaseUrl || !this.settings.openaiApiKey || !this.settings.openaiModel) {
            new Notice('请先在插件设置中配置 OpenAI 兼容 API（Base URL、API Key、模型名）');
            return;
        }

        try {
            const baseUrl = this.settings.openaiBaseUrl.replace(/\/+$/, '');
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: this.settings.openaiModel,
                    messages: [
                        {
                            role: 'system',
                            content: '将给定的文本拆分为多个独立的学习卡片。每个卡片必须是原文的一个连续子串，不得修改、添加或删除任何字符（包括空格和标点）。返回一个 JSON 数组，数组元素为字符串，每个字符串就是一个卡片内容。不要有任何多余解释。'
                        },
                        { role: 'user', content: selection }
                    ],
                    temperature: 0.1,
                })
            });

            if (!response.ok) {
                throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 响应中没有内容');

            let cardContents: string[] = [];
            try {
                const parsed = JSON.parse(content);
                if (Array.isArray(parsed)) {
                    cardContents = parsed.filter(x => typeof x === 'string');
                } else {
                    throw new Error('响应不是 JSON 数组');
                }
            } catch (e) {
                const match = content.match(/```json\s*([\s\S]*?)\s*```/);
                if (match) {
                    try {
                        const parsed = JSON.parse(match[1]);
                        if (Array.isArray(parsed)) cardContents = parsed.filter(x => typeof x === 'string');
                        else throw new Error('代码块中的内容不是 JSON 数组');
                    } catch (e2) {
                        throw new Error('JSON 解析失败');
                    }
                } else {
                    throw new Error('无法解析 AI 返回的卡片列表');
                }
            }

            const validContents: string[] = [];
            for (const cardContent of cardContents) {
                if (cardContent.length > 0 && selection.includes(cardContent)) {
                    validContents.push(cardContent);
                } else {
                    console.warn('无效卡片片段（已跳过）:', cardContent);
                }
            }

            if (validContents.length === 0) {
                throw new Error('AI 返回的所有卡片片段均不是原文的连续子串，未创建任何卡片');
            }

            for (const content of validContents) {
                const assignedDate = this.assignDate(this.formatDate(new Date()));
                const card: Flashcard = {
                    id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    name: content.slice(0, 10) + (content.length > 10 ? '...' : ''),
                    content: content,
                    createTime: assignedDate,
                    nextReviewTime: assignedDate,
                    reviewCount: 0,
                };
                this.flashcards.push(card);
            }

            await this.saveAll();
            this.refreshViews();
            new Notice(`成功创建 ${validContents.length} 张闪卡`);
        } catch (err: any) {
            new Notice(`批量创建失败: ${err.message}`);
        }
    }

    assignDate(startDate: string): string {
        const limit = this.settings.dailyLimit;
        const cursor = new Date(startDate + 'T00:00:00');
        while (true) {
            const dateStr = this.formatDate(cursor);
            const count = this.flashcards.filter(card => card.createTime === dateStr).length;
            if (count < limit) {
                return dateStr;
            }
            cursor.setDate(cursor.getDate() + 1);
        }
    }

    async advanceExpiredCards() {
        const today = this.formatDate(new Date());
        let changed = false;
        this.flashcards.forEach(card => {
            while (card.nextReviewTime < today) {
                const interval = EBBINGHAUS_INTERVALS[Math.min(card.reviewCount, EBBINGHAUS_INTERVALS.length - 1)];
                const next = this.addDays(card.nextReviewTime, interval);
                card.nextReviewTime = next;
                card.reviewCount++;
                changed = true;
            }
        });
        if (changed) {
            await this.saveAll();
        }
    }

    advanceCard(card: Flashcard) {
        const today = this.formatDate(new Date());
        while (card.nextReviewTime < today) {
            const interval = EBBINGHAUS_INTERVALS[Math.min(card.reviewCount, EBBINGHAUS_INTERVALS.length - 1)];
            const next = this.addDays(card.nextReviewTime, interval);
            card.nextReviewTime = next;
            card.reviewCount++;
        }
    }

    async openView(viewType: string) {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(viewType)[0];
        if (!leaf) {
            leaf = workspace.getLeaf(true);
            await leaf.setViewState({ type: viewType, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    addDays(dateStr: string, days: number): string {
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + days);
        return this.formatDate(d);
    }

    formatDate(date: Date): string {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    getTotalElapsedDays(reviewCount: number): number {
        let total = 0;
        for (let i = 0; i < reviewCount; i++) {
            total += EBBINGHAUS_INTERVALS[Math.min(i, EBBINGHAUS_INTERVALS.length - 1)];
        }
        return total;
    }
}

// 编辑闪卡名称模态框
class EditNameModal extends Modal {
    plugin: VflacardPlugin;
    card: Flashcard;
    nameInput: TextComponent;
    onSave?: () => void;

    constructor(app: App, plugin: VflacardPlugin, card: Flashcard, onSave?: () => void) {
        super(app);
        this.plugin = plugin;
        this.card = card;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '编辑闪卡名称' });

        new Setting(contentEl)
            .setName('闪卡名称')
            .addText(text => {
                this.nameInput = text;
                text.setValue(this.card.name)
                    .setPlaceholder('输入闪卡名称')
                    .onChange(value => this.card.name = value);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('保存')
                .setCta()
                .onClick(async () => {
                    await this.plugin.saveAll();
                    if (this.onSave) this.onSave();
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('取消')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// 编辑闪卡内容模态框
class EditCardModal extends Modal {
    plugin: VflacardPlugin;
    card: Flashcard;
    contentArea: TextAreaComponent;
    onSave?: () => void;

    constructor(app: App, plugin: VflacardPlugin, card: Flashcard, onSave?: () => void) {
        super(app);
        this.plugin = plugin;
        this.card = card;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '编辑闪卡内容' });

        new Setting(contentEl)
            .setName('闪卡内容')
            .addTextArea(text => {
                this.contentArea = text;
                text.setValue(this.card.content)
                    .setPlaceholder('输入闪卡内容')
                    .onChange(value => this.card.content = value);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('保存')
                .setCta()
                .onClick(async () => {
                    await this.plugin.saveAll();
                    if (this.onSave) this.onSave();
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('取消')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// 闪卡管理器视图
class ManagerView extends ItemView {
    plugin: VflacardPlugin;
    container: HTMLElement;
    private sortedCards: Flashcard[] = [];
    private searchQuery: string = '';
    private needsSort: boolean = true; // 是否重新排序

    constructor(leaf: WorkspaceLeaf, plugin: VflacardPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return 'vflacard-manager'; }
    getDisplayText() { return '闪卡管理器'; }
    getIcon() { return 'layers'; }

    async onOpen() {
        this.container = this.contentEl;
        this.needsSort = true;
        this.render();
    }

    async onClose() {
        this.container.empty();
    }

    // 刷新按钮调用
    refresh() {
        this.needsSort = true;
        this.render();
    }

    // 重新排序（按创建时间降序：最新在前）
    sortCards() {
        this.sortedCards = this.plugin.flashcards.slice().sort((a, b) => {
            if (a.createTime === b.createTime) {
                return b.id.localeCompare(a.id); // 同日期按 id 降序（可改为其他）
            }
            return b.createTime.localeCompare(a.createTime);
        });
        this.needsSort = false;
    }

    render() {
        if (this.needsSort) {
            this.sortCards();
        }

        this.container.empty();
        this.container.addClass('vflacard-container');
        const manager = this.container.createDiv({ cls: 'vflacard-manager' });

        // 顶部工具栏（搜索框 + 刷新按钮）
        const toolbar = manager.createDiv({ cls: 'vflacard-toolbar' });

        // 搜索输入框
        const searchInput = toolbar.createEl('input', {
            type: 'text',
            cls: 'vflacard-search-input',
            placeholder: '搜索闪卡内容或名称...',
            attr: { 'aria-label': '搜索闪卡' }
        });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.render(); // 实时过滤，但不会重新排序
        });

        // 刷新按钮
        const refreshBtn = toolbar.createEl('button', {
            cls: 'vflacard-icon-btn vflacard-refresh-btn',
            attr: { 'aria-label': '重新排序并刷新' }
        });
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.onclick = () => {
            this.needsSort = true;
            this.render();
        };

        // 过滤后的卡片列表
        const filtered = this.sortedCards.filter(card => {
            const q = this.searchQuery.toLowerCase();
            return card.name.toLowerCase().includes(q) || card.content.toLowerCase().includes(q);
        });

        if (filtered.length === 0) {
            manager.createEl('p', { text: '暂无闪卡', cls: 'vflacard-review-empty' });
            return;
        }

        for (const card of filtered) {
            this.createCardItem(manager, card);
        }
    }

    createCardItem(parent: HTMLElement, card: Flashcard) {
        const item = parent.createDiv({ cls: 'vflacard-card-item' });
        const info = item.createDiv({ cls: 'vflacard-card-info' });
        const title = info.createDiv({ cls: 'vflacard-card-title' });
        title.setText(card.name);

        const meta = info.createDiv({ cls: 'vflacard-card-meta' });
        meta.createDiv({ text: `下次复习：${card.nextReviewTime}` });
        meta.createDiv({ text: `创建时间：${card.createTime}` });

        const actions = item.createDiv({ cls: 'vflacard-card-actions' });

        const editNameBtn = actions.createEl('button', { cls: 'vflacard-icon-btn', attr: { 'aria-label': '编辑名称' } });
        setIcon(editNameBtn, 'text');
        editNameBtn.onclick = () => {
            new EditNameModal(this.app, this.plugin, card, () => this.plugin.refreshViews()).open();
        };

        const editBtn = actions.createEl('button', { cls: 'vflacard-icon-btn', attr: { 'aria-label': '编辑内容' } });
        setIcon(editBtn, 'pencil');
        editBtn.onclick = () => {
            new EditCardModal(this.app, this.plugin, card, () => this.plugin.refreshViews()).open();
        };

        const deleteBtn = actions.createEl('button', { cls: 'vflacard-icon-btn vflacard-icon-btn-delete', attr: { 'aria-label': '删除' } });
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.onclick = async () => {
            this.plugin.flashcards = this.plugin.flashcards.filter(c => c.id !== card.id);
            await this.plugin.saveAll();
            this.plugin.refreshViews();
        };

        const prevBtn = actions.createEl('button', { cls: 'vflacard-icon-btn', attr: { 'aria-label': '创建时间向前推一天' } });
        setIcon(prevBtn, 'arrow-left');
        prevBtn.onclick = async () => {
            card.createTime = this.plugin.addDays(card.createTime, -1);
            card.nextReviewTime = this.plugin.addDays(card.createTime, this.plugin.getTotalElapsedDays(card.reviewCount));
            this.plugin.advanceCard(card);
            await this.plugin.saveAll();
            // 不调用 refreshViews()，保持当前顺序，仅重新渲染当前视图（不重新排序）
            this.render();
        };

        const nextBtn = actions.createEl('button', { cls: 'vflacard-icon-btn', attr: { 'aria-label': '创建时间向后推一天' } });
        setIcon(nextBtn, 'arrow-right');
        nextBtn.onclick = async () => {
            card.createTime = this.plugin.addDays(card.createTime, 1);
            card.nextReviewTime = this.plugin.addDays(card.createTime, this.plugin.getTotalElapsedDays(card.reviewCount));
            this.plugin.advanceCard(card);
            await this.plugin.saveAll();
            this.render();
        };
    }
}

// 今日复习视图
class ReviewView extends ItemView {
    plugin: VflacardPlugin;
    container: HTMLElement;
    currentIndex: number = 0;
    reviewList: Flashcard[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: VflacardPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return 'vflacard-review'; }
    getDisplayText() { return '今日复习闪卡'; }
    getIcon() { return 'refresh-cw'; }

    async onOpen() {
        this.container = this.contentEl;
        await this.plugin.advanceExpiredCards();
        this.render();
    }

    async onClose() {
        this.container.empty();
    }

    refresh() {
        this.render();
    }

    render() {
        this.container.empty();
        this.container.addClass('vflacard-container');
        const today = this.plugin.formatDate(new Date());

        this.reviewList = this.plugin.flashcards.filter(card => card.nextReviewTime === today);

        if (this.plugin.reviewProgress.date !== today) {
            this.plugin.reviewProgress = { currentIndex: 0, date: today };
        }

        // 顶部工具栏（刷新按钮）
        const toolbar = this.container.createDiv({ cls: 'vflacard-toolbar' });
        const refreshBtn = toolbar.createEl('button', {
            cls: 'vflacard-icon-btn vflacard-refresh-btn',
            attr: { 'aria-label': '刷新复习列表' }
        });
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.onclick = () => {
            this.render();
        };

        if (this.reviewList.length === 0) {
            this.container.createEl('p', { text: '今日无待复习卡片', cls: 'vflacard-review-empty' });
            return;
        }

        this.currentIndex = Math.min(this.plugin.reviewProgress.currentIndex, this.reviewList.length - 1);

        const reviewDiv = this.container.createDiv({ cls: 'vflacard-review' });

        const cardDiv = reviewDiv.createDiv({ cls: 'vflacard-review-card' });
        this.renderContent(cardDiv, this.reviewList[this.currentIndex].content);

        const nav = reviewDiv.createDiv({ cls: 'vflacard-review-nav' });
        const prevBtn = nav.createEl('button', { cls: 'vflacard-review-btn', attr: { 'aria-label': '上一张' } });
        setIcon(prevBtn, 'arrow-left');
        prevBtn.onclick = () => this.navigate(-1);

        const progress = nav.createDiv({ cls: 'vflacard-review-progress' });
        progress.setText(`${this.currentIndex + 1} / ${this.reviewList.length}`);

        const nextBtn = nav.createEl('button', { cls: 'vflacard-review-btn', attr: { 'aria-label': '下一张' } });
        setIcon(nextBtn, 'arrow-right');
        nextBtn.onclick = () => this.navigate(1);
    }

    async navigate(delta: number) {
        if (this.reviewList.length === 0) return;
        this.currentIndex = Math.max(0, Math.min(this.currentIndex + delta, this.reviewList.length - 1));
        this.plugin.reviewProgress.currentIndex = this.currentIndex;
        this.plugin.reviewProgress.date = this.plugin.formatDate(new Date());
        await this.plugin.saveAll();
        this.render();
    }

    async renderContent(container: HTMLElement, content: string) {
        container.empty();
        await MarkdownRenderer.render(this.app, content, container, '', this);
    }
}

// 设置选项卡
class VflacardSettingTab extends PluginSettingTab {
    plugin: VflacardPlugin;

    constructor(app: App, plugin: VflacardPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('每日新卡上限')
            .setDesc('设置每天最多可分配的闪卡数量，超出后顺延至后续日期。')
            .addText(text => text
                .setPlaceholder('10')
                .setValue(String(this.plugin.settings.dailyLimit))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.dailyLimit = num;
                        await this.plugin.saveAll();
                    }
                }));

        new Setting(containerEl)
            .setName('OpenAI 兼容 API 地址')
            .setDesc('填写 Base URL，例如 https://api.openai.com/v1')
            .addText(text => text
                .setPlaceholder('https://api.openai.com/v1')
                .setValue(this.plugin.settings.openaiBaseUrl)
                .onChange(async (value) => {
                    this.plugin.settings.openaiBaseUrl = value.trim();
                    await this.plugin.saveAll();
                }));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('填写您的 API 密钥')
            .addText(text => text
                .setPlaceholder('sk-...')
                .setValue(this.plugin.settings.openaiApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.openaiApiKey = value.trim();
                    await this.plugin.saveAll();
                }));

        new Setting(containerEl)
            .setName('模型')
            .setDesc('例如 gpt-4o-mini、gpt-4o、deepseek-chat 等')
            .addText(text => text
                .setPlaceholder('gpt-4o-mini')
                .setValue(this.plugin.settings.openaiModel)
                .onChange(async (value) => {
                    this.plugin.settings.openaiModel = value.trim();
                    await this.plugin.saveAll();
                }));
    }
}