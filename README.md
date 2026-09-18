# Vflacard - Comprehensive Flashcard Tool

Vflacard is an intelligent flashcard plugin based on Obsidian, designed for efficient learning and memory. It supports multiple text formats (Markdown, LaTeX, Callout, HTML, images, etc.) and uses the Ebbinghaus forgetting curve to automatically schedule reviews, so knowledge is reinforced at the optimal time.

## Features

- **Multi-format support**: Flashcard content can be plain text, Markdown, LaTeX formulas, Callout blocks, HTML tags, local images, or image-hosted images, and is rendered perfectly through Obsidian's native rendering engine.
- **Ebbinghaus forgetting curve**: Built-in classic interval sequence `[1, 2, 4, 7, 15, 30, 60]` days, automatically advanced according to the review schedule, with no manual operation required.
- **Flexible creation methods**:
  - Select text and create a single flashcard with one click.
  - Use an OpenAI-compatible API to intelligently split long text into multiple flashcards, and **strictly guarantee that card content is a contiguous substring of the original text**, without modifying any characters.
- **Flashcard manager**:
  - Sorted by creation time in descending order (newest at top), with search and refresh support.
  - Each card's name and content can be edited, deleted, or its creation time adjusted (moved forward or backward by one day).
  - Adjusting the time does not immediately reorder the list, preserving visual stability; the list is reordered after clicking the refresh button.
- **Today's review**:
  - Automatically filters cards with `nextReviewTime == today`, with previous/next page navigation.
  - Browsing position is remembered within the same day and automatically reset across days.
  - One-click refresh of the review list.
- **Mobile compatibility**: Responsive interface design, friendly to tap operations.
- **Local data storage**: All data is saved in `data.json` and synced with the Vault, with no manual backup required.

## Plugin Enhancements

The following are exclusive enhancements provided by Vflacard, designed to improve the convenience of learning and management:

- **Intelligent batch creation**: Through an OpenAI-compatible API, long text is automatically split into multiple logically independent flashcards. The system strictly verifies whether each card's content appears verbatim in the original text, ensuring zero tampering and retaining only valid fragments.
- **Flashcard manager search and refresh**: A built-in search box supports real-time filtering by name or content; the refresh button reloads and sorts the list, ensuring it stays in sync with the actual data.
- **Edit name and content**: Each flashcard's name and content can be edited independently, and all open views update immediately after modification.
- **Fine-tuning creation time**: Supports moving a card's creation time forward or backward by one day (keeping review progress unchanged); it does not immediately change the list order, making schedule adjustments convenient.
- **Review progress memory**: During today's review, the page position is retained for the day and automatically reset across days, with no manual recording required.
- **Global view synchronization**: After creating, deleting, or editing flashcards, all open flashcard managers and review views automatically refresh, with no need to manually close and reopen them.
- **Flexible API configuration**: Supports custom Base URL, API Key, and model name, and is compatible with any OpenAI-format service (such as DeepSeek, Tongyi Qianwen, etc.).

## Installation

### Manual Installation

1. Download the plugin archive (or directly obtain `main.js`, `manifest.json`, and `styles.css` from GitHub Releases).
2. Place the three files in the `.obsidian/plugins/vflacard/` directory of your Obsidian Vault (create it if it does not exist).
3. Restart Obsidian, then enable **Vflacard** in "Settings → Community plugins".

### Development Build

1. Clone the project repository.
2. Run `npm install` to install dependencies.
3. Run `npm run build` to generate `main.js` (production mode) or `npm run dev` to watch for file changes.
4. Copy `main.js`, `manifest.json`, and `styles.css` to the plugin directory.

## Usage

### Commands and Shortcuts

- **Make Display Flashcard**: Execute after selecting text to create a flashcard (first review date = assignment date).
- **Create Multiple Flashcards for Selection**: Execute after selecting text to call the API and split the text into multiple flashcards.
- **Open Flashcard Manager**: View and edit all flashcards.
- **Open Today's Review Flashcards**: View cards due for review today.

The above commands can have custom shortcuts set in "Settings → Hotkeys". The left sidebar (Ribbon) also provides two shortcut icons: Create Flashcard and Open Today's Review.

### Settings

- **Daily New Card Limit**: The maximum number of new flashcards allocated per day; excess cards are deferred to subsequent dates.
- **OpenAI-compatible API Base URL**: Base URL, for example `https://api.openai.com/v1`.
- **API Key**: Your API key.
- **Model**: For example `gpt-4o-mini`, `deepseek-chat`, etc.

## Design Philosophy and Clever Details

### 1. Automatic Advancement of the Ebbinghaus Forgetting Curve

We use an interval sequence **based on the last review date**, rather than a fixed offset. Each time a card becomes "due", even if you do not review it, the system automatically advances it to the next interval day in the background (for example: after the first due date it automatically becomes +1 day, the second time +2 days, and so on). This implements the convention of "advancing as usual even without operation", avoiding schedule confusion caused by subjective forgetting. This logic is executed both when the plugin starts and when the review view is opened, ensuring the data is always up to date.

### 2. Allocation Algorithm for the Daily New Card Limit

- **Core principle**: Starting from the creation day, find the first date that has not reached the limit and assign the new card to that date.
- **Dynamic adjustment after changing the limit**: If the limit is lowered, already allocated cards will not be "overflowed" and removed; new cards will look for a farther date with available slots. If the limit is raised, new cards will preferentially fill vacancies on the current day and subsequent dates.
- **Edge cases**: Even if a certain day has already exceeded the limit (for example, too many were allocated previously), no cards will be deleted, and new cards continue to be deferred, ensuring data integrity.

### 3. "Zero Modification" Guarantee for Intelligent Splitting

To meet the requirement of "absolutely no modification of even half a character", when batch-creating flashcards:

- The AI returns a JSON string array, and each element is treated as a candidate card.
- The program **strictly verifies** whether each candidate string **appears verbatim in** the original selected text (using `String.includes()` matching).
- Only fragments that pass verification are created as flashcards; invalid fragments are ignored and logged to the console.
- If all fragments are invalid, creation is refused and an error message is given. This ensures the content is never tampered with by the AI.

### 4. Visual Stability and Sorting in the Manager

- By default, cards are sorted by creation time in **descending order** (newest at top), but after modifying a card's creation time, **its position is not immediately moved**, to avoid disrupting the user's visual focus.
- Sorting is only re-executed when the refresh button is clicked or the manager is reopened. This design balances real-time feedback and operational smoothness.
- The search box supports real-time filtering but does not trigger re-sorting, ensuring the filtered results remain consistent with the current order.

### 5. Memory and Reset of Review Progress

- When the user opens "Today's Review" and turns pages, the current index and date are saved to `data.json`.
- If reopened on the same day, it directly restores to the last viewed card.
- If opened across days, the index is automatically reset to 0, and it starts from the first card due for review that day.
- All data is stored locally, does not rely on the cloud, and is private and secure.

### 6. Real-time View Refresh Mechanism

The plugin implements a `refreshViews()` method. After creating, deleting, or editing flashcards, it simultaneously refreshes all open manager and review views (by using `workspace.getLeavesOfType` to locate instances and calling their `render()` methods). This allows users to see the latest content without manually closing and reopening windows, improving the interactive experience.

## Data Storage Structure

Data is saved in `data.json` (automatically managed by Obsidian):

```json
{
  "flashcards": [
    {
      "id": "card_...",
      "name": "Flashcard name",
      "content": "Flashcard content (Markdown)",
      "createTime": "2026-08-27",
      "nextReviewTime": "2026-08-27",
      "reviewCount": 0
    }
  ],
  "reviewProgress": {
    "currentIndex": 0,
    "date": "2026-08-27"
  },
  "settings": {
    "dailyLimit": 10,
    "openaiBaseUrl": "https://api.openai.com/v1",
    "openaiApiKey": "",
    "openaiModel": "gpt-4o-mini"
  }
}
```

- `reviewCount` indicates the number of times interval advancement has occurred, used to calculate the next interval.
- On first creation, `nextReviewTime` equals `createTime` (the same day is the review day); afterward it is updated by the automatic advancement logic.

## Development and Build

The project is built with TypeScript and esbuild, following Obsidian plugin development conventions. The code structure is clear and includes `main.ts` (core logic), `styles.css` (styles), `manifest.json` (metadata), and other files. Run `npm run build` to generate `main.js`.

## FAQ

**Q: Why does batch flashcard creation sometimes return no cards?**  
A: The AI may have returned strings that are not from the original text, causing verification to fail. Please check the JSON format returned by the API, or confirm that the text is clear enough to be split.

**Q: After changing the limit, how are new cards allocated?**  
A: New cards start from the current date and search in order for the first date that has not reached the new limit, then are allocated there. Already allocated cards do not move.

**Q: Why does review progress reset the next day?**  
A: The set of cards due for review differs each day. Progress records are bound to a specific date, so automatically resetting across days is reasonable behavior.

**Q: How is mobile support?**  
A: The plugin is fully compatible with mobile. The interface adapts to small screens through media queries, and all operations can be completed with finger taps.

## Changelog

- **v1.0.0**: Initial version, supporting single-card creation, manager, today's review, setting limits, batch creation (AI splitting), search, and refresh functions.

---

Vflacard aims to make the learning process more focused and efficient. If you have any questions or suggestions, feedback is welcome.
